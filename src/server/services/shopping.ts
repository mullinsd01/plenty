import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, max, sql } from "drizzle-orm";
import { addDays, addDaysToInstant, toDateString, zonedDateTimeToInstant } from "@/lib/dates";
import { AISLE_ORDER, CHECK_CUPBOARD_ADVICE, type Aisle, type ShoppingSource } from "@/lib/domain";
import { computeShoppingRhythm, shoppingHorizonDays, type ShoppingRhythm } from "@/lib/insights";
import { computePlanRequirements } from "@/lib/meals/requirements";
import type { ExistingListItem, PlanMealInput, PredictionInput, ShoppingNeed, StapleInput } from "@/lib/meals/types";
import { normalizeText, singularizePhrase } from "@/lib/normalize";
import { computeShoppingNeeds } from "@/lib/shopping/needs";
import { reconcileShoppingList } from "@/lib/shopping/reconcile";
import { normalizeItemName, shoppingItemKey } from "@/lib/shopping/keys";
import { convert, formatQuantity, isUnit, type Unit } from "@/lib/units";
import type { HouseholdContext, HouseholdInfo } from "@/server/auth/context";
import { withUser, type Queryable, type Tx } from "@/server/db/client";
import {
  consumptionStats,
  households,
  inventoryItems,
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

/** Keeps at least this long unopened → a cupboard item the household may already have. */
const CUPBOARD_SHELF_LIFE_DAYS = 120;

const SYNC_STALE_MS = 10 * 60_000;
const DISMISS_FALLBACK_DAYS = 4;
/**
 * Bought at "Finish shop" but not yet in the kitchen (the receipt is still to
 * be scanned): hold the line this long so Plenty doesn't put it straight back.
 */
const PURCHASED_HOLD_DAYS = 3;

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
  const requirements = computePlanRequirements({ items: planInputs, lots: lotsFromLive(live, today), products });

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

  // Plenty only knows about the cupboard from receipts. A long-life pantry item it has
  // never seen the household buy may well be at home already, so say so rather than
  // presenting it as a definite need.
  const seenProducts = new Set([...live.statsRows.keys(), ...live.activeItems.map((i) => i.productId).filter(Boolean)] as string[]);
  for (const need of needs) {
    const product = need.productId ? products.get(need.productId) : undefined;
    const onlyForMeals = need.sources.every((src) => src.source === "meal_plan");
    const longLife = product && !product.perishable && (product.shelfLifeDays == null || product.shelfLifeDays >= CUPBOARD_SHELF_LIFE_DAYS);
    if (onlyForMeals && longLife && !seenProducts.has(product.id) && !need.advice) {
      need.advice = CHECK_CUPBOARD_ADVICE;
    }
  }

  // Bought at "Finish shop" long enough ago that the receipt isn't coming: let Plenty reconsider them.
  await tx
    .delete(shoppingListItems)
    .where(
      and(
        eq(shoppingListItems.listId, list.id),
        isNotNull(shoppingListItems.purchasedAt),
        lt(shoppingListItems.purchasedAt, addDaysToInstant(now, -PURCHASED_HOLD_DAYS)),
      ),
    );
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

/** The amount to show: what the person asked for, else Plenty's suggestion — unless they cleared it ("Any"). */
function effectiveAmount(row: DbShoppingListItem): { quantity: number | null; unit: Unit | null } {
  if (row.quantity !== null) return { quantity: row.quantity, unit: row.unit as Unit | null };
  if (row.userEdited) return { quantity: null, unit: null };
  return { quantity: row.suggestedQuantity, unit: row.suggestedUnit as Unit | null };
}

function toView(row: DbShoppingListItem, sources: Array<typeof shoppingListItemSources.$inferSelect>): ShoppingItemView {
  const { quantity, unit } = effectiveAmount(row);
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

/** Whether anything in the kitchen changed (finished, used, added, cleared out) after `since`. */
async function kitchenChangedSince(tx: Tx, householdId: string, since: Date): Promise<boolean> {
  const [row] = await tx
    .select({ at: max(inventoryItems.updatedAt) })
    .from(inventoryItems)
    .where(eq(inventoryItems.householdId, householdId));
  return Boolean(row?.at && row.at.getTime() > since.getTime());
}

/** The current list, re-synced first when it's gone stale or the kitchen has changed since. */
export async function getShoppingList(ctx: HouseholdContext, now = new Date()): Promise<ShoppingListView> {
  return withUser(ctx.user.id, async (tx) => {
    let list = await getOrCreateActiveList(tx, ctx.household.id);
    if (
      !list.lastSyncedAt ||
      now.getTime() - list.lastSyncedAt.getTime() > SYNC_STALE_MS ||
      (await kitchenChangedSince(tx, ctx.household.id, list.lastSyncedAt))
    ) {
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

    const [maxRow] = await tx
      .select({ max: sql<number>`coalesce(max(${shoppingListItems.position}), 0)` })
      .from(shoppingListItems)
      .where(eq(shoppingListItems.listId, list.id));
    // Insert, or fall through to merging when the line already exists — including one a
    // housemate (or a list update) is adding at this very moment.
    const [created] = await tx
      .insert(shoppingListItems)
      .values({
        listId: list.id,
        householdId: ctx.household.id,
        productId,
        itemKey,
        // Keep the household's own words: "Milk" means any milk, not specifically full cream.
        name: name.charAt(0).toUpperCase() + name.slice(1),
        aisle: resolved?.product.aisle ?? "other",
        quantity,
        unit,
        source: "manual",
        userEdited: quantity !== null,
        position: Number(maxRow?.max ?? 0) + 1,
        addedBy: ctx.user.id,
      })
      .onConflictDoNothing({ target: [shoppingListItems.listId, shoppingListItems.itemKey] })
      .returning({ id: shoppingListItems.id });
    if (created) return created.id;

    // Lock the line so two people adding to it at once both count.
    const [existing] = await tx
      .select()
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.listId, list.id), eq(shoppingListItems.itemKey, itemKey)))
      .limit(1)
      .for("update");
    if (!existing) throw new AppError("conflict", "The list changed while you were adding that. Please try again.");
    // Two people each adding "lemons" means both amounts are needed: add them up rather
    // than quietly replacing what someone else asked for.
    const stillWanted = existing.source === "manual" && !existing.checkedAt && !existing.purchasedAt;
    let combined = quantity ?? existing.quantity;
    let combinedUnit = quantity ? unit : existing.unit;
    if (quantity && unit && stillWanted && existing.quantity && existing.unit) {
      const inExistingUnit = convert(quantity, unit, existing.unit as Unit, resolved?.product ?? null);
      // Amounts that can't be added up ("2 L" and "1 bottle") keep what was asked for first.
      combined = inExistingUnit !== null ? existing.quantity + inExistingUnit : existing.quantity;
      combinedUnit = existing.unit;
    }
    await tx
      .update(shoppingListItems)
      .set({
        source: "manual",
        userEdited: quantity ? true : existing.userEdited,
        quantity: combined,
        unit: combinedUnit,
        checkedAt: null,
        checkedBy: null,
        purchasedAt: null,
        dismissedUntil: null,
      })
      .where(eq(shoppingListItems.id, existing.id));
    return existing.id;
  });
}

export async function updateShoppingItem(
  ctx: HouseholdContext,
  id: string,
  patch: { name?: string; quantity?: number | null; unit?: Unit | null; aisle?: Aisle },
): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const row = await loadListItem(tx, ctx.household.id, id);
    const changes: Partial<typeof shoppingListItems.$inferInsert> = {};
    let rekeyed = false;
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 120);
      if (!name) throw new AppError("validation", "Give it a name.");
      changes.name = name;
      // Renaming something the household added makes it a different thing ("Lemons" → "Limes"):
      // re-key it so later adds, Plenty's own needs and receipts match the new name, not the old.
      if (row.source === "manual" && normalizeItemName(name) !== normalizeItemName(row.name)) {
        const index = await loadProductIndex(tx, ctx.household.id);
        const resolved = resolveProduct(index, name, 0.8);
        const productId = resolved?.product.id ?? null;
        const itemKey = productId ? shoppingItemKey({ productId, name }) : nameKey(name);
        if (itemKey !== row.itemKey) {
          const [clash] = await tx
            .select()
            .from(shoppingListItems)
            .where(and(eq(shoppingListItems.listId, row.listId), eq(shoppingListItems.itemKey, itemKey)))
            .limit(1);
          if (clash) {
            const hidden = clash.purchasedAt !== null || (clash.dismissedUntil !== null && clash.dismissedUntil > now);
            if (!hidden) throw new AppError("conflict", `${clash.name} is already on your list.`);
            // A dismissed or already-bought line nobody can see gives way to what the person just asked for.
            await tx.delete(shoppingListItems).where(eq(shoppingListItems.id, clash.id));
          }
          Object.assign(changes, { itemKey, productId, reason: null, advice: null, suggestedQuantity: null, suggestedUnit: null });
          if (patch.aisle === undefined && resolved) changes.aisle = resolved.product.aisle;
          rekeyed = true;
        }
      }
    }
    if (patch.quantity !== undefined) {
      if (patch.quantity !== null && !(patch.quantity > 0)) throw new AppError("validation", "Quantity must be more than zero.");
      const unit = patch.quantity === null ? null : patch.unit ?? row.unit ?? row.suggestedUnit ?? "each";
      const current = effectiveAmount(row);
      // Saving the form without touching the amount isn't an edit: only a real change fixes
      // the amount (and stops Plenty adjusting or removing the item).
      const unchanged = patch.quantity === current.quantity && (patch.quantity === null || unit === (current.unit ?? "each"));
      if (!unchanged || rekeyed) {
        changes.quantity = patch.quantity;
        changes.unit = unit;
        changes.userEdited = true;
      }
    }
    if (patch.aisle !== undefined) changes.aisle = patch.aisle;
    if (Object.keys(changes).length > 0) await tx.update(shoppingListItems).set(changes).where(eq(shoppingListItems.id, id));
    // The old name's reasons don't apply to the new thing.
    if (rekeyed) await tx.delete(shoppingListItemSources).where(eq(shoppingListItemSources.itemId, id));
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
    let dismissAs: ShoppingSource = row.source as ShoppingSource;
    if (row.source === "manual") {
      const [plenty] = await tx
        .select({ source: shoppingListItemSources.source })
        .from(shoppingListItemSources)
        .where(eq(shoppingListItemSources.itemId, id))
        .limit(1);
      if (!plenty) {
        await tx.delete(shoppingListItems).where(eq(shoppingListItems.id, id));
        return;
      }
      // Plenty wants this too (running low, a meal, a staple): deleting it would only let the
      // next update add it straight back, so hand it back to Plenty, dismissed like its own.
      dismissAs = plenty.source as ShoppingSource;
    }
    const until = await dismissUntil(tx, ctx.household, now);
    await tx
      .update(shoppingListItems)
      .set({
        dismissedUntil: until,
        checkedAt: null,
        checkedBy: null,
        ...(row.source === "manual" ? { source: dismissAs, quantity: null, unit: null, userEdited: false } : {}),
      })
      .where(eq(shoppingListItems.id, id));
  });
}

/** Dismissed until the end of the next shop day, in the household's own time zone. */
async function dismissUntil(tx: Tx, household: Pick<HouseholdInfo, "id" | "timezone">, now: Date): Promise<Date> {
  const rhythm = await loadShoppingRhythm(tx, household, now);
  const until = rhythm.nextShopDate
    ? zonedDateTimeToInstant(addDays(rhythm.nextShopDate, 1), 0, household.timezone)
    : addDaysToInstant(now, DISMISS_FALLBACK_DAYS);
  return until > now ? until : addDaysToInstant(now, DISMISS_FALLBACK_DAYS);
}

/** Persist a new order for items (within an aisle group). */
export async function reorderShoppingItems(ctx: HouseholdContext, orderedIds: string[]): Promise<void> {
  if (orderedIds.length > 500) throw new AppError("validation", "Too many items.");
  await withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({ id: shoppingListItems.id, position: shoppingListItems.position })
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.householdId, ctx.household.id), inArray(shoppingListItems.id, orderedIds)));
    const current = new Map(rows.map((r) => [r.id, r.position]));
    // Ids a housemate just removed or bought drop out rather than shifting everyone else.
    const ids = [...new Set(orderedIds)].filter((itemId) => current.has(itemId));
    // Reuse the group's own positions in order, made distinct so tied items can still swap.
    const slots: number[] = [];
    for (const position of ids.map((itemId) => current.get(itemId)!).sort((a, b) => a - b)) {
      slots.push(slots.length === 0 ? position : Math.max(position, slots[slots.length - 1] + 1));
    }
    for (let i = 0; i < ids.length; i++) {
      if (current.get(ids[i]) === slots[i]) continue;
      await tx.update(shoppingListItems).set({ position: slots[i] }).where(eq(shoppingListItems.id, ids[i]));
    }
  });
}

/**
 * Finish a shop. Checked items leave the list; optionally they're added to
 * the kitchen straight away (for people who won't scan the receipt).
 * Otherwise they're kept as bought (hidden) until the receipt is confirmed,
 * so Plenty doesn't put them straight back while the kitchen doesn't know.
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
      await tx.delete(shoppingListItems).where(inArray(shoppingListItems.id, checked.map((c) => c.id)));
    } else {
      await tx.update(shoppingListItems).set({ purchasedAt: now }).where(inArray(shoppingListItems.id, checked.map((c) => c.id)));
    }
    await syncShoppingList(tx, ctx.household, now);
    return { moved: checked.length };
  });
}

export async function clearChecked(ctx: HouseholdContext): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    const list = await getOrCreateActiveList(tx, ctx.household.id);
    await tx
      .delete(shoppingListItems)
      .where(and(eq(shoppingListItems.listId, list.id), isNotNull(shoppingListItems.checkedAt), isNull(shoppingListItems.purchasedAt)));
  });
}

/**
 * After a receipt is confirmed: tick off matching list items as bought.
 * Matches on product, or on the normalised name for free-text items. Lines
 * added after the receipt's shop are for the next one and stay put. Returns
 * how many lines still on the list were ticked off.
 */
export async function markPurchasedFromReceipt(
  tx: Tx,
  householdId: string,
  bought: Array<{ productId: string | null; name: string }>,
  opts: { purchasedAt?: Date | null } = {},
): Promise<number> {
  const list = await getOrCreateActiveList(tx, householdId);
  const keys = new Set<string>();
  for (const b of bought) {
    if (b.productId) keys.add(shoppingItemKey({ productId: b.productId, name: b.name }));
    keys.add(nameKey(b.name));
  }
  // Receipt times are often just a date, so anything added by the end of the shop day counts.
  let addedBy: Date | null = null;
  if (opts.purchasedAt) {
    const [household] = await tx.select({ timezone: households.timezone }).from(households).where(eq(households.id, householdId)).limit(1);
    const tz = household?.timezone ?? "UTC";
    addedBy = zonedDateTimeToInstant(addDays(toDateString(opts.purchasedAt, tz), 1), 0, tz);
  }
  const rows = await tx.select().from(shoppingListItems).where(eq(shoppingListItems.listId, list.id));
  // Already bought at "Finish shop" (this receipt puts them in the kitchen), or on the list by the time of the shop.
  const candidates = rows.filter((r) => r.purchasedAt !== null || addedBy === null || r.createdAt < addedBy);
  const productIds = new Set(bought.map((b) => b.productId).filter(Boolean) as string[]);
  const names = new Set(bought.map((b) => singularizePhrase(normalizeText(b.name))));
  // A general "Milk" on the list is satisfied by any milk; a specific "Full cream milk" isn't by lite.
  const index = await loadProductIndex(tx, householdId);
  const groups = new Set(
    [...productIds].map((id) => index.byId.get(id)?.group).filter((g): g is string => Boolean(g)).map((g) => singularizePhrase(normalizeText(g))),
  );
  const matched = candidates.filter((row) => {
    const rowName = singularizePhrase(normalizeText(row.name));
    return keys.has(row.itemKey) || (row.productId && productIds.has(row.productId)) || names.has(rowName) || groups.has(rowName);
  });
  if (matched.length > 0) {
    await tx.delete(shoppingListItems).where(inArray(shoppingListItems.id, matched.map((m) => m.id)));
  }
  return matched.filter((m) => m.purchasedAt === null).length;
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

