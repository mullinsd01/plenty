import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  entitlementsFor,
  isBillingPeriod,
  isPlanId,
  planRank,
  type Entitlements,
  type PlanId,
} from "@/lib/billing/plans";
import { resolveEffectivePlan, type EffectivePlan, type SubscriptionState } from "@/lib/billing/subscription";
import { toDateString } from "@/lib/dates";
import { systemDb, type Queryable } from "@/server/db/client";
import { env } from "@/server/env";
import { householdMembers, inventoryItems, subscriptions, usageCounters, type DbSubscription } from "@/server/db/schema";

/** A household's plan as the app should treat it right now. */
export interface HouseholdPlan {
  /** The plan whose limits apply. */
  plan: PlanId;
  entitlements: Entitlements;
  effective: EffectivePlan;
  /** The plan comes from this server's `PLAN_OVERRIDE` setting rather than a subscription. */
  overridden: boolean;
}

export function toSubscriptionState(row: DbSubscription): SubscriptionState {
  return {
    plan: isPlanId(row.plan) ? row.plan : "free",
    period: isBillingPeriod(row.period) ? row.period : null,
    status: row.status,
    provider: row.provider,
    autoRenew: row.autoRenew,
    currentPeriodEnd: row.currentPeriodEnd,
    trialEndsAt: row.trialEndsAt,
    graceEndsAt: row.graceEndsAt,
    pendingPlan: isPlanId(row.pendingPlan) ? row.pendingPlan : null,
    pendingPeriod: isBillingPeriod(row.pendingPeriod) ? row.pendingPeriod : null,
    lastEventAt: row.lastEventAt,
  };
}

export async function loadSubscription(householdId: string, db: Queryable = systemDb): Promise<DbSubscription | null> {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.householdId, householdId)).limit(1);
  return row ?? null;
}

/** Resolve what plan a household is on. Trusted: callers must already have authorised access to the household. */
export async function resolveHouseholdPlan(householdId: string, now = new Date(), db: Queryable = systemDb): Promise<HouseholdPlan> {
  const row = await loadSubscription(householdId, db);
  const effective = resolveEffectivePlan(row ? toSubscriptionState(row) : null, now);
  const override = env().PLAN_OVERRIDE;
  if (override && planRank(override) > planRank(effective.plan)) {
    return { plan: override, entitlements: entitlementsFor(override), effective, overridden: true };
  }
  return { plan: effective.plan, entitlements: entitlementsFor(effective.plan), effective, overridden: false };
}

// ─── Usage and limits ───────────────────────────────────────────────────────

export const USAGE_RECEIPT_SCANS = "receipt_scans";

/** The calendar month in the household's time zone, as YYYY-MM. */
export function usagePeriod(timeZone: string, now = new Date()): string {
  return toDateString(now, timeZone).slice(0, 7);
}

export async function getUsage(householdId: string, metric: string, period: string, db: Queryable = systemDb): Promise<number> {
  const [row] = await db
    .select({ count: usageCounters.count })
    .from(usageCounters)
    .where(and(eq(usageCounters.householdId, householdId), eq(usageCounters.metric, metric), eq(usageCounters.period, period)))
    .limit(1);
  return row?.count ?? 0;
}

/** Add to a counter. `delta` may be negative to give a unit back; the count never goes below zero. */
export async function addUsage(householdId: string, metric: string, period: string, delta: number, db: Queryable = systemDb): Promise<number> {
  const result = await db.execute<{ count: number }>(sql`
    insert into usage_counters (household_id, metric, period, count)
    values (${householdId}, ${metric}, ${period}, greatest(${delta}::int, 0))
    on conflict (household_id, metric, period) do update
      set count = greatest(usage_counters.count + ${delta}::int, 0), updated_at = now()
    returning count
  `);
  return Number(result.rows[0]?.count ?? 0);
}

/** Active things in the kitchen, counted across everyone's items (including private ones). */
export async function countActiveItems(householdId: string, db: Queryable = systemDb): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.householdId, householdId), eq(inventoryItems.status, "active"), isNull(inventoryItems.deletedAt)));
  return row?.n ?? 0;
}

/** Everyone in the household, with or without an account. */
export async function countMembers(householdId: string, db: Queryable = systemDb): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(householdMembers)
    .where(eq(householdMembers.householdId, householdId));
  return row?.n ?? 0;
}
