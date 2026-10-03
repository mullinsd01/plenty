import "server-only";
import { sql } from "drizzle-orm";
import { cheapestPlanWith, PLANS, type Entitlements, type PlanId } from "@/lib/billing/plans";
import type { HouseholdContext } from "@/server/auth/context";
import type { Tx } from "@/server/db/client";
import { AppError } from "@/server/errors";
import {
  addUsage,
  countActiveItems,
  countMembers,
  getUsage,
  USAGE_RECEIPT_SCANS,
  usagePeriod,
} from "./entitlements";

/**
 * Plan limits. These only ever stop something being *added*: nothing here
 * hides, removes or locks existing data, and basic use — finishing and
 * removing items, the shopping list, manual entry — is never blocked.
 */

type BooleanEntitlement = {
  [K in keyof Entitlements]: Entitlements[K] extends boolean ? K : never;
}[keyof Entitlements];

function upgradeSentence(plan: PlanId | null): string {
  return plan ? ` ${PLANS[plan].name} ${plan === "plus" ? "has no limit" : "includes more"}.` : "";
}

/** Throw a plain-language error that says what's limited and which plan lifts it. */
export function planLimitError(message: string): AppError {
  return new AppError("plan_limit", message);
}

/** Require a feature the household's plan includes. */
export function requireEntitlement(ctx: HouseholdContext, key: BooleanEntitlement, featureName: string): void {
  if (ctx.plan.entitlements[key]) return;
  const needed = cheapestPlanWith((e) => e[key] === true);
  throw planLimitError(
    needed
      ? `${featureName} is part of ${PLANS[needed].name}. Everything else keeps working as it is.`
      : `${featureName} isn't available yet.`,
  );
}

function roomVerdict(max: number, current: number, adding: number): { ok: true } | { ok: false; message: string } {
  if (current + adding <= max) return { ok: true };
  const next = cheapestPlanWith((e) => e.max_inventory_items === null || (e.max_inventory_items ?? 0) > max);
  const room = Math.max(0, max - current);
  return {
    ok: false,
    message:
      room === 0
        ? `Your kitchen is full on this plan (${max} items). Finish or remove something to make room.${upgradeSentence(next)}`
        : `There's room for ${room} more ${room === 1 ? "item" : "items"} on this plan (${max} in total).${upgradeSentence(next)}`,
  };
}

/** Whether there's room to add `adding` more items to the kitchen. A quick read for showing the limit; adding goes through `assertRoomForItemsIn`. */
export async function checkRoomForItems(ctx: HouseholdContext, adding = 1): Promise<{ ok: true } | { ok: false; message: string }> {
  const max = ctx.plan.entitlements.max_inventory_items;
  if (max === null) return { ok: true };
  return roomVerdict(max, await countActiveItems(ctx.household.id), adding);
}

/**
 * Check the kitchen limit inside the transaction that adds the items. A per-household lock makes two people adding at
 * once take turns, and the count is taken after the lock, so both can't squeeze past the last free place.
 */
export async function assertRoomForItemsIn(tx: Tx, ctx: HouseholdContext, adding = 1): Promise<void> {
  const max = ctx.plan.entitlements.max_inventory_items;
  if (max === null) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`kitchen:${ctx.household.id}`}, 0))`);
  const result = await tx.execute<{ n: number }>(sql`select app.household_item_count(${ctx.household.id}::uuid) as n`);
  const room = roomVerdict(max, Number(result.rows[0]?.n ?? 0), adding);
  if (!room.ok) throw planLimitError(room.message);
}

/** Whether the household can add another person (an account or a profile). */
export async function checkRoomForMember(ctx: HouseholdContext): Promise<{ ok: true } | { ok: false; message: string }> {
  const max = ctx.plan.entitlements.max_household_members;
  if (max === null) return { ok: true };
  const current = await countMembers(ctx.household.id);
  if (current < max) return { ok: true };
  const next = cheapestPlanWith((e) => e.max_household_members === null || (e.max_household_members ?? 0) > max);
  return {
    ok: false,
    message: `This plan covers up to ${max} ${max === 1 ? "person" : "people"} in a household.${next ? ` ${PLANS[next].name} covers more.` : ""}`,
  };
}

export async function assertRoomForMember(ctx: HouseholdContext): Promise<void> {
  const room = await checkRoomForMember(ctx);
  if (!room.ok) throw planLimitError(room.message);
}

export interface ReceiptScanAllowance {
  used: number;
  limit: number | null;
  remaining: number | null;
  period: string;
}

export async function receiptScanAllowance(ctx: HouseholdContext, now = new Date()): Promise<ReceiptScanAllowance> {
  const period = usagePeriod(ctx.household.timezone, now);
  const limit = ctx.plan.entitlements.receipt_scans_per_month;
  const used = await getUsage(ctx.household.id, USAGE_RECEIPT_SCANS, period);
  return { used, limit, remaining: limit === null ? null : Math.max(0, limit - used), period };
}

/** Refuse a new receipt when this month's scans on the plan are used up. The read itself counts the scan (see `processReceipt`). */
export async function assertReceiptScanAvailable(ctx: HouseholdContext, now = new Date()): Promise<void> {
  const allowance = await receiptScanAllowance(ctx, now);
  if (allowance.limit === null || allowance.used < allowance.limit) return;
  const next = cheapestPlanWith((e) => e.receipt_scans_per_month === null);
  throw planLimitError(
    `You've used this month's ${allowance.limit} receipt scans on this plan. You can still add items by hand, and scans reset next month.${next ? ` ${PLANS[next].name} has no limit.` : ""}`,
  );
}

/**
 * Use one receipt scan from this month's allowance. Throws when it's used up.
 * Returns the period it was taken from so a failed read can give it back.
 */
export async function consumeReceiptScan(ctx: HouseholdContext, now = new Date()): Promise<string> {
  const period = usagePeriod(ctx.household.timezone, now);
  const limit = ctx.plan.entitlements.receipt_scans_per_month;
  if (limit === null) {
    await addUsage(ctx.household.id, USAGE_RECEIPT_SCANS, period, 1);
    return period;
  }
  const used = await addUsage(ctx.household.id, USAGE_RECEIPT_SCANS, period, 1);
  if (used > limit) {
    await addUsage(ctx.household.id, USAGE_RECEIPT_SCANS, period, -1);
    const next = cheapestPlanWith((e) => e.receipt_scans_per_month === null);
    throw planLimitError(
      `You've used this month's ${limit} receipt scans on this plan. You can still add items by hand, and scans reset next month.${next ? ` ${PLANS[next].name} has no limit.` : ""}`,
    );
  }
  return period;
}

/** A scan that couldn't be read shouldn't count against the allowance. */
export async function refundReceiptScan(householdId: string, period: string): Promise<void> {
  await addUsage(householdId, USAGE_RECEIPT_SCANS, period, -1);
}
