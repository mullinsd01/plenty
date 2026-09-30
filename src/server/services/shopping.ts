import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { addDaysToInstant, toDateString } from "@/lib/dates";
import { AISLE_ORDER, type Aisle, type ShoppingSource } from "@/lib/domain";
import { computeShoppingRhythm, shoppingHorizonDays, type ShoppingRhythm } from "@/lib/insights";
import { computePlanRequirements } from "@/lib/meals/requirements";
import type { ExistingListItem, PlanMealInput, PredictionInput, ShoppingNeed, StapleInput } from "@/lib/meals/types";
import { normalizeText, singularizePhrase } from "@/lib/normalize";
import { computeShoppingNeeds } from "@/lib/shopping/needs";
import { reconcileShoppingList } from "@/lib/shopping/reconcile";
import { shoppingItemKey } from "@/lib/shopping/keys";
import { formatQuantity, isUnit, type Unit } from "@/lib/units";
import type { HouseholdContext, HouseholdInfo } from "@/server/auth/context";
import { withUser, type Queryable, type Tx } from "@/server/db/client";
import {
  consumptionStats,
  preferences,
  receipts,
  shoppingListItemSources,
  shoppingListItems,
  shoppingLists,
  type DbShoppingListItem,
} from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { addItemsTx } from "./inventory";
import { computeLiveState, productBase, refreshLearning, type LiveState } from "./learning";
import { loadPlannableMeals, lotsFromLive, upcomingPlanItems } from "./meal-data";
import { loadProductIndex, resolveProduct } from "./products";

const SYNC_STALE_MS = 10 * 60_000;
const DISMISS_FALLBACK_DAYS = 4;

export async function getOrCreateActiveList(db: Queryable, householdId: string) {
  const [existing] = await db
    .select()
    .from(shoppingLists)
    .where(and(eq(shoppingLists.householdId, householdId), eq(shoppingLists.status, "active")))
    .limit(1);
  if (existing) return existing;
  const [created] = await db.insert(shoppingLists).values({ householdId }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await db
    .select()
    .from(shoppingLists)
    .where(and(eq(shoppingLists.householdId, householdId), eq(shoppingLists.status, "active")))
    .limit(1);
  return again;
}

/** When the household shops, from preferences and confirmed receipt dates. */
export async function loadShoppingRhythm(
  db: Queryable,
  household: Pick<HouseholdInfo, "id" | "timezone">,
  now: Date,
): Promise<ShoppingRhythm> {
  const [prefs] = await db
    .select({ usualShopDay: preferences.usualShopDay, shopIntervalDays: preferences.shopIntervalDays })
    .from(preferences)
    .where(eq(preferences.householdId, household.id))
    .limit(1);
  const rows = await db
    .select({ purchasedAt: receipts.purchasedAt })
    .from(receipts)
    .where(and(eq(receipts.householdId, household.id), eq(receipts.status, "confirmed"), isNotNull(receipts.purchasedAt)))
    .orderBy(desc(receipts.purchasedAt))
    .limit(40);
  const today = toDateString(now, household.timezone);
  return computeShoppingRhythm({
    purchaseDates: rows.map((r) => toDateString(r.purchasedAt!, household.timezone)),
    today,
    usualShopDay: prefs?.usualShopDay ?? null,
    shopIntervalDays: prefs?.shopIntervalDays ?? null,
  });
}

function nameKey(name: string): string {
  return shoppingItemKey({ productId: null, name });
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

/**
 * Recompute everything Plenty thinks should be on the list — predicted
 * run-outs, meal-plan shortfalls, staples — net of what's already in the
 * kitchen, and merge it into the list without touching what the user did.
 */
export async function syncShoppingList(
  tx: Tx,
  household: Pick<HouseholdInfo, "id" | "adults" | "children" | "timezone">,
  now: Date,
  liveState?: LiveState,
): Promise<void> {
  const live = liveState ?? (await computeLiveState(tx, household, now));
  const list = await getOrCreateActiveList(tx, household.id);
  const today = toDateString(now, household.timezone);
  const products = live.index.byId;

  const predictionInputs: PredictionInput[] = [];
  for (const p of live.predictions.values()) {
    if (p.paused) continue;
    predictionInputs.push({
      productId: p.productId,
      itemKey: shoppingItemKey({ productId: p.productId, name: p.product.name }),
      name: p.product.name,
      aisle: p.product.aisle,
      daysRemaining: p.prediction.daysRemaining,
      daysLow: p.prediction.daysLow,
      daysHigh: p.prediction.daysHigh,
      confidence: p.prediction.confidence,
      basis: p.prediction.basis,
      dailyRate: p.prediction.dailyRate,
      baseUnit: p.stats.baseUnit,
    });
  }

  // Meal plan shortfalls, computed against the kitchen with cross-meal allocation.
  const planRows = await upcomingPlanItems(tx, household.id, today);
  const meals = await loadPlannableMeals(tx, household.id, Array.from(new Set(planRows.map((r) => r.mealId))));
  const planInputs: PlanMealInput[] = planRows
    .filter((r) => meals.has(r.mealId))
    .map((r) => ({ planItemId: r.id, date: r.date, servings: r.servings, meal: meals.get(r.mealId)! }));
  const requirements = computePlanRequirements({ items: planInputs, lots: lotsFromLive(live), products });

  // Staples: learned (or user-forced) regular buys.
  const stapleRows = [...live.statsRows.values()].filter((s) => (s.stapleOverride ?? s.isStaple) && !s.predictionsPaused);
  const stocked = new Set(
    live.activeItems.filter((i) => i.productId && (live.itemFractions.get(i.id) ?? 0) > 0.05).map((i) => i.productId!),
  );
  const staples: StapleInput[] = stapleRows
    .filter((s) => products.has(s.productId))
    .map((s) => {
      const product = products.get(s.productId)!;
      return {
        productId: s.productId,
        name: product.name,
        aisle: product.aisle,
        typicalPurchaseAmount: s.typicalPurchaseAmount,
        baseUnit: productBase(product),
        lastPurchasedAt: s.lastPurchasedAt,
        typicalIntervalDays: s.typicalPurchaseIntervalDays,
        hasActiveStock: stocked.has(s.productId),
      };
    });

  const waste = new Map(
    [...live.statsRows.values()].map((s) => [s.productId, { wasteRatio: s.wasteRatio, wasteEvents: s.wasteEvents }]),
  );
  const rhythm = await loadShoppingRhythm(tx, household, now);
  const needs = computeShoppingNeeds({
    predictions: predictionInputs,
    planMissing: requirements.missing,
    staples,
    products,
    waste,
    horizonDays: shoppingHorizonDays(rhythm, today),
    now,
  });

  const existingRows = await tx.select().from(shoppingListItems).where(eq(shoppingListItems.listId, list.id));
  const existing: ExistingListItem[] = existingRows.map((r) => ({
    id: r.id,
    itemKey: r.itemKey,
    productId: r.productId,
    name: r.name,
    aisle: r.aisle as Aisle,
    quantity: r.quantity,
    unit: (r.unit as Unit | null) ?? null,
    suggestedQuantity: r.suggestedQuantity,
    suggestedUnit: (r.suggestedUnit as Unit | null) ?? null,
    source: r.source as ShoppingSource,
    userEdited: r.userEdited,
    checkedAt: r.checkedAt,
    dismissedUntil: r.dismissedUntil,
    purchasedAt: r.purchasedAt,
  }));
  const result = reconcileShoppingList(existing, needs, now);

  if (result.remove.length > 0) {
    await tx.delete(shoppingListItems).where(inArray(shoppingListItems.id, result.remove));
  }
  for (const update of result.update) {
    await tx
      .update(shoppingListItems)
      .set({
        suggestedQuantity: update.suggestedQuantity,
        suggestedUnit: update.suggestedUnit,
        source: update.source,
        reason: update.reason,
        advice: update.advice,
      })
      .where(eq(shoppingListItems.id, update.id));
    await writeSources(tx, household.id, update.id, update.sources);
  }
  const maxPos = existingRows.reduce((m, r) => Math.max(m, r.position), 0);
  let position = maxPos;
  for (const need of result.create) {
    position += 1;
    const [row] = await tx
      .insert(shoppingListItems)
      .values({
        listId: list.id,
        householdId: household.id,
        productId: need.productId,
        itemKey: need.itemKey,
        name: need.name,
        aisle: need.aisle,
        suggestedQuantity: need.quantity,
        suggestedUnit: need.unit,
        source: need.primarySource,
        reason: need.reason,
        advice: need.advice ?? null,
        position,
      })
      .onConflictDoNothing()
      .returning({ id: shoppingListItems.id });
    if (row) await writeSources(tx, household.id, row.id, need.sources);
  }
  await tx.update(shoppingLists).set({ lastSyncedAt: now }).where(eq(shoppingLists.id, list.id));
}

async function writeSources(tx: Tx, householdId: string, itemId: string, sources: ShoppingNeed["sources"]): Promise<void> {
  await tx.delete(shoppingListItemSources).where(eq(shoppingListItemSources.itemId, itemId));
  if (sources.length === 0) return;
  await tx.insert(shoppingListItemSources).values(
    sources.map((s) => ({
      itemId,
      householdId,
      source: s.source,
      mealPlanItemId: s.mealPlanItemId ?? null,
      quantity: s.quantity,
      unit: s.unit,
      note: s.note,
    })),
  );
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface ShoppingItemView {
  id: string;
  name: string;
  aisle: Aisle;
  productId: string | null;
  quantity: number | null;
  unit: Unit | null;
  quantityLabel: string;
  source: ShoppingSource;
  reason: string | null;
  advice: string | null;
  checked: boolean;
  position: number;
  sources: Array<{ source: ShoppingSource; note: string | null }>;
}

export interface ShoppingListView {
  listId: string;
  items: ShoppingItemView[];
  rhythm: ShoppingRhythm;
  lastSyncedAt: string | null;
}

function toView(row: DbShoppingListItem, sources: Array<typeof shoppingListItemSources.$inferSelect>): ShoppingItemView {
  const quantity = row.quantity ?? row.suggestedQuantity;
  const unit = (row.quantity !== null ? row.unit : row.suggestedUnit) as Unit | null;
  return {
    id: row.id,
    name: row.name,
    aisle: row.aisle as Aisle,
    productId: row.productId,
    quantity,
    unit,
    quantityLabel: quantity ? (unit === null || unit === "each" ? `×${formatQuantity(quantity, "each")}` : formatQuantity(quantity, unit)) : "",
    source: row.source as ShoppingSource,
    reason: row.reason,
    advice: row.advice,
    checked: row.checkedAt !== null,
    position: row.position,
    sources: sources.map((s) => ({ source: s.source as ShoppingSource, note: s.note })),
  };
}

/** The current list, re-synced first when it's gone stale. */
export async function getShoppingList(ctx: HouseholdContext, now = new Date()): Promise<ShoppingListView> {
  return withUser(ctx.user.id, async (tx) => {
    let list = await getOrCreateActiveList(tx, ctx.household.id);
    if (!list.lastSyncedAt || now.getTime() - list.lastSyncedAt.getTime() > SYNC_STALE_MS) {
      await syncShoppingList(tx, ctx.household, now);
      list = await getOrCreateActiveList(tx, ctx.household.id);
    }
    const rows = await tx
      .select()
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.listId, list.id), isNull(shoppingListItems.purchasedAt)))
      .orderBy(asc(shoppingListItems.position), asc(shoppingListItems.createdAt));
    const visible = rows.filter((r) => !r.dismissedUntil || r.dismissedUntil <= now);
    const sourceRows = visible.length
      ? await tx.select().from(shoppingListItemSources).where(inArray(shoppingListItemSources.itemId, visible.map((r) => r.id)))
      : [];
    const items = visible.map((r) => toView(r, sourceRows.filter((s) => s.itemId === r.id)));
    items.sort(
      (a, b) =>
        Number(a.checked) - Number(b.checked) ||
        AISLE_ORDER.indexOf(a.aisle) - AISLE_ORDER.indexOf(b.aisle) ||
        a.position - b.position,
    );
    return {
      listId: list.id,
      items,
      rhythm: await loadShoppingRhythm(tx, ctx.household, now),
      lastSyncedAt: list.lastSyncedAt?.toISOString() ?? null,
    };
  });
}

// ─── Editing ────────────────────────────────────────────────────────────────

async function loadListItem(tx: Tx, householdId: string, id: string): Promise<DbShoppingListItem> {
  const [row] = await tx
    .select()
    .from(shoppingListItems)
    .where(and(eq(shoppingListItems.id, id), eq(shoppingListItems.householdId, householdId)))
    .limit(1);
  if (!row) throw notFound("That list item");
  return row;
}

/** Add something the household wants. Merges with an existing entry for the same product. */
export async function addManualItem(
  ctx: HouseholdContext,
  input: { name: string; quantity?: number | null; unit?: Unit | null },
): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new AppError("validation", "What do you need?");
  return withUser(ctx.user.id, async (tx) => {
    const list = await getOrCreateActiveList(tx, ctx.household.id);
    const index = await loadProductIndex(tx, ctx.household.id);
    const resolved = resolveProduct(index, name, 0.8);
    const productId = resolved?.product.id ?? null;
    const itemKey = productId ? shoppingItemKey({ productId, name }) : nameKey(name);
    const quantity = input.quantity && input.quantity > 0 ? input.quantity : null;
    // "2 milk" means two of the usual thing, so a bare count is stored as items, not litres.
    const unit = quantity ? (input.unit && isUnit(input.unit) ? input.unit : "each") : null;

    const [existing] = await tx
      .select()
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.listId, list.id), eq(shoppingListItems.itemKey, itemKey)))
      .limit(1);
    if (existing) {
      await tx
        .update(shoppingListItems)
        .set({
          source: "manual",
          userEdited: quantity ? true : existing.userEdited,
          quantity: quantity ?? existing.quantity,
          unit: quantity ? unit : existing.unit,
          checkedAt: null,
          checkedBy: null,
          purchasedAt: null,
          dismissedUntil: null,
        })
        .where(eq(shoppingListItems.id, existing.id));
      return existing.id;
    }
    const [maxRow] = await tx
      .select({ max: sql<number>`coalesce(max(${shoppingListItems.position}), 0)` })
      .from(shoppingListItems)
      .where(eq(shoppingListItems.listId, list.id));
    const [row] = await tx
      .insert(shoppingListItems)
      .values({
        listId: list.id,
        householdId: ctx.household.id,
        productId,
        itemKey,
        name: resolved && resolved.score >= 0.9 ? resolved.product.name : name.charAt(0).toUpperCase() + name.slice(1),
        aisle: resolved?.product.aisle ?? "other",
        quantity,
        unit,
        source: "manual",
        userEdited: quantity !== null,
        position: Number(maxRow?.max ?? 0) + 1,
        addedBy: ctx.user.id,
      })
      .returning({ id: shoppingListItems.id });
    return row.id;
  });
}

export async function updateShoppingItem(
  ctx: HouseholdContext,
  id: string,
  patch: { name?: string; quantity?: number | null; unit?: Unit | null; aisle?: Aisle },
): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    const row = await loadListItem(tx, ctx.household.id, id);
    const changes: Partial<typeof shoppingListItems.$inferInsert> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new AppError("validation", "Give it a name.");
      changes.name = name.slice(0, 120);
    }
    if (patch.quantity !== undefined) {
      if (patch.quantity !== null && !(patch.quantity > 0)) throw new AppError("validation", "Quantity must be more than zero.");
      changes.quantity = patch.quantity;
      changes.unit = patch.quantity === null ? null : patch.unit ?? row.unit ?? row.suggestedUnit ?? "each";
      changes.userEdited = true;
    }
    if (patch.aisle !== undefined) changes.aisle = patch.aisle;
    if (Object.keys(changes).length > 0) await tx.update(shoppingListItems).set(changes).where(eq(shoppingListItems.id, id));
  });
}

export async function setChecked(ctx: HouseholdContext, id: string, checked: boolean): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    await loadListItem(tx, ctx.household.id, id);
    await tx
      .update(shoppingListItems)
      .set(checked ? { checkedAt: new Date(), checkedBy: ctx.user.id } : { checkedAt: null, checkedBy: null })
      .where(eq(shoppingListItems.id, id));
  });
}

/**
 * Remove an item. Things the user added are deleted; things Plenty added are
 * dismissed until after the next shop so they don't bounce straight back.
 */
export async function removeShoppingItem(ctx: HouseholdContext, id: string): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const row = await loadListItem(tx, ctx.household.id, id);
    if (row.source === "manual") {
      await tx.delete(shoppingListItems).where(eq(shoppingListItems.id, id));
      return;
    }
    const rhythm = await loadShoppingRhythm(tx, ctx.household, now);
    const until = rhythm.nextShopDate
      ? new Date(`${rhythm.nextShopDate}T23:59:59Z`)
      : addDaysToInstant(now, DISMISS_FALLBACK_DAYS);
    await tx
      .update(shoppingListItems)
      .set({ dismissedUntil: until > now ? until : addDaysToInstant(now, DISMISS_FALLBACK_DAYS), checkedAt: null })
      .where(eq(shoppingListItems.id, id));
  });
}

/** Persist a new order for items (within an aisle group). */
export async function reorderShoppingItems(ctx: HouseholdContext, orderedIds: string[]): Promise<void> {
  if (orderedIds.length > 500) throw new AppError("validation", "Too many items.");
  await withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({ id: shoppingListItems.id, position: shoppingListItems.position })
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.householdId, ctx.household.id), inArray(shoppingListItems.id, orderedIds)));
    const positions = rows.map((r) => r.position).sort((a, b) => a - b);
    for (let i = 0; i < orderedIds.length; i++) {
      if (!rows.some((r) => r.id === orderedIds[i])) continue;
      await tx
        .update(shoppingListItems)
        .set({ position: positions[i] ?? i })
        .where(eq(shoppingListItems.id, orderedIds[i]));
    }
  });
}

/**
 * Finish a shop. Checked items leave the list; optionally they're added to
 * the kitchen straight away (for people who won't scan the receipt).
 */
export async function completeShop(ctx: HouseholdContext, addToKitchen: boolean): Promise<{ moved: number }> {
  const now = new Date();
  return withUser(ctx.user.id, async (tx) => {
    const list = await getOrCreateActiveList(tx, ctx.household.id);
    const checked = await tx
      .select()
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.listId, list.id), isNotNull(shoppingListItems.checkedAt), isNull(shoppingListItems.purchasedAt)));
    if (checked.length === 0) return { moved: 0 };
    if (addToKitchen) {
      const created = await addItemsTx(
        tx,
        ctx.household,
        ctx.user.id,
        checked.map((c) => ({
          name: c.name,
          productId: c.productId,
          quantity: c.quantity ?? c.suggestedQuantity,
          unit: ((c.quantity !== null ? c.unit : c.suggestedUnit) as Unit | null) ?? null,
          confidence: "medium" as const,
        })),
        "shopping_list",
        now,
      );
      await refreshLearning(tx, ctx.household, created.map((c) => c.productId), now);
    }
    await tx.delete(shoppingListItems).where(inArray(shoppingListItems.id, checked.map((c) => c.id)));
    await syncShoppingList(tx, ctx.household, now);
    return { moved: checked.length };
  });
}

export async function clearChecked(ctx: HouseholdContext): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    const list = await getOrCreateActiveList(tx, ctx.household.id);
    await tx
      .delete(shoppingListItems)
      .where(and(eq(shoppingListItems.listId, list.id), isNotNull(shoppingListItems.checkedAt)));
  });
}

/**
 * After a receipt is confirmed: tick off matching list items as bought.
 * Matches on product, or on the normalised name for free-text items.
 */
export async function markPurchasedFromReceipt(
  tx: Tx,
  householdId: string,
  bought: Array<{ productId: string | null; name: string }>,
): Promise<number> {
  const list = await getOrCreateActiveList(tx, householdId);
  const keys = new Set<string>();
  for (const b of bought) {
    if (b.productId) keys.add(shoppingItemKey({ productId: b.productId, name: b.name }));
    keys.add(nameKey(b.name));
  }
  const open = await tx
    .select()
    .from(shoppingListItems)
    .where(and(eq(shoppingListItems.listId, list.id), isNull(shoppingListItems.purchasedAt)));
  const productIds = new Set(bought.map((b) => b.productId).filter(Boolean) as string[]);
  const names = new Set(bought.map((b) => singularizePhrase(normalizeText(b.name))));
  const matched = open.filter(
    (row) =>
      keys.has(row.itemKey) ||
      (row.productId && productIds.has(row.productId)) ||
      names.has(singularizePhrase(normalizeText(row.name))),
  );
  if (matched.length > 0) {
    await tx.delete(shoppingListItems).where(inArray(shoppingListItems.id, matched.map((m) => m.id)));
  }
  return matched.length;
}

/** Toggle whether a product is treated as a household staple (null = let Plenty decide). */
export async function setStapleOverride(ctx: HouseholdContext, productId: string, value: boolean | null): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const updated = await tx
      .update(consumptionStats)
      .set({ stapleOverride: value })
      .where(and(eq(consumptionStats.householdId, ctx.household.id), eq(consumptionStats.productId, productId)))
      .returning({ id: consumptionStats.id });
    if (updated.length === 0 && value !== null) {
      const index = await loadProductIndex(tx, ctx.household.id);
      const product = index.byId.get(productId);
      if (!product) throw notFound("That product");
      await tx.insert(consumptionStats).values({
        householdId: ctx.household.id,
        productId,
        baseUnit: productBase(product),
        stapleOverride: value,
      });
    }
    await syncShoppingList(tx, ctx.household, now);
  });
}

