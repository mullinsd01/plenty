import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, max, sql } from "drizzle-orm";
import { addDays, addDaysToInstant, toDateString, zonedDateTimeToInstant } from "@/lib/dates";
import { AISLE_ORDER, CHECK_CUPBOARD_ADVICE, isComputedSource, type Aisle, type ShoppingSource } from "@/lib/domain";
import { computeShoppingRhythm, shoppingHorizonDays, type ShoppingRhythm } from "@/lib/insights";
import { computePlanRequirements } from "@/lib/meals/requirements";
import type { ExistingListItem, PlanMealInput, PredictionInput, ShoppingNeed, StapleInput } from "@/lib/meals/types";
import { isRestricted, refusalMessage } from "@/lib/members/permissions";
import { HOUSEHOLD_SCOPE, learningKey, scopeOf, type ItemVisibility } from "@/lib/members/scope";
import { normalizeText, singularizePhrase } from "@/lib/normalize";
import { computeShoppingNeeds } from "@/lib/shopping/needs";
import { reconcileShoppingList } from "@/lib/shopping/reconcile";
import { normalizeItemName, shoppingItemKey } from "@/lib/shopping/keys";
import { convert, formatQuantity, isUnit, type Unit } from "@/lib/units";
import type { HouseholdContext, HouseholdInfo } from "@/server/auth/context";
import { assertRoomForItems } from "@/server/billing/limits";
import { withUser, type Queryable, type Tx } from "@/server/db/client";
import {
  consumptionStats,
  households,
  inventoryItems,
  preferences,
  receipts,
  recurringItems,
  shoppingListItemSources,
  shoppingListItems,
  shoppingLists,
  type DbShoppingListItem,
} from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { trackFor } from "@/server/analytics";
import { requireCapability } from "@/server/permissions";
import { addItemsTx, resolveOwnership } from "./inventory";
import { computeLiveState, itemScope, productBase, refreshLearning, type LearningHousehold, type LiveState } from "./learning";
import { memberNames } from "./members";
import { notifyHousemates } from "./notifications";
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
  household: LearningHousehold,
  now: Date,
  liveState?: LiveState,
): Promise<void> {
  const live = liveState ?? (await computeLiveState(tx, household, now));
  const list = await getOrCreateActiveList(tx, household.id);
  const today = toDateString(now, household.timezone);
  const products = live.index.byId;

  // Running-low suggestions and staples are part of the plans that include smart replenishment;
  // the list itself, requests and anything a person adds work on every plan.
  const predictionInputs: PredictionInput[] = [];
  for (const p of household.smartShopping ? live.predictions.values() : []) {
    if (p.paused) continue;
    predictionInputs.push({
      productId: p.productId,
      itemKey: shoppingItemKey({ productId: p.productId, name: p.product.name, scope: p.scope }),
      scope: p.scope,
      ownerMemberId: p.ownerMemberId,
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
  const planRows = household.mealPlanToList ? await upcomingPlanItems(tx, household.id, today) : [];
  const meals = await loadPlannableMeals(tx, household.id, Array.from(new Set(planRows.map((r) => r.mealId))));
  const planInputs: PlanMealInput[] = planRows
    .filter((r) => meals.has(r.mealId))
    .map((r) => ({ planItemId: r.id, date: r.date, servings: r.servings, meal: meals.get(r.mealId)! }));
  const requirements = computePlanRequirements({ items: planInputs, lots: lotsFromLive(live, today), products });

  // Staples: learned (or user-forced) regular buys.
  const stapleRows = household.smartShopping
    ? [...live.statsRows.values()].filter((s) => (s.stapleOverride ?? s.isStaple) && !s.predictionsPaused)
    : [];
  // Stock is counted per person's pattern: Dad having Pepsi Max doesn't mean Mum has hers.
  const stocked = new Set(
    live.activeItems
      .filter((i) => i.productId && (live.itemFractions.get(i.id) ?? 0) > 0.05)
      .map((i) => learningKey(i.productId!, itemScope(live, i))),
  );
  const staples: StapleInput[] = stapleRows
    .filter((s) => products.has(s.productId))
    .map((s) => {
      const product = products.get(s.productId)!;
      return {
        productId: s.productId,
        name: product.name,
        aisle: product.aisle,
        scope: s.scope,
        ownerMemberId: s.ownerMemberId,
        typicalPurchaseAmount: s.typicalPurchaseAmount,
        baseUnit: productBase(product),
        lastPurchasedAt: s.lastPurchasedAt,
        typicalIntervalDays: s.typicalPurchaseIntervalDays,
        hasActiveStock: stocked.has(learningKey(s.productId, s.scope)),
      };
    });

  // Waste history per person's pattern, with the household's as the product-wide fallback.
  const waste = new Map<string, { wasteRatio: number; wasteEvents: number }>();
  for (const s of live.statsRows.values()) {
    const entry = { wasteRatio: s.wasteRatio, wasteEvents: s.wasteEvents };
    waste.set(learningKey(s.productId, s.scope), entry);
    if (s.scope === HOUSEHOLD_SCOPE || !waste.has(s.productId)) waste.set(s.productId, entry);
  }
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
  const seenProducts = new Set([
    ...[...live.statsRows.values()].map((s) => s.productId),
    ...live.activeItems.map((i) => i.productId).filter(Boolean),
  ] as string[]);
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
  if (household.recurringPurchases) await addDueRecurring(tx, household, list.id, today, now);
  const existingRows = await tx.select().from(shoppingListItems).where(eq(shoppingListItems.listId, list.id));
  const existing: ExistingListItem[] = existingRows.map((r) => ({
    id: r.id,
    itemKey: r.itemKey,
    productId: r.productId,
    name: r.name,
    ownerMemberId: r.ownerMemberId,
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
        ownerMemberId: need.ownerMemberId ?? null,
        visibility: need.visibility ?? "household",
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

/**
 * Put anything set to repeat on the list once it comes due, then schedule its next time.
 * It lands as the household's own line (never removed by Plenty), keyed like anything
 * else, so an item already on the list isn't doubled up.
 */
async function addDueRecurring(
  tx: Tx,
  household: Pick<LearningHousehold, "id">,
  listId: string,
  today: string,
  now: Date,
): Promise<void> {
  const due = await tx
    .select()
    .from(recurringItems)
    .where(and(eq(recurringItems.householdId, household.id), eq(recurringItems.active, true), lte(recurringItems.nextDueOn, today)));
  if (due.length === 0) return;
  const [maxRow] = await tx
    .select({ max: sql<number>`coalesce(max(${shoppingListItems.position}), 0)` })
    .from(shoppingListItems)
    .where(eq(shoppingListItems.listId, listId));
  let position = Number(maxRow?.max ?? 0);
  for (const r of due) {
    const itemKey = shoppingItemKey({ productId: r.productId, name: r.name, scope: scopeOf(r) });
    position += 1;
    const [created] = await tx
      .insert(shoppingListItems)
      .values({
        listId,
        householdId: household.id,
        productId: r.productId,
        itemKey,
        name: r.name,
        ownerMemberId: r.ownerMemberId,
        visibility: r.visibility,
        note: r.note,
        aisle: r.aisle,
        quantity: r.quantity,
        unit: r.quantity ? r.unit ?? "each" : null,
        source: "recurring",
        reason: `You set this to repeat ${repeatPhrase(r.intervalDays)}`,
        userEdited: r.quantity !== null,
        recurringItemId: r.id,
        position,
        addedBy: r.createdBy,
      })
      .onConflictDoNothing({ target: [shoppingListItems.listId, shoppingListItems.itemKey] })
      .returning({ id: shoppingListItems.id });
    if (!created) {
      // Already on the list counts as added. Bought-but-not-yet-scanned lines are held for a few
      // days, so try again after that rather than skipping this round.
      const [existing] = await tx
        .select({ purchasedAt: shoppingListItems.purchasedAt })
        .from(shoppingListItems)
        .where(and(eq(shoppingListItems.listId, listId), eq(shoppingListItems.itemKey, itemKey)))
        .limit(1);
      if (existing?.purchasedAt) continue;
    }
    await tx
      .update(recurringItems)
      .set({ nextDueOn: addDays(today, r.intervalDays), lastAddedAt: now })
      .where(eq(recurringItems.id, r.id));
  }
}

/** "every 2 weeks" — shared with the recurring-items screen. */
export function repeatPhrase(days: number): string {
  if (days === 1) return "every day";
  if (days === 7) return "every week";
  if (days % 7 === 0 && days <= 28) return `every ${days / 7} weeks`;
  if (days >= 28 && days <= 31) return "every month";
  return `every ${days} days`;
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
  note: string | null;
  /** Whose it's for ("Pepsi Max — Dad"); null = the household's. */
  ownerMemberId: string | null;
  ownerName: string | null;
  /** Who asked for it ("Mum wants Pepsi Max"). */
  requestedByMemberId: string | null;
  requestedByName: string | null;
  visibility: ItemVisibility;
  /** Set to repeat on a schedule. */
  recurring: boolean;
  /** Plenty's own suggestion (running low, a staple, a meal) rather than something a person put there. */
  suggested: boolean;
  /** The signed-in person added, asked for or owns this. */
  isMine: boolean;
  /** The signed-in person can change or remove it (a child can only change their own requests). */
  canChange: boolean;
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

/**
 * Plenty's own guesses (running low, a regular buy) rather than something the household set up: a meal on the plan is
 * theirs, so its ingredients aren't "suggested", they're simply needed.
 */
function isGuess(row: Pick<DbShoppingListItem, "source">): boolean {
  return row.source === "predicted" || row.source === "staple";
}

interface Viewer {
  memberId: string;
  restricted: boolean;
  names: ReadonlyMap<string, string>;
}

/** A restricted member may only change what they asked for themselves. */
function canChangeLine(viewer: Pick<Viewer, "memberId" | "restricted">, row: Pick<DbShoppingListItem, "requestedByMemberId">): boolean {
  return !viewer.restricted || row.requestedByMemberId === viewer.memberId;
}

function toView(row: DbShoppingListItem, sources: Array<typeof shoppingListItemSources.$inferSelect>, viewer: Viewer): ShoppingItemView {
  const { quantity, unit } = effectiveAmount(row);
  return {
    id: row.id,
    name: row.name,
    aisle: row.aisle as Aisle,
    productId: row.productId,
    note: row.note,
    ownerMemberId: row.ownerMemberId,
    ownerName: row.ownerMemberId ? viewer.names.get(row.ownerMemberId) ?? null : null,
    requestedByMemberId: row.requestedByMemberId,
    requestedByName: row.requestedByMemberId ? viewer.names.get(row.requestedByMemberId) ?? null : null,
    visibility: row.visibility,
    recurring: row.source === "recurring" || row.recurringItemId !== null,
    suggested: isGuess(row) && !row.userEdited,
    isMine: row.ownerMemberId === viewer.memberId || row.requestedByMemberId === viewer.memberId,
    canChange: canChangeLine(viewer, row),
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
    // A restricted member can read the list but not rewrite it; the next adult to open it brings it up to date.
    if (
      !isRestricted(ctx.role) &&
      (!list.lastSyncedAt ||
        now.getTime() - list.lastSyncedAt.getTime() > SYNC_STALE_MS ||
        (await kitchenChangedSince(tx, ctx.household.id, list.lastSyncedAt)))
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
    const viewer: Viewer = { memberId: ctx.member.id, restricted: isRestricted(ctx.role), names: await memberNames(tx, ctx.household.id) };
    const items = visible.map((r) => toView(r, sourceRows.filter((s) => s.itemId === r.id), viewer));
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

/** Load a line the signed-in person is allowed to change: anyone's for an adult, only their own requests for a child. */
async function loadChangeableItem(tx: Tx, ctx: HouseholdContext, id: string): Promise<DbShoppingListItem> {
  const row = await loadListItem(tx, ctx.household.id, id);
  const viewer = { memberId: ctx.member.id, restricted: isRestricted(ctx.role) };
  if (!canChangeLine(viewer, row)) throw new AppError("forbidden", refusalMessage("edit_shopping_list"));
  return row;
}

export interface AddListItemInput {
  name: string;
  quantity?: number | null;
  unit?: Unit | null;
  note?: string | null;
  /** Whose it's for; null or absent = the household's. */
  ownerMemberId?: string | null;
  /** `private` keeps the line (and what's learned from it) to its owner. */
  visibility?: ItemVisibility;
}

function cleanNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim().slice(0, 300);
  return trimmed ? trimmed : null;
}

/**
 * Put a line on the list, or fold it into the one already there for the same thing
 * and the same person — including one a housemate is adding at this very moment.
 */
async function upsertListLine(
  tx: Tx,
  ctx: HouseholdContext,
  input: AddListItemInput,
  owned: { ownerMemberId: string | null; visibility: ItemVisibility },
  how: { source: "manual" | "request"; requestedByMemberId: string | null },
): Promise<{ id: string; created: boolean; mine: boolean }> {
  const name = input.name.trim();
  if (!name) throw new AppError("validation", "What do you need?");
  const list = await getOrCreateActiveList(tx, ctx.household.id);
  const index = await loadProductIndex(tx, ctx.household.id);
  const resolved = resolveProduct(index, name, 0.8);
  const productId = resolved?.product.id ?? null;
  const itemKey = shoppingItemKey({ productId, name, scope: scopeOf(owned) });
  const quantity = input.quantity && input.quantity > 0 ? input.quantity : null;
  // "2 milk" means two of the usual thing, so a bare count is stored as items, not litres.
  const unit = quantity ? (input.unit && isUnit(input.unit) ? input.unit : "each") : null;
  const note = cleanNote(input.note);

  const [maxRow] = await tx
    .select({ max: sql<number>`coalesce(max(${shoppingListItems.position}), 0)` })
    .from(shoppingListItems)
    .where(eq(shoppingListItems.listId, list.id));
  const [created] = await tx
    .insert(shoppingListItems)
    .values({
      listId: list.id,
      householdId: ctx.household.id,
      productId,
      itemKey,
      // Keep the household's own words: "Milk" means any milk, not specifically full cream.
      name: name.charAt(0).toUpperCase() + name.slice(1),
      ownerMemberId: owned.ownerMemberId,
      visibility: owned.visibility,
      requestedByMemberId: how.requestedByMemberId,
      note,
      aisle: resolved?.product.aisle ?? "other",
      quantity,
      unit,
      source: how.source,
      userEdited: quantity !== null,
      position: Number(maxRow?.max ?? 0) + 1,
      addedBy: ctx.user.id,
    })
    .onConflictDoNothing({ target: [shoppingListItems.listId, shoppingListItems.itemKey] })
    .returning({ id: shoppingListItems.id });
  if (created) return { id: created.id, created: true, mine: true };

  // Lock the line so two people adding to it at once both count.
  const [existing] = await tx
    .select()
    .from(shoppingListItems)
    .where(and(eq(shoppingListItems.listId, list.id), eq(shoppingListItems.itemKey, itemKey)))
    .limit(1)
    .for("update");
  if (!existing) throw new AppError("conflict", "The list changed while you were adding that. Please try again.");
  // A restricted member can't change someone else's line: it's already on the list, which is what they wanted.
  if (isRestricted(ctx.role) && existing.requestedByMemberId !== ctx.member.id) return { id: existing.id, created: false, mine: false };
  // Two people each adding "lemons" means both amounts are needed: add them up rather
  // than quietly replacing what someone else asked for.
  const stillWanted = !isComputedSource(existing.source as ShoppingSource) && !existing.checkedAt && !existing.purchasedAt;
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
      // Something Plenty suggested becomes the person's own once they ask for it too.
      source: isComputedSource(existing.source as ShoppingSource) ? how.source : existing.source,
      userEdited: quantity ? true : existing.userEdited,
      quantity: combined,
      unit: combinedUnit,
      note: note ?? existing.note,
      requestedByMemberId: existing.requestedByMemberId ?? how.requestedByMemberId,
      checkedAt: null,
      checkedBy: null,
      purchasedAt: null,
      dismissedUntil: null,
    })
    .where(eq(shoppingListItems.id, existing.id));
  return { id: existing.id, created: false, mine: true };
}

/** Add something the household wants. Merges with an existing entry for the same product and person. */
export async function addManualItem(ctx: HouseholdContext, input: AddListItemInput): Promise<string> {
  requireCapability(ctx, "edit_shopping_list");
  const owned = resolveOwnership(ctx, input);
  const line = await withUser(ctx.user.id, (tx) => upsertListLine(tx, ctx, input, owned, { source: "manual", requestedByMemberId: null }));
  if (line.created) await trackFor(ctx, "item_added_to_shopping_list", { source: "manual" });
  return line.id;
}

export interface RequestInput {
  name: string;
  quantity?: number | null;
  unit?: Unit | null;
  note?: string | null;
  /** Ask for it for the whole household instead of for yourself. */
  forHousehold?: boolean;
}

/**
 * Ask for something ("Mum wants Pepsi Max"). Anyone in the household can, children
 * included; it goes on the shared list under Requests with the person's name, and
 * the adults are told.
 */
export async function addRequest(ctx: HouseholdContext, input: RequestInput): Promise<{ id: string; alreadyOnList: boolean }> {
  requireCapability(ctx, "make_requests");
  const owned = { ownerMemberId: input.forHousehold ? null : ctx.member.id, visibility: "household" as const };
  const result = await withUser(ctx.user.id, async (tx) => {
    const line = await upsertListLine(tx, ctx, input, owned, { source: "request", requestedByMemberId: ctx.member.id });
    if (line.created) {
      const asked = input.name.trim().toLowerCase();
      await notifyHousemates(tx, ctx.household, ctx.user.id, {
        type: "request",
        title: `${ctx.member.displayName} asked for ${asked}`,
        body: "It's on the shopping list under Requests.",
        link: "/list",
        dedupeKey: `request:${line.id}`,
      });
    }
    return { id: line.id, alreadyOnList: !line.created };
  });
  if (!result.alreadyOnList) await trackFor(ctx, "item_added_to_shopping_list", { source: "request" });
  return result;
}

export async function updateShoppingItem(
  ctx: HouseholdContext,
  id: string,
  patch: { name?: string; quantity?: number | null; unit?: Unit | null; aisle?: Aisle; note?: string | null },
): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const row = await loadChangeableItem(tx, ctx, id);
    const changes: Partial<typeof shoppingListItems.$inferInsert> = {};
    let rekeyed = false;
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 120);
      if (!name) throw new AppError("validation", "Give it a name.");
      changes.name = name;
      // Renaming something the household added makes it a different thing ("Lemons" → "Limes"):
      // re-key it so later adds, Plenty's own needs and receipts match the new name, not the old.
      if (!isComputedSource(row.source as ShoppingSource) && normalizeItemName(name) !== normalizeItemName(row.name)) {
        const index = await loadProductIndex(tx, ctx.household.id);
        const resolved = resolveProduct(index, name, 0.8);
        const productId = resolved?.product.id ?? null;
        const itemKey = shoppingItemKey({ productId, name, scope: scopeOf(row) });
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
    if (patch.note !== undefined) changes.note = cleanNote(patch.note);
    if (Object.keys(changes).length > 0) await tx.update(shoppingListItems).set(changes).where(eq(shoppingListItems.id, id));
    // The old name's reasons don't apply to the new thing.
    if (rekeyed) await tx.delete(shoppingListItemSources).where(eq(shoppingListItemSources.itemId, id));
  });
}

/**
 * "Keep it": the household wants something Plenty suggested. It becomes theirs, at the suggested
 * amount, so Plenty no longer adjusts it or takes it off when it thinks it isn't needed.
 */
export async function keepSuggestion(ctx: HouseholdContext, id: string): Promise<void> {
  requireCapability(ctx, "edit_shopping_list");
  await withUser(ctx.user.id, async (tx) => {
    const row = await loadListItem(tx, ctx.household.id, id);
    if (!isGuess(row) || row.userEdited) return;
    await tx
      .update(shoppingListItems)
      .set({ userEdited: true, quantity: row.suggestedQuantity, unit: row.suggestedQuantity ? row.suggestedUnit ?? "each" : null })
      .where(eq(shoppingListItems.id, id));
  });
}

export async function setChecked(ctx: HouseholdContext, id: string, checked: boolean): Promise<void> {
  requireCapability(ctx, "edit_shopping_list");
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
    const row = await loadChangeableItem(tx, ctx, id);
    let dismissAs: ShoppingSource = row.source as ShoppingSource;
    // Something a person asked for is theirs to delete; only Plenty's own suggestions are dismissed rather than deleted.
    if (!isComputedSource(row.source as ShoppingSource)) {
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
        ...(!isComputedSource(row.source as ShoppingSource) ? { source: dismissAs, quantity: null, unit: null, userEdited: false } : {}),
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
  requireCapability(ctx, "edit_shopping_list");
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
  requireCapability(ctx, "complete_shop");
  const now = new Date();
  const completed: ShoppingSource[] = [];
  const result = await withUser(ctx.user.id, async (tx) => {
    const list = await getOrCreateActiveList(tx, ctx.household.id);
    const checked = await tx
      .select()
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.listId, list.id), isNotNull(shoppingListItems.checkedAt), isNull(shoppingListItems.purchasedAt)));
    if (checked.length === 0) return { moved: 0 };
    if (addToKitchen) {
      await assertRoomForItems(ctx, checked.length);
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
          // Bought for Dad, it goes into the kitchen as Dad's; a private line stays private.
          ownerMemberId: c.ownerMemberId,
          visibility: c.visibility,
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
    completed.push(...checked.map((c) => c.source as ShoppingSource));
    return { moved: checked.length };
  });
  for (const source of completed.slice(0, 50)) await trackFor(ctx, "shopping_item_completed", { source });
  return result;
}

export async function clearChecked(ctx: HouseholdContext): Promise<void> {
  requireCapability(ctx, "edit_shopping_list");
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
  // `ownerMemberId` is who a bought item was assigned to; unassigned matches any line, as it always has.
  bought: Array<{ productId: string | null; name: string; ownerMemberId?: string | null }>,
  opts: { purchasedAt?: Date | null } = {},
): Promise<number> {
  const list = await getOrCreateActiveList(tx, householdId);
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
  // A general "Milk" on the list is satisfied by any milk; a specific "Full cream milk" isn't by lite.
  const index = await loadProductIndex(tx, householdId);
  const purchases = bought.map((b) => {
    const group = b.productId ? index.byId.get(b.productId)?.group : undefined;
    return {
      productId: b.productId,
      ownerMemberId: b.ownerMemberId ?? null,
      keys: new Set([b.productId ? shoppingItemKey({ productId: b.productId, name: b.name }) : null, nameKey(b.name)].filter(Boolean) as string[]),
      name: singularizePhrase(normalizeText(b.name)),
      group: group ? singularizePhrase(normalizeText(group)) : null,
    };
  });
  const matched = candidates.filter((row) => {
    const rowName = singularizePhrase(normalizeText(row.name));
    return purchases.some((p) => {
      // Bought for Mum, it satisfies Mum's line and the household's, but not Dad's.
      const ownerFits = p.ownerMemberId === null || row.ownerMemberId === null || row.ownerMemberId === p.ownerMemberId;
      const sameThing =
        p.keys.has(row.itemKey) || (row.productId !== null && row.productId === p.productId) || p.name === rowName || p.group === rowName;
      return ownerFits && sameThing;
    });
  });
  if (matched.length > 0) {
    await tx.delete(shoppingListItems).where(inArray(shoppingListItems.id, matched.map((m) => m.id)));
  }
  return matched.filter((m) => m.purchasedAt === null).length;
}

/** Toggle whether a product is treated as a household staple (null = let Plenty decide). */
export async function setStapleOverride(ctx: HouseholdContext, productId: string, value: boolean | null): Promise<void> {
  requireCapability(ctx, "edit_shopping_list");
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
        scope: HOUSEHOLD_SCOPE,
        baseUnit: productBase(product),
        stapleOverride: value,
      });
    }
    await syncShoppingList(tx, ctx.household, now);
  });
}

