import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  applyBillingEvent,
  BillingEventError,
  canStartSubscription,
  describeBillingEvent,
  isTerminalStatus,
  type NormalizedBillingEvent,
} from "@/lib/billing/events";
import { resolveEffectivePlan, type BillingProviderId, type SubscriptionState } from "@/lib/billing/subscription";
import { track } from "@/server/analytics";
import { systemDb, type Tx } from "@/server/db/client";
import { billingEvents, households, subscriptions, users, type DbSubscription } from "@/server/db/schema";
import { toSubscriptionState } from "./entitlements";
import { duplicateSubscriptionNotice, notifyOwners, paymentFailedNotice, type BillingNotice } from "./notify";

/**
 * Apply one normalised provider event to a household's subscription.
 *
 * This is the only place provider notifications change what a household has,
 * and it runs as trusted system code (the app role can't write these tables).
 * It is built so that a webhook can arrive twice, late, out of order or about
 * the wrong thing without harming anyone:
 *
 *   - Idempotent: each delivery is recorded in `billing_events` under
 *     (provider, event id), in the same transaction as its effect. A repeat
 *     finds it already processed and does nothing.
 *   - Serialised per household: events for one household are applied one at a
 *     time (an advisory lock), so state is always read after the previous one
 *     committed.
 *   - Linked by what we hold, not what we're told: the household comes from an
 *     existing subscription link first (the provider's subscription id), then
 *     the provider's customer id, and only then from a hint in the purchase.
 *     A hint can never move a subscription that is already linked.
 *   - One subscription per household: a second, different subscription never
 *     silently replaces one that is giving access (the household is told
 *     instead); a lapsed or refunded one is replaced by a new purchase.
 *   - Nothing is revoked on a guess: the state machine ignores stale events.
 *
 * Analytics and notifications happen after the transaction commits, so a
 * failure in either never undoes a payment.
 */

export type ApplyOutcome =
  /** The subscription changed. */
  | "applied"
  /** Processed, and nothing needed to change (informational, stale, or for a subscription that isn't the current one). */
  | "unchanged"
  /** This exact delivery was handled before. */
  | "duplicate"
  /** No household could be identified. Recorded; nothing applied. */
  | "unlinked"
  /** A restore for a subscription that already belongs to another household. Never moved. */
  | "linked_elsewhere"
  /** The household already has a different subscription that is giving access. Not applied; the owners are told. */
  | "conflict"
  /** The event arrived before the subscription it belongs to. Recorded unprocessed so the provider's redelivery is applied. */
  | "retry";

export interface ApplyResult {
  outcome: ApplyOutcome;
  householdId: string | null;
  before: SubscriptionState | null;
  after: SubscriptionState | null;
}

interface SideEffects {
  householdId: string;
  provider: BillingProviderId;
  purchaserUserId: string | null;
  after: SubscriptionState;
  started: boolean;
  cancelled: boolean;
  notices: BillingNotice[];
}

const PLATFORM: Record<BillingProviderId, "web" | "ios" | "android"> = { web: "web", apple: "ios", google: "android", manual: "web" };

const grants = (state: SubscriptionState | null, now: Date) => state !== null && resolveEffectivePlan(state, now).plan !== "free";

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function summarise(n: NormalizedBillingEvent): string {
  const what = n.event ? describeBillingEvent(n.event) : "no change";
  return `${what}${n.note ? `; ${n.note}` : ""}`.slice(0, 500);
}

/** What goes in the audit trail when handling fails: the kind of error, never the data involved. */
function safeError(err: unknown): string {
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  if (cause?.code) return `database error ${cause.code}`;
  const code = (err as { code?: string } | null)?.code;
  if (typeof code === "string") return `database error ${code}`;
  return `${err instanceof Error ? err.name : "Error"}: ${err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : "unknown"}`;
}

type Resolution =
  | { kind: "household"; householdId: string }
  | { kind: "unlinked" }
  | { kind: "linked_elsewhere"; householdId: string };

/** Which household an event is for. See the module comment for why the order matters. */
async function resolveHousehold(tx: Tx, n: NormalizedBillingEvent): Promise<Resolution> {
  const { link, provider } = n;

  const bySubscription = async (id: string | null | undefined) => {
    if (!id) return null;
    const [row] = await tx
      .select({ householdId: subscriptions.householdId })
      .from(subscriptions)
      .where(and(eq(subscriptions.provider, provider), eq(subscriptions.providerSubscriptionId, id)))
      .limit(1);
    return row?.householdId ?? null;
  };

  const owner = (await bySubscription(link.providerSubscriptionId)) ?? (await bySubscription(link.replacesProviderSubscriptionId));
  if (owner) {
    // A restore names the household it is for; a subscription linked to a different one is never moved.
    if (link.householdVerified && link.householdId && link.householdId !== owner) return { kind: "linked_elsewhere", householdId: owner };
    return { kind: "household", householdId: owner };
  }

  if (link.providerCustomerId) {
    const [row] = await tx
      .select({ householdId: subscriptions.householdId })
      .from(subscriptions)
      .where(and(eq(subscriptions.provider, provider), eq(subscriptions.providerCustomerId, link.providerCustomerId)))
      .limit(1);
    if (row) return { kind: "household", householdId: row.householdId };
  }

  if (link.householdId) {
    const [household] = await tx
      .select({ id: households.id })
      .from(households)
      .where(and(eq(households.id, link.householdId), isNull(households.deletedAt)))
      .limit(1);
    if (household) return { kind: "household", householdId: household.id };
  }
  return { kind: "unlinked" };
}

async function existingUserId(tx: Tx, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
  return row?.id ?? null;
}

async function markEvent(tx: Tx, id: string, values: { householdId?: string | null; processed: boolean; error?: string | null; summary?: string }, now: Date) {
  await tx
    .update(billingEvents)
    .set({
      ...(values.householdId !== undefined ? { householdId: values.householdId } : {}),
      processedAt: values.processed ? now : null,
      error: values.error ?? null,
      ...(values.summary !== undefined ? { summary: values.summary } : {}),
    })
    .where(eq(billingEvents.id, id));
}

/**
 * Apply `n`. Safe to call any number of times with the same event. Throws
 * only for unexpected failures (the caller should answer 5xx so the provider
 * delivers it again); everything expected is an `ApplyOutcome`.
 */
export async function applyNormalizedEvent(n: NormalizedBillingEvent, opts: { now?: Date } = {}): Promise<ApplyResult> {
  const now = opts.now ?? new Date();
  let committed: { result: ApplyResult; effects: SideEffects | null };
  try {
    committed = await systemDb.transaction((tx) => applyInTransaction(tx, n, now));
  } catch (err) {
    await recordFailure(n, err);
    throw err;
  }
  if (committed.effects) await runSideEffects(committed.effects);
  return committed.result;
}

async function applyInTransaction(tx: Tx, n: NormalizedBillingEvent, now: Date): Promise<{ result: ApplyResult; effects: SideEffects | null }> {
  const outcome = (o: ApplyOutcome, householdId: string | null, before: SubscriptionState | null = null, after: SubscriptionState | null = null, effects: SideEffects | null = null) => ({
    result: { outcome: o, householdId, before, after } satisfies ApplyResult,
    effects,
  });

  // 1. Record the delivery. A concurrent copy of the same event waits here for the first to commit, then sees it as processed.
  const inserted = await tx
    .insert(billingEvents)
    .values({ provider: n.provider, eventId: n.eventId, type: n.providerType.slice(0, 100), summary: summarise(n) })
    .onConflictDoNothing()
    .returning({ id: billingEvents.id });
  let eventRowId = inserted[0]?.id;
  if (!eventRowId) {
    const [existing] = await tx
      .select({ id: billingEvents.id, processedAt: billingEvents.processedAt })
      .from(billingEvents)
      .where(and(eq(billingEvents.provider, n.provider), eq(billingEvents.eventId, n.eventId)))
      .for("update")
      .limit(1);
    if (!existing) throw new Error("billing event vanished while being recorded");
    if (existing.processedAt) return outcome("duplicate", null);
    eventRowId = existing.id; // an earlier attempt failed, was unlinked or arrived early: handle it again
  }

  // 2. Which household?
  const resolution = await resolveHousehold(tx, n);
  if (resolution.kind === "unlinked") {
    await markEvent(tx, eventRowId, { processed: false, error: "no household could be identified for this event" }, now);
    return outcome("unlinked", null);
  }
  const householdId = resolution.householdId;
  if (resolution.kind === "linked_elsewhere") {
    await markEvent(tx, eventRowId, { householdId, processed: true, error: "subscription already belongs to another household" }, now);
    return outcome("linked_elsewhere", householdId);
  }

  // 3. Everything for one household happens one at a time, from here to commit.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${householdId}`}, 0))`);

  const event = n.event;
  const [row = null] = await tx.select().from(subscriptions).where(eq(subscriptions.householdId, householdId)).for("update").limit(1);
  const rowState = row ? toSubscriptionState(row) : null;

  if (!event) {
    await markEvent(tx, eventRowId, { householdId, processed: true }, now);
    return outcome("unchanged", householdId, rowState, rowState);
  }

  // 4. Is this the subscription we hold?
  const subId = n.link.providerSubscriptionId ?? null;
  const sameSubscription =
    row !== null && row.provider === n.provider && (subId === null || (row.providerSubscriptionId ?? null) === subId || (row.providerSubscriptionId === null && n.provider === "manual"));
  let base: SubscriptionState | null = rowState;
  let replacing = false;
  if (row && !sameSubscription) {
    const granting = grants(rowState, now);
    const replacesCurrent = n.link.replacesProviderSubscriptionId != null && row.provider === n.provider && row.providerSubscriptionId === n.link.replacesProviderSubscriptionId;
    if (replacesCurrent) {
      base = null; // a plan change that the store issues as a new purchase: it carries on from the old one
      replacing = true;
    } else if (!canStartSubscription(event)) {
      await markEvent(tx, eventRowId, { householdId, processed: true, summary: `${summarise(n)}; not the current subscription` }, now);
      return outcome("unchanged", householdId, rowState, rowState);
    } else if (!grants(applyBillingEvent(null, event, now), now)) {
      await markEvent(tx, eventRowId, { householdId, processed: true, summary: `${summarise(n)}; a different subscription that grants nothing` }, now);
      return outcome("unchanged", householdId, rowState, rowState);
    } else if (granting) {
      await markEvent(tx, eventRowId, { householdId, processed: true, error: `household already has a ${row.provider} subscription in force`, summary: summarise(n) }, now);
      const incomingKey = `${n.provider}:${subId ?? n.eventId}`.slice(0, 120);
      const effects: SideEffects = {
        householdId,
        provider: n.provider,
        purchaserUserId: null,
        after: rowState!,
        started: false,
        cancelled: false,
        notices: [duplicateSubscriptionNotice({ plan: rowState!.plan, existing: row.provider, incoming: n.provider, incomingKey })],
      };
      return outcome("conflict", householdId, rowState, rowState, effects);
    } else {
      base = null; // the old one has lapsed or been refunded: a new purchase takes its place
      replacing = true;
    }
  }

  // 5. The state machine decides.
  let next: SubscriptionState;
  try {
    next = applyBillingEvent(base, event, now);
  } catch (err) {
    if (err instanceof BillingEventError) {
      await markEvent(tx, eventRowId, { householdId, processed: false, error: "arrived before its subscription started" }, now);
      return outcome("retry", householdId, rowState, rowState);
    }
    throw err;
  }

  const summary = `${summarise(n)}; ${rowState?.status ?? "none"} -> ${next.status}`.slice(0, 500);
  if (next === base && !replacing) {
    await markEvent(tx, eventRowId, { householdId, processed: true, summary }, now);
    return outcome("unchanged", householdId, rowState, rowState);
  }

  // 6. Store it.
  const at = next.lastEventAt ?? now;
  const keep = !replacing && row !== null;
  const purchaserUserId = keep && row.purchaserUserId ? row.purchaserUserId : await existingUserId(tx, n.link.purchaserUserId);
  const values = {
    plan: next.plan,
    period: next.period,
    status: next.status,
    provider: next.provider,
    providerSubscriptionId: subId ?? (keep ? row.providerSubscriptionId : null),
    providerCustomerId: n.link.providerCustomerId ?? (keep ? row.providerCustomerId : null),
    providerProductId: n.link.providerProductId ?? (keep ? row.providerProductId : null),
    purchaserUserId,
    autoRenew: next.autoRenew,
    currentPeriodStart: n.link.currentPeriodStart && ["started", "renewed", "snapshot"].includes(event.type) ? n.link.currentPeriodStart : keep ? row.currentPeriodStart : null,
    currentPeriodEnd: next.currentPeriodEnd,
    trialEndsAt: next.trialEndsAt,
    graceEndsAt: next.graceEndsAt,
    canceledAt: next.autoRenew ? null : keep && !rowState?.autoRenew && row.canceledAt ? row.canceledAt : at,
    endedAt: isTerminalStatus(next.status) ? (keep && row.endedAt ? row.endedAt : at) : null,
    pendingPlan: next.pendingPlan,
    pendingPeriod: next.pendingPeriod,
    lastEventAt: next.lastEventAt ?? null,
    updatedAt: now,
  } satisfies Partial<DbSubscription>;
  if (row) await tx.update(subscriptions).set(values).where(eq(subscriptions.id, row.id));
  else await tx.insert(subscriptions).values({ householdId, ...values });
  await markEvent(tx, eventRowId, { householdId, processed: true, summary }, now);

  // 7. What to do after commit.
  const paidBefore = grants(rowState, now);
  const paidAfter = grants(next, now);
  const notices: BillingNotice[] = [];
  if (rowState?.status !== "past_due" && next.status === "past_due") {
    notices.push(paymentFailedNotice({ plan: next.plan, provider: next.provider, graceEndsAt: next.graceEndsAt, periodKey: isoDay(next.currentPeriodEnd ?? at), now }));
  }
  const effects: SideEffects = {
    householdId,
    provider: next.provider,
    purchaserUserId,
    after: next,
    // A start is a paid plan appearing from nothing (or from an ended subscription), not a recovery or a plan change.
    started: paidAfter && !paidBefore && (event.type === "started" || rowState === null || isTerminalStatus(rowState.status) || replacing),
    // Cancelled once: when renewal is turned off (or access is ended early) on a subscription that was giving access.
    cancelled: paidBefore && ((rowState?.autoRenew === true && !next.autoRenew && !isTerminalStatus(next.status)) || event.type === "cancelled_now"),
    notices,
  };
  return outcome("applied", householdId, rowState, next, effects);
}

async function runSideEffects(effects: SideEffects): Promise<void> {
  const { after, provider } = effects;
  // Operator grants aren't sales, and only launched plans are in the analytics vocabulary.
  if (provider !== "manual" && (after.plan === "plus" || after.plan === "family")) {
    const ctx = { householdId: effects.householdId, userId: effects.purchaserUserId, plan: after.plan, platform: PLATFORM[provider] } as const;
    if (effects.started) await track("subscription_started", ctx, { plan: after.plan, provider, ...(after.period ? { period: after.period } : {}) });
    if (effects.cancelled) await track("subscription_cancelled", ctx, { plan: after.plan, provider });
  }
  for (const notice of effects.notices) {
    try {
      await notifyOwners(systemDb, effects.householdId, notice);
    } catch (err) {
      console.error("[billing] couldn't notify owners:", err instanceof Error ? err.name : "error");
    }
  }
}

/** Leave a trace of an event we couldn't handle, so it can be found and replayed. Never throws. */
async function recordFailure(n: NormalizedBillingEvent, err: unknown): Promise<void> {
  try {
    const error = safeError(err);
    await systemDb
      .insert(billingEvents)
      .values({ provider: n.provider, eventId: n.eventId, type: n.providerType.slice(0, 100), summary: summarise(n), error })
      .onConflictDoUpdate({ target: [billingEvents.provider, billingEvents.eventId], set: { error }, setWhere: isNull(billingEvents.processedAt) });
  } catch (inner) {
    console.error("[billing] couldn't record a failed event:", inner instanceof Error ? inner.name : "error");
  }
}
