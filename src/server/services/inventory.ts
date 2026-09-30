import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { ProductInfo } from "@/lib/catalog/types";
import { addDays, DAY_MS, toDateString, zonedDateTimeToInstant } from "@/lib/dates";
import {
  AISLE_ORDER,
  levelLabel,
  STORAGE_LOCATIONS,
  type Aisle,
  type Confidence,
  type ConsumptionOutcome,
  type InventorySource,
  type StorageLocation,
} from "@/lib/domain";
import { assessUseSoon, estimateExpiry, type UseSoonAssessment } from "@/lib/prediction/expiry";
import { formatQuantity, isUnit, unitDimension, type Unit } from "@/lib/units";
import type { HouseholdContext, HouseholdInfo } from "@/server/auth/context";
import { withUser, type Tx } from "@/server/db/client";
import { consumptionEvents, inventoryEvents, inventoryItems, type DbInventoryItem } from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { computeLiveState, itemBaseAmount, recordLifecycleEnd, refreshLearning, type LiveState } from "./learning";
import { ensureCustomProduct, loadProductIndex, resolveProduct, type ProductIndex } from "./products";

const EMPTY_THRESHOLD = 0.02;
const CHECK_IN_SNOOZE_DAYS = 2;
/** "No, there's still some left" puts a nearly-empty batch back to about a quarter. */
const STILL_SOME_LEFT = 0.25;

// ─── Views ──────────────────────────────────────────────────────────────────

export interface ItemPredictionView {
  label: string;
  daysRemaining: number;
  confidence: Confidence;
  basis: "estimate" | "history";
  reason: string;
}

export interface InventoryItemView {
  id: string;
  name: string;
  productId: string | null;
  location: StorageLocation;
  aisle: Aisle;
  quantity: number;
  unit: Unit;
  packCount: number;
  quantityLabel: string;
  /** Last level the household told us (or the purchase level). */
  knownFraction: number;
  /** Plenty's estimate right now, after predicted use. */
  estimatedFraction: number;
  levelLabel: string;
  /** Counted things (eggs, avocados) get a − / + stepper instead of level presets. */
  countable: boolean;
  remainingCount: number | null;
  purchasedAt: string;
  expiresOn: string | null;
  expiryIsActual: boolean;
  useSoon: UseSoonAssessment;
  prediction: ItemPredictionView | null;
  needsCheckIn: boolean;
  source: InventorySource;
  confidence: Confidence;
  notes: string | null;
  price: number | null;
  perishable: boolean;
}

function isCountable(item: Pick<DbInventoryItem, "unit" | "quantity">): boolean {
  const unit = item.unit as Unit;
  return unitDimension(unit) === "count" && item.quantity >= 2 && item.quantity <= 36 && Number.isInteger(item.quantity);
}

export function toItemView(item: DbInventoryItem, live: LiveState, household: Pick<HouseholdInfo, "timezone">): InventoryItemView {
  const product = item.productId ? live.index.byId.get(item.productId) ?? null : null;
  const estimated = Math.max(0, Math.min(1, live.itemFractions.get(item.id) ?? item.remainingFraction));
  const today = toDateString(live.now, household.timezone);
  const expiresOn = item.actualExpiry ?? item.estimatedExpiry;
  const rate = item.productId ? live.dailyRates.get(item.productId) : undefined;
  const base = itemBaseAmount(item, product);
  const productPrediction = item.productId ? live.predictions.get(item.productId) : undefined;
  const countable = isCountable(item);
  return {
    id: item.id,
    name: item.name,
    productId: item.productId,
    location: item.location as StorageLocation,
    aisle: (product?.aisle ?? "other") as Aisle,
    quantity: item.quantity,
    unit: item.unit as Unit,
    packCount: item.packCount,
    // "2 × 2 L" for multipacks of measured things; counted things just show the count ("12", not "12 × 1").
    quantityLabel:
      item.packCount > 1 && unitDimension(item.unit as Unit) !== "count"
        ? `${item.packCount} × ${formatQuantity(item.quantity / item.packCount, item.unit as Unit)}`
        : formatQuantity(item.quantity, item.unit as Unit),
    knownFraction: item.remainingFraction,
    estimatedFraction: estimated,
    levelLabel: levelLabel(estimated),
    countable,
    remainingCount: countable ? Math.round(item.quantity * estimated) : null,
    purchasedAt: item.purchasedAt.toISOString(),
    expiresOn,
    expiryIsActual: Boolean(item.actualExpiry),
    useSoon: assessUseSoon({
      expiresOn,
      today,
      remainingFraction: estimated,
      dailyShareOfBatch: rate && base && base.amount > 0 ? rate / base.amount : null,
    }),
    prediction:
      productPrediction && !productPrediction.paused
        ? {
            label: productPrediction.prediction.label,
            daysRemaining: productPrediction.prediction.daysRemaining,
            confidence: productPrediction.prediction.confidence,
            basis: productPrediction.prediction.basis,
            reason: productPrediction.prediction.reason,
          }
        : null,
    needsCheckIn: Boolean(
      productPrediction?.prediction.needsCheckIn &&
        !productPrediction.paused &&
        !(item.checkInSnoozedUntil && item.checkInSnoozedUntil > live.now) &&
        estimated <= 0.05,
    ),
    source: item.source as InventorySource,
    confidence: item.confidence as Confidence,
    notes: item.notes,
    price: item.price,
    perishable: product?.perishable ?? false,
  };
}

export interface InventorySnapshot {
  items: InventoryItemView[];
  today: string;
  live: LiveState;
}

/** Every active item with Plenty's current estimates. */
export async function getInventory(ctx: HouseholdContext, now = new Date()): Promise<InventorySnapshot> {
  return withUser(ctx.user.id, async (tx) => {
    const live = await computeLiveState(tx, ctx.household, now);
    const items = live.activeItems.map((i) => toItemView(i, live, ctx.household));
    items.sort(
      (a, b) =>
        STORAGE_LOCATIONS.indexOf(a.location) - STORAGE_LOCATIONS.indexOf(b.location) ||
        AISLE_ORDER.indexOf(a.aisle) - AISLE_ORDER.indexOf(b.aisle) ||
        a.name.localeCompare(b.name),
    );
    return { items, today: toDateString(now, ctx.household.timezone), live };
  });
}

export interface ItemEventView {
  id: string;
  type: string;
  actor: string;
  note: string | null;
  fractionBefore: number | null;
  fractionAfter: number | null;
  occurredAt: string;
}

export interface ConsumptionHistoryView {
  id: string;
  outcome: ConsumptionOutcome;
  durationDays: number;
  amountUsedBase: number;
  amountWastedBase: number;
  baseUnit: string;
  endedAt: string;
}

export async function getInventoryItem(
  ctx: HouseholdContext,
  id: string,
  now = new Date(),
): Promise<{ item: InventoryItemView; status: string; events: ItemEventView[]; history: ConsumptionHistoryView[] } | null> {
  return withUser(ctx.user.id, async (tx) => {
    const [row] = await tx
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, id), eq(inventoryItems.householdId, ctx.household.id), isNull(inventoryItems.deletedAt)))
      .limit(1);
    if (!row) return null;
    const live = await computeLiveState(tx, ctx.household, now);
    const events = await tx
      .select()
      .from(inventoryEvents)
      .where(eq(inventoryEvents.inventoryItemId, id))
      .orderBy(desc(inventoryEvents.occurredAt))
      .limit(30);
    const history = row.productId
      ? await tx
          .select()
          .from(consumptionEvents)
          .where(and(eq(consumptionEvents.householdId, ctx.household.id), eq(consumptionEvents.productId, row.productId)))
          .orderBy(desc(consumptionEvents.endedAt))
          .limit(12)
      : [];
    return {
      item: toItemView(row, live, ctx.household),
      status: row.status,
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        actor: e.actor,
        note: e.note,
        fractionBefore: e.fractionBefore,
        fractionAfter: e.fractionAfter,
        occurredAt: e.occurredAt.toISOString(),
      })),
      history: history.map((h) => ({
        id: h.id,
        outcome: h.outcome,
        durationDays: h.durationDays,
        amountUsedBase: h.amountUsedBase,
        amountWastedBase: h.amountWastedBase,
        baseUnit: h.baseUnit,
        endedAt: h.endedAt.toISOString(),
      })),
    };
  });
}

export interface FinishedItemView {
  id: string;
  name: string;
  status: string;
  statusChangedAt: string | null;
}

/** Recently used-up / thrown-out items, so mistakes are one tap to undo. */
export async function recentlyFinished(ctx: HouseholdContext, limit = 12): Promise<FinishedItemView[]> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({ id: inventoryItems.id, name: inventoryItems.name, status: inventoryItems.status, statusChangedAt: inventoryItems.statusChangedAt })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.householdId, ctx.household.id), inArray(inventoryItems.status, ["finished", "wasted", "expired"]), isNull(inventoryItems.deletedAt)))
      .orderBy(desc(inventoryItems.statusChangedAt))
      .limit(limit);
    return rows.map((r) => ({ ...r, statusChangedAt: r.statusChangedAt?.toISOString() ?? null }));
  });
}

// ─── Adding ─────────────────────────────────────────────────────────────────

export interface AddItemInput {
  name: string;
  productId?: string | null;
  location?: StorageLocation | null;
  quantity?: number | null;
  unit?: Unit | null;
  packCount?: number | null;
  purchasedAt?: Date | null;
  actualExpiry?: string | null;
  notes?: string | null;
  price?: number | null;
  confidence?: Confidence;
  receiptItemId?: string | null;
  /** Start at this level instead of full (e.g. adding something already half used). */
  remainingFraction?: number | null;
}

function resolveForAdd(index: ProductIndex, input: AddItemInput): ProductInfo | null {
  if (input.productId) {
    const p = index.byId.get(input.productId);
    if (!p) throw new AppError("validation", "That product isn't available.");
    return p;
  }
  return resolveProduct(index, input.name, 0.8)?.product ?? null;
}

/**
 * Add items to the kitchen. Missing details are inferred from the product
 * catalog: where it's kept, the usual pack size, and when it'll likely expire.
 */
export async function addItemsTx(
  tx: Tx,
  household: Pick<HouseholdInfo, "id" | "timezone">,
  userId: string | null,
  inputs: AddItemInput[],
  source: InventorySource,
  now: Date,
): Promise<DbInventoryItem[]> {
  const index = await loadProductIndex(tx, household.id);
  const created: DbInventoryItem[] = [];
  for (const input of inputs) {
    let product = resolveForAdd(index, input);
    const location: StorageLocation = input.location ?? product?.location ?? "pantry";
    let packs = Math.max(1, Math.round(input.packCount ?? 1));
    const unit: Unit = input.unit && isUnit(input.unit) ? input.unit : product?.unit ?? "each";
    let quantity: number;
    if (input.quantity && input.quantity > 0) {
      quantity = input.quantity;
    } else if (product && product.unit === "each" && packs > 1 && (!input.unit || input.unit === "each")) {
      // Things counted one by one: "3 bananas" means three bananas, not three bunches.
      quantity = packs;
      packs = 1;
    } else if (product && (!input.unit || input.unit === product.unit)) {
      // Otherwise a bare number means whole packs of the usual size ("2 milk" = two 2 L bottles).
      quantity = product.packageQuantity * packs;
    } else {
      quantity = packs;
    }
    if (!product) {
      product = await ensureCustomProduct(tx, household.id, {
        name: input.name,
        aisle: "other",
        location,
        unit,
        packageQuantity: quantity,
      });
    }
    const purchasedAt = input.purchasedAt ?? now;
    const estimatedExpiry = estimateExpiry({
      purchasedAt,
      shelfLifeDays: product.shelfLifeDays,
      freezerShelfLifeDays: product.freezerShelfLifeDays,
      location,
      perishable: product.perishable,
      timeZone: household.timezone,
    });
    const fraction = input.remainingFraction ?? 1;
    const [row] = await tx
      .insert(inventoryItems)
      .values({
        householdId: household.id,
        productId: product.id,
        name: input.name.trim().slice(0, 120) || product.name,
        location,
        quantity,
        unit,
        packCount: packs,
        remainingFraction: Math.max(0, Math.min(1, fraction)),
        levelUpdatedAt: purchasedAt,
        purchasedAt,
        estimatedExpiry,
        actualExpiry: input.actualExpiry ?? null,
        source,
        receiptItemId: input.receiptItemId ?? null,
        confidence: input.confidence ?? "high",
        price: input.price ?? null,
        notes: input.notes ?? null,
        createdBy: userId,
      })
      .returning();
    await tx.insert(inventoryEvents).values({
      householdId: household.id,
      inventoryItemId: row.id,
      productId: row.productId,
      type: "added",
      actor: source === "receipt" ? "receipt" : "user",
      actorUserId: userId,
      fractionAfter: row.remainingFraction,
      occurredAt: purchasedAt,
    });
    created.push(row);
  }
  return created;
}

export async function addItems(ctx: HouseholdContext, inputs: AddItemInput[], source: InventorySource = "manual"): Promise<string[]> {
  const now = new Date();
  return withUser(ctx.user.id, async (tx) => {
    const created = await addItemsTx(tx, ctx.household, ctx.user.id, inputs, source, now);
    await refreshLearning(tx, ctx.household, created.map((c) => c.productId), now);
    return created.map((c) => c.id);
  });
}

// ─── Updating ───────────────────────────────────────────────────────────────

async function loadItem(tx: Tx, householdId: string, id: string): Promise<DbInventoryItem> {
  const [row] = await tx
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, id), eq(inventoryItems.householdId, householdId), isNull(inventoryItems.deletedAt)))
    .limit(1);
  if (!row) throw notFound("That item");
  return row;
}

export interface UpdateItemInput {
  name?: string;
  location?: StorageLocation;
  quantity?: number;
  unit?: Unit;
  actualExpiry?: string | null;
  notes?: string | null;
}

export async function updateItem(ctx: HouseholdContext, id: string, patch: UpdateItemInput): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const item = await loadItem(tx, ctx.household.id, id);
    const changes: Partial<typeof inventoryItems.$inferInsert> = {};
    if (patch.name !== undefined) changes.name = patch.name.trim().slice(0, 120) || item.name;
    if (patch.quantity !== undefined) {
      if (!(patch.quantity > 0)) throw new AppError("validation", "Quantity must be more than zero.");
      changes.quantity = patch.quantity;
    }
    if (patch.unit !== undefined) changes.unit = patch.unit;
    if (patch.actualExpiry !== undefined) changes.actualExpiry = patch.actualExpiry;
    if (patch.notes !== undefined) changes.notes = patch.notes?.slice(0, 500) || null;
    let moved = false;
    if (patch.location !== undefined && patch.location !== item.location) {
      moved = true;
      changes.location = patch.location;
      if (item.productId) {
        const index = await loadProductIndex(tx, ctx.household.id);
        const product = index.byId.get(item.productId);
        if (product) {
          // Moving into or out of the freezer changes how long it keeps, counted from now.
          const freezerMove = patch.location === "freezer" || item.location === "freezer";
          changes.estimatedExpiry = estimateExpiry({
            purchasedAt: freezerMove ? now : item.purchasedAt,
            shelfLifeDays: product.shelfLifeDays,
            freezerShelfLifeDays: product.freezerShelfLifeDays,
            location: patch.location,
            perishable: product.perishable,
            timeZone: ctx.household.timezone,
          });
        }
      }
    }
    if (Object.keys(changes).length === 0) return;
    await tx.update(inventoryItems).set(changes).where(eq(inventoryItems.id, id));
    await tx.insert(inventoryEvents).values({
      householdId: ctx.household.id,
      inventoryItemId: id,
      productId: item.productId,
      type: moved ? "moved" : "edited",
      actorUserId: ctx.user.id,
      note: moved ? `Moved to ${patch.location}` : null,
      occurredAt: now,
    });
    await refreshLearning(tx, ctx.household, [], now);
  });
}

/**
 * Set how much is left (Full / Mostly / Half / Low, or a count). Setting it
 * to empty finishes the item, which is how Plenty learns consumption.
 */
export async function setLevel(ctx: HouseholdContext, id: string, fraction: number): Promise<{ finished: boolean }> {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new AppError("validation", "That amount isn't valid.");
  }
  if (fraction <= EMPTY_THRESHOLD) {
    await finishItem(ctx, id, "consumed");
    return { finished: true };
  }
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const item = await loadItem(tx, ctx.household.id, id);
    if (item.status !== "active") throw new AppError("conflict", "That item has already been used up.");
    await tx
      .update(inventoryItems)
      .set({
        remainingFraction: fraction,
        levelUpdatedAt: now,
        checkInSnoozedUntil: new Date(now.getTime() + CHECK_IN_SNOOZE_DAYS * DAY_MS),
      })
      .where(eq(inventoryItems.id, id));
    await tx.insert(inventoryEvents).values({
      householdId: ctx.household.id,
      inventoryItemId: id,
      productId: item.productId,
      type: "adjusted",
      actorUserId: ctx.user.id,
      fractionBefore: item.remainingFraction,
      fractionAfter: fraction,
      occurredAt: now,
    });
    await refreshLearning(tx, ctx.household, [item.productId], now);
  });
  return { finished: false };
}

/**
 * Pick a plausible end time between the last confirmed level and the upper
 * bound, guided by the prediction. Never earlier than the last time someone
 * said how much was left — it clearly hadn't run out then.
 */
function inferEndTime(item: DbInventoryItem, predictedRunOutAt: Date | null, upperBound: Date): Date {
  const lower = Math.max(item.levelUpdatedAt.getTime(), item.purchasedAt.getTime(), item.openedAt?.getTime() ?? 0);
  const guess = predictedRunOutAt ? Math.min(upperBound.getTime(), predictedRunOutAt.getTime()) : upperBound.getTime();
  return new Date(Math.max(lower, guess));
}

export async function finishItemTx(
  tx: Tx,
  household: Pick<HouseholdInfo, "id" | "adults" | "children" | "timezone">,
  userId: string | null,
  item: DbInventoryItem,
  outcome: ConsumptionOutcome,
  opts: { endedAt: Date; estimatedFraction: number; actor?: "user" | "receipt" | "meal" | "inference"; mealPlanItemId?: string | null },
): Promise<boolean> {
  if (item.status !== "active") return false;
  const status = outcome === "consumed" ? "finished" : outcome;
  // Guard on the stored status, not the snapshot we were handed, so a batch is only ever finished once.
  const [claimed] = await tx
    .update(inventoryItems)
    .set({ status, statusChangedAt: opts.endedAt, remainingFraction: 0, levelUpdatedAt: opts.endedAt })
    .where(and(eq(inventoryItems.id, item.id), eq(inventoryItems.status, "active")))
    .returning({ id: inventoryItems.id });
  if (!claimed) return false;
  const index = await loadProductIndex(tx, household.id);
  const product = item.productId ? index.byId.get(item.productId) ?? null : null;
  const wastedFraction =
    outcome === "consumed" ? 0 : Math.max(opts.estimatedFraction, item.remainingFraction * 0.25, 0.05);
  await tx.insert(inventoryEvents).values({
    householdId: household.id,
    inventoryItemId: item.id,
    productId: item.productId,
    type: status,
    actor: opts.actor ?? "user",
    actorUserId: userId,
    fractionBefore: opts.estimatedFraction,
    fractionAfter: 0,
    mealPlanItemId: opts.mealPlanItemId ?? null,
    occurredAt: opts.endedAt,
  });
  await recordLifecycleEnd(tx, { household, item, product, outcome, endedAt: opts.endedAt, wastedFraction });
  return true;
}

/** Mark an item finished, wasted or expired. Records a consumption observation. */
export async function finishItem(ctx: HouseholdContext, id: string, outcome: ConsumptionOutcome): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const item = await loadItem(tx, ctx.household.id, id);
    if (item.status !== "active") return;
    const live = await computeLiveState(tx, ctx.household, now);
    const estimated = live.itemFractions.get(item.id) ?? item.remainingFraction;
    await finishItemTx(tx, ctx.household, ctx.user.id, item, outcome, { endedAt: now, estimatedFraction: estimated });
    await refreshLearning(tx, ctx.household, [item.productId], now);
  });
}

/** Remove an item added by mistake. Not a consumption event — nothing is learned from it. */
export async function removeItem(ctx: HouseholdContext, id: string): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const item = await loadItem(tx, ctx.household.id, id);
    await tx
      .update(inventoryItems)
      .set({ status: "removed", statusChangedAt: now, deletedAt: now })
      .where(eq(inventoryItems.id, id));
    await tx.insert(inventoryEvents).values({
      householdId: ctx.household.id,
      inventoryItemId: id,
      productId: item.productId,
      type: "removed",
      actorUserId: ctx.user.id,
      fractionBefore: item.remainingFraction,
      occurredAt: now,
    });
    await refreshLearning(tx, ctx.household, [item.productId], now);
  });
}

/** Undo a finish / waste / removal: restore the item and forget the observation it created. */
export async function restoreItem(ctx: HouseholdContext, id: string): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const [item] = await tx
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, id), eq(inventoryItems.householdId, ctx.household.id)))
      .limit(1);
    if (!item) throw notFound("That item");
    if (item.status === "active") return;
    const [last] = await tx
      .select()
      .from(inventoryEvents)
      .where(and(eq(inventoryEvents.inventoryItemId, id), inArray(inventoryEvents.type, ["finished", "wasted", "expired", "removed"])))
      .orderBy(desc(inventoryEvents.occurredAt))
      .limit(1);
    const fraction = Math.max(0.05, Math.min(1, last?.fractionBefore ?? 0.5));
    await tx
      .update(inventoryItems)
      .set({ status: "active", statusChangedAt: now, deletedAt: null, remainingFraction: fraction, levelUpdatedAt: now })
      .where(eq(inventoryItems.id, id));
    await tx.delete(consumptionEvents).where(eq(consumptionEvents.inventoryItemId, id));
    await tx.insert(inventoryEvents).values({
      householdId: ctx.household.id,
      inventoryItemId: id,
      productId: item.productId,
      type: "restored",
      actorUserId: ctx.user.id,
      fractionAfter: fraction,
      occurredAt: now,
    });
    await refreshLearning(tx, ctx.household, [item.productId], now);
  });
}

/**
 * Answer "Did you finish the milk?". Yes finishes the batches Plenty thinks
 * are empty (dated to when they most likely ran out); No sets them to "low"
 * and stops asking for a couple of days. Either way Plenty learns.
 */
export async function answerCheckIn(ctx: HouseholdContext, productId: string, finished: boolean): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const live = await computeLiveState(tx, ctx.household, now);
    const p = live.predictions.get(productId);
    const items = live.activeItems.filter((i) => i.productId === productId);
    if (items.length === 0) return;
    if (finished) {
      const runOut = p ? p.emptyAt : null;
      const candidates = items.filter((i) => (live.itemFractions.get(i.id) ?? i.remainingFraction) <= 0.1);
      const toFinish = candidates.length > 0 ? candidates : [items[0]];
      for (const item of toFinish) {
        await finishItemTx(tx, ctx.household, ctx.user.id, item, "consumed", {
          endedAt: inferEndTime(item, runOut, now),
          estimatedFraction: 0,
          actor: "user",
        });
      }
    } else {
      const snoozeUntil = new Date(now.getTime() + CHECK_IN_SNOOZE_DAYS * DAY_MS);
      for (const item of items) {
        const estimated = live.itemFractions.get(item.id) ?? item.remainingFraction;
        if (estimated >= STILL_SOME_LEFT) {
          // Not the batch in question, but stop asking about the product for a while.
          await tx.update(inventoryItems).set({ checkInSnoozedUntil: snoozeUntil }).where(eq(inventoryItems.id, item.id));
          continue;
        }
        await tx
          .update(inventoryItems)
          .set({ remainingFraction: STILL_SOME_LEFT, levelUpdatedAt: now, checkInSnoozedUntil: snoozeUntil })
          .where(eq(inventoryItems.id, item.id));
        await tx.insert(inventoryEvents).values({
          householdId: ctx.household.id,
          inventoryItemId: item.id,
          productId,
          type: "adjusted",
          actor: "user",
          actorUserId: ctx.user.id,
          fractionBefore: estimated,
          fractionAfter: STILL_SOME_LEFT,
          note: "Still some left",
          occurredAt: now,
        });
      }
    }
    await refreshLearning(tx, ctx.household, [productId], now);
  });
}

/**
 * Clear out things that are well past their date, in one go. Each is closed
 * off as expired — dated to when it most likely went off — so Plenty learns
 * about the waste without anyone updating items one by one.
 */
export async function clearOutItems(ctx: HouseholdContext, ids: string[]): Promise<number> {
  const now = new Date();
  return withUser(ctx.user.id, async (tx) => {
    const live = await computeLiveState(tx, ctx.household, now);
    const wanted = new Set(ids);
    const touched: Array<string | null> = [];
    let cleared = 0;
    for (const item of live.activeItems) {
      if (!wanted.has(item.id)) continue;
      const expiry = item.actualExpiry ?? item.estimatedExpiry;
      const wentOff = expiry ? zonedDateTimeToInstant(addDays(expiry, 1), 0, ctx.household.timezone) : null;
      const done = await finishItemTx(tx, ctx.household, ctx.user.id, item, "expired", {
        endedAt: inferEndTime(item, wentOff, now),
        estimatedFraction: live.itemFractions.get(item.id) ?? item.remainingFraction,
      });
      if (done) {
        cleared += 1;
        touched.push(item.productId);
      }
    }
    if (cleared > 0) await refreshLearning(tx, ctx.household, touched, now);
    return cleared;
  });
}

/**
 * Deduct what a cooked meal used. Amounts are in each item's own unit;
 * items that reach empty are finished (consumed).
 */
export async function consumeForMealTx(
  tx: Tx,
  household: Pick<HouseholdInfo, "id" | "adults" | "children" | "timezone">,
  userId: string,
  usage: Array<{ itemId: string; amount: number }>,
  mealPlanItemId: string | null,
  now: Date,
): Promise<string[]> {
  const touched: string[] = [];
  if (usage.length === 0) return touched;
  // One recipe can draw on the same batch twice (garlic in the marinade and the sauce).
  const totals = new Map<string, number>();
  for (const use of usage) {
    if (use.amount > 0) totals.set(use.itemId, (totals.get(use.itemId) ?? 0) + use.amount);
  }
  const live = await computeLiveState(tx, household, now);
  for (const [itemId, amount] of totals) {
    const use = { itemId, amount };
    const item = live.activeItems.find((i) => i.id === use.itemId);
    if (!item) continue;
    const current = live.itemFractions.get(item.id) ?? item.remainingFraction;
    const next = Math.max(0, current - use.amount / item.quantity);
    if (item.productId) touched.push(item.productId);
    if (next <= EMPTY_THRESHOLD + 0.03) {
      await finishItemTx(tx, household, userId, item, "consumed", {
        endedAt: now,
        estimatedFraction: current,
        actor: "meal",
        mealPlanItemId,
      });
    } else {
      await tx
        .update(inventoryItems)
        .set({ remainingFraction: next, levelUpdatedAt: now })
        .where(eq(inventoryItems.id, item.id));
      await tx.insert(inventoryEvents).values({
        householdId: household.id,
        inventoryItemId: item.id,
        productId: item.productId,
        type: "used",
        actor: "meal",
        actorUserId: userId,
        fractionBefore: current,
        fractionAfter: next,
        mealPlanItemId,
        occurredAt: now,
      });
    }
  }
  return touched;
}

/** Product ids with active stock, for "already have it" checks. */
export function activeProductIds(live: LiveState): Set<string> {
  return new Set(live.activeItems.filter((i) => i.productId && (live.itemFractions.get(i.id) ?? 0) > 0.05).map((i) => i.productId!));
}

export { inferEndTime };
