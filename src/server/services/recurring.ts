import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { addDays, relativeDayLabel, toDateString } from "@/lib/dates";
import type { Aisle } from "@/lib/domain";
import type { ItemVisibility } from "@/lib/members/scope";
import { formatQuantity, isUnit, type Unit } from "@/lib/units";
import { requireEntitlement } from "@/server/billing/limits";
import type { HouseholdContext } from "@/server/auth/context";
import { withUser } from "@/server/db/client";
import { recurringItems, type DbRecurringItem } from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { requireCapability } from "@/server/permissions";
import { resolveOwnership } from "./inventory";
import { memberNames } from "./members";
import { loadProductIndex, resolveProduct } from "./products";
import { repeatPhrase, syncShoppingList } from "./shopping";

/** Things the household buys on a schedule ("milk every week"): added to the list when they come due. */
export interface RecurringView {
  id: string;
  name: string;
  aisle: Aisle;
  quantity: number | null;
  unit: Unit | null;
  quantityLabel: string;
  note: string | null;
  ownerMemberId: string | null;
  ownerName: string | null;
  visibility: ItemVisibility;
  intervalDays: number;
  /** "every week" */
  repeatLabel: string;
  nextDueOn: string;
  /** "Tomorrow", "In 5 days" */
  nextDueLabel: string;
  active: boolean;
}

function toView(row: DbRecurringItem, names: ReadonlyMap<string, string>, today: string): RecurringView {
  return {
    id: row.id,
    name: row.name,
    aisle: row.aisle as Aisle,
    quantity: row.quantity,
    unit: (row.unit as Unit | null) ?? null,
    quantityLabel: row.quantity
      ? row.unit && row.unit !== "each"
        ? formatQuantity(row.quantity, row.unit as Unit)
        : `×${formatQuantity(row.quantity, "each")}`
      : "",
    note: row.note,
    ownerMemberId: row.ownerMemberId,
    ownerName: row.ownerMemberId ? (names.get(row.ownerMemberId) ?? null) : null,
    visibility: row.visibility,
    intervalDays: row.intervalDays,
    repeatLabel: repeatPhrase(row.intervalDays),
    nextDueOn: row.nextDueOn,
    nextDueLabel: row.active ? relativeDayLabel(row.nextDueOn, today) : "Paused",
    active: row.active,
  };
}

export async function listRecurring(ctx: HouseholdContext, now = new Date()): Promise<RecurringView[]> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select()
      .from(recurringItems)
      .where(eq(recurringItems.householdId, ctx.household.id))
      .orderBy(asc(recurringItems.nextDueOn), asc(recurringItems.name));
    const names = await memberNames(tx, ctx.household.id);
    const today = toDateString(now, ctx.household.timezone);
    return rows.map((r) => toView(r, names, today));
  });
}

export interface RecurringInput {
  name: string;
  quantity?: number | null;
  unit?: Unit | null;
  note?: string | null;
  ownerMemberId?: string | null;
  visibility?: ItemVisibility;
  /** 1–365. */
  intervalDays: number;
}

function checkInterval(days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new AppError("validation", "Choose how often, between every day and every year.", { intervalDays: "Between 1 and 365 days." });
  }
  return days;
}

function cleanNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim().slice(0, 300);
  return trimmed ? trimmed : null;
}

/** Start repeating something. The first repeat is one interval from today: if it's needed now, it's already on the list. */
export async function createRecurring(ctx: HouseholdContext, input: RecurringInput, now = new Date()): Promise<string> {
  requireCapability(ctx, "edit_shopping_list");
  requireEntitlement(ctx, "recurring_purchases", "Regular purchases");
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("validation", "What should repeat?");
  const intervalDays = checkInterval(input.intervalDays);
  const owned = resolveOwnership(ctx, input);
  const quantity = input.quantity && input.quantity > 0 ? input.quantity : null;
  const unit = quantity ? (input.unit && isUnit(input.unit) ? input.unit : "each") : null;
  return withUser(ctx.user.id, async (tx) => {
    const index = await loadProductIndex(tx, ctx.household.id);
    const resolved = resolveProduct(index, name, 0.8);
    const today = toDateString(now, ctx.household.timezone);
    const [row] = await tx
      .insert(recurringItems)
      .values({
        householdId: ctx.household.id,
        productId: resolved?.product.id ?? null,
        name: name.charAt(0).toUpperCase() + name.slice(1),
        aisle: resolved?.product.aisle ?? "other",
        quantity,
        unit,
        note: cleanNote(input.note),
        ownerMemberId: owned.ownerMemberId,
        visibility: owned.visibility,
        intervalDays,
        nextDueOn: addDays(today, intervalDays),
        createdBy: ctx.user.id,
      })
      .returning({ id: recurringItems.id });
    return row.id;
  });
}

export interface RecurringPatch {
  quantity?: number | null;
  unit?: Unit | null;
  note?: string | null;
  intervalDays?: number;
  active?: boolean;
}

export async function updateRecurring(ctx: HouseholdContext, id: string, patch: RecurringPatch, now = new Date()): Promise<void> {
  requireCapability(ctx, "edit_shopping_list");
  await withUser(ctx.user.id, async (tx) => {
    const [row] = await tx
      .select()
      .from(recurringItems)
      .where(and(eq(recurringItems.id, id), eq(recurringItems.householdId, ctx.household.id)))
      .limit(1);
    if (!row) throw notFound("That regular purchase");
    const changes: Partial<typeof recurringItems.$inferInsert> = {};
    const today = toDateString(now, ctx.household.timezone);
    if (patch.intervalDays !== undefined) {
      changes.intervalDays = checkInterval(patch.intervalDays);
      // Counted from the last time it was put on the list, so changing "weekly" to "monthly" doesn't restart the clock from today.
      const last = row.lastAddedAt ? toDateString(row.lastAddedAt, ctx.household.timezone) : today;
      changes.nextDueOn = addDays(last, changes.intervalDays);
    }
    if (patch.quantity !== undefined) {
      if (patch.quantity !== null && !(patch.quantity > 0)) throw new AppError("validation", "Quantity must be more than zero.");
      changes.quantity = patch.quantity;
      changes.unit = patch.quantity === null ? null : patch.unit && isUnit(patch.unit) ? patch.unit : (row.unit ?? "each");
    }
    if (patch.note !== undefined) changes.note = cleanNote(patch.note);
    if (patch.active !== undefined) {
      changes.active = patch.active;
      // Resuming picks up from today rather than dumping everything missed while it was paused.
      if (patch.active && !row.active && changes.nextDueOn === undefined) changes.nextDueOn = addDays(today, row.intervalDays);
    }
    if (Object.keys(changes).length > 0) await tx.update(recurringItems).set(changes).where(eq(recurringItems.id, id));
    if (patch.active !== undefined || patch.intervalDays !== undefined) await syncShoppingList(tx, ctx.household, now);
  });
}

export async function deleteRecurring(ctx: HouseholdContext, id: string): Promise<void> {
  requireCapability(ctx, "edit_shopping_list");
  await withUser(ctx.user.id, async (tx) => {
    const removed = await tx
      .delete(recurringItems)
      .where(and(eq(recurringItems.id, id), eq(recurringItems.householdId, ctx.household.id)))
      .returning({ id: recurringItems.id });
    if (removed.length === 0) throw notFound("That regular purchase");
  });
}
