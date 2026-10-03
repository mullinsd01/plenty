/**
 * Provider-neutral billing events and the state machine that applies them.
 *
 * Stripe, the App Store and Google Play each describe a subscription's life
 * differently. Their adapters (src/server/billing/providers) translate what
 * they receive into the small vocabulary below, and `applyBillingEvent`
 * turns a stored subscription plus one event into the next stored
 * subscription. Everything else — what plan is in force, what the household
 * can do — is decided from that state by `resolveEffectivePlan`.
 *
 * The reducer is pure and total over valid input, and built around the ways
 * money-adjacent webhooks go wrong:
 *
 *   - Replays are harmless: applying an event twice gives the same state.
 *   - Delivery order isn't guaranteed. An event older than the newest one
 *     already applied is ignored, because applying it could undo something
 *     newer (a late "payment failed" must not cancel a household that has
 *     since paid). The one exception is a late renewal, which may still push
 *     the paid-until date forward, and nothing else.
 *   - Events about an older period never touch a newer one: a late "expired"
 *     or a refund of last year's payment can't end this year's subscription.
 *   - A refunded or expired subscription is only revived by a *new paid
 *     period* (or a new subscription), never by a notification that merely
 *     arrives after it.
 *   - A timestamp from the future is clamped, so one bad clock can't freeze a
 *     subscription by making every later real event look stale.
 *
 * Nothing here touches the database, the clock or a provider SDK.
 */

import { planRank, type BillingPeriod, type PlanId } from "./plans";
import type { BillingProviderId, SubscriptionState, SubscriptionStatus } from "./subscription";

/** Plans that can be bought. `free` is the absence of a subscription. */
export type PaidPlanId = Exclude<PlanId, "free">;

interface EventBase {
  /** When it happened at the provider — not when we received it. */
  occurredAt: Date;
}

/** A new subscription began (or a lapsed one was bought again). */
export interface StartedEvent extends EventBase {
  type: "started";
  provider: BillingProviderId;
  plan: PaidPlanId;
  period: BillingPeriod | null;
  /** End of the first paid period (the trial's end, for a trial). Null when it has no end (operator grants). */
  currentPeriodEnd: Date | null;
  /** Set when the first period is a free trial. */
  trialEndsAt?: Date | null;
  /** Defaults to true. */
  autoRenew?: boolean;
}

/** A new paid period began. Also the moment a scheduled plan change takes effect. */
export interface RenewedEvent extends EventBase {
  type: "renewed";
  currentPeriodEnd: Date;
  /** What the new period is for. Without them, a scheduled change (if any) takes effect. */
  plan?: PaidPlanId;
  period?: BillingPeriod;
}

/** The paid-until date moved later without a payment (a gift or a store-granted extension). */
export interface PeriodExtendedEvent extends EventBase {
  type: "period_extended";
  currentPeriodEnd: Date;
}

/** The household turned off renewal: it keeps the plan until the period ends. */
export interface AutoRenewOffEvent extends EventBase {
  type: "auto_renew_off";
}

/** Renewal was turned back on before the period ended. */
export interface AutoRenewOnEvent extends EventBase {
  type: "auto_renew_on";
}

/** Access ended immediately, before the paid period would have. */
export interface CancelledNowEvent extends EventBase {
  type: "cancelled_now";
  /** The period this is about, so a late event for an older period can be told apart. */
  periodEnd?: Date | null;
}

/** A renewal payment failed. */
export interface PaymentFailedEvent extends EventBase {
  type: "payment_failed";
  /**
   * Access continues until then while the provider retries. `null` means no
   * grace (access stops). Left out, a default grace applies.
   */
  graceEndsAt?: Date | null;
  periodEnd?: Date | null;
}

/** A payment that had failed went through. */
export interface PaymentRecoveredEvent extends EventBase {
  type: "payment_recovered";
  /** The end of the period that payment covers, when the provider says. */
  currentPeriodEnd?: Date | null;
}

export interface PausedEvent extends EventBase {
  type: "paused";
}

export interface ResumedEvent extends EventBase {
  type: "resumed";
  currentPeriodEnd?: Date | null;
}

/** The subscription ended on its own: it wasn't renewed, or payment never recovered. */
export interface ExpiredEvent extends EventBase {
  type: "expired";
  periodEnd?: Date | null;
}

/** A payment was refunded, so the period it paid for is no longer granted. */
export interface RefundedEvent extends EventBase {
  type: "refunded";
  /** The end of the period that was refunded. Left out, the latest period is assumed. */
  periodEnd?: Date | null;
}

/** The provider took the entitlement back (a chargeback, or a store revoking a purchase). */
export interface RevokedEvent extends EventBase {
  type: "revoked";
  periodEnd?: Date | null;
}

/** A refund was undone, so the period is granted again. */
export interface RefundReversedEvent extends EventBase {
  type: "refund_reversed";
}

/**
 * The household moved to another plan or billing period. An upgrade takes
 * effect straight away; a downgrade, or a change of period alone, is
 * scheduled for the next renewal (`pendingPlan`/`pendingPeriod`) so the
 * household keeps what it paid for. A provider that reports a change as
 * already in force says so with `timing: "immediate"`.
 */
export interface PlanChangedEvent extends EventBase {
  type: "plan_changed";
  plan: PaidPlanId;
  period: BillingPeriod;
  timing?: "immediate" | "next_renewal";
  currentPeriodEnd?: Date | null;
}

/**
 * The provider's own account of the subscription at `occurredAt`. For
 * providers that describe state rather than transitions (Stripe's
 * subscription object, Google Play's subscription resource). Fields left
 * `undefined` keep what is stored; `null` means "none".
 */
export interface SnapshotEvent extends EventBase {
  type: "snapshot";
  provider: BillingProviderId;
  plan: PaidPlanId;
  period: BillingPeriod | null;
  status: Exclude<SubscriptionStatus, "refunded">;
  autoRenew: boolean;
  currentPeriodEnd?: Date | null;
  trialEndsAt?: Date | null;
  graceEndsAt?: Date | null;
  pendingPlan?: PlanId | null;
  pendingPeriod?: BillingPeriod | null;
}

export type BillingEvent =
  | StartedEvent
  | RenewedEvent
  | PeriodExtendedEvent
  | AutoRenewOffEvent
  | AutoRenewOnEvent
  | CancelledNowEvent
  | PaymentFailedEvent
  | PaymentRecoveredEvent
  | PausedEvent
  | ResumedEvent
  | ExpiredEvent
  | RefundedEvent
  | RevokedEvent
  | RefundReversedEvent
  | PlanChangedEvent
  | SnapshotEvent;

export type BillingEventType = BillingEvent["type"];

export const BILLING_EVENT_TYPES = [
  "started",
  "renewed",
  "period_extended",
  "auto_renew_off",
  "auto_renew_on",
  "cancelled_now",
  "payment_failed",
  "payment_recovered",
  "paused",
  "resumed",
  "expired",
  "refunded",
  "revoked",
  "refund_reversed",
  "plan_changed",
  "snapshot",
] as const satisfies readonly BillingEventType[];

/** How a provider's notification points at a household and subscription. */
export interface BillingLink {
  /** The provider's id for the subscription (Stripe subscription, Apple original transaction, Google purchase token). */
  providerSubscriptionId?: string | null;
  providerCustomerId?: string | null;
  providerProductId?: string | null;
  /**
   * Which household it is for. For provider notifications this is only a
   * hint (set when the purchase was made, so a forged one is no more than a
   * suggestion): an existing subscription link always wins. When
   * `householdVerified` it comes from the signed-in owner (a restore).
   */
  householdId?: string | null;
  householdVerified?: boolean;
  /** Google: the purchase this one replaces after a plan change. */
  replacesProviderSubscriptionId?: string | null;
  /** Who bought it, when known. */
  purchaserUserId?: string | null;
  /** The current period began (for the record). */
  currentPeriodStart?: Date | null;
}

/** What a provider adapter hands to `applyNormalizedEvent`. */
export interface NormalizedBillingEvent {
  provider: BillingProviderId;
  /** The provider's unique id for this delivery. With `provider`, the idempotency key. */
  eventId: string;
  /** The provider's own name for it ("customer.subscription.updated", "DID_RENEW"), for the audit trail. */
  providerType: string;
  link: BillingLink;
  /** What to apply; null when the notification needs no change (the reason is in `note`). */
  event: BillingEvent | null;
  /** Short and free of personal or payment details: stored in the audit trail. */
  note?: string;
}

export class BillingEventError extends Error {
  constructor(
    public readonly code: "no_subscription",
    message: string,
  ) {
    super(message);
    this.name = "BillingEventError";
  }
}

/** How long access continues after a failed payment when the provider doesn't say. */
export const DEFAULT_GRACE_MS = 3 * 24 * 3600_000;
/** An event stamped further ahead than this is treated as having happened now. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

function sameDate(a: Date | null | undefined, b: Date | null | undefined): boolean {
  return (a ?? null) === (b ?? null) || (a != null && b != null && a.getTime() === b.getTime());
}

function stateEquals(a: SubscriptionState, b: SubscriptionState): boolean {
  return (
    a.plan === b.plan &&
    a.period === b.period &&
    a.status === b.status &&
    a.provider === b.provider &&
    a.autoRenew === b.autoRenew &&
    sameDate(a.currentPeriodEnd, b.currentPeriodEnd) &&
    sameDate(a.trialEndsAt, b.trialEndsAt) &&
    sameDate(a.graceEndsAt, b.graceEndsAt) &&
    a.pendingPlan === b.pendingPlan &&
    a.pendingPeriod === b.pendingPeriod &&
    sameDate(a.lastEventAt, b.lastEventAt)
  );
}

/** Whether a stored status is an end state: only a new paid period (or a new subscription) leaves it. */
export function isTerminalStatus(status: SubscriptionStatus): boolean {
  return status === "expired" || status === "refunded";
}

/** The later of two optional dates. */
function laterDate(a: Date | null, b: Date | null | undefined): Date | null {
  if (!b) return a;
  if (!a) return b;
  return b.getTime() > a.getTime() ? b : a;
}

/** Whether `end` is a period beyond what we have: a *new* paid period, as opposed to a repeat of the old one. */
function extendsPast(end: Date | null | undefined, current: Date | null): boolean {
  if (!end) return false;
  return current === null || end.getTime() > current.getTime();
}

/** An event about a period older than the one we hold. */
function isOlderPeriod(periodEnd: Date | null | undefined, state: SubscriptionState): boolean {
  return !!periodEnd && !!state.currentPeriodEnd && periodEnd.getTime() < state.currentPeriodEnd.getTime();
}

/** The status of a subscription that is paid up and not in trouble: cancelling means "until the period ends". */
function paidStatus(autoRenew: boolean, end: Date | null): "active" | "canceled" {
  return !autoRenew && end !== null ? "canceled" : "active";
}

/** A cancelled subscription whose period is over can't be resumed. */
function hasEnded(state: SubscriptionState, at: Date): boolean {
  return state.status === "canceled" && state.currentPeriodEnd !== null && state.currentPeriodEnd.getTime() <= at.getTime();
}

function effectiveTime(occurredAt: Date, now: Date): Date {
  const t = occurredAt.getTime();
  if (Number.isNaN(t)) return now;
  return t > now.getTime() + MAX_CLOCK_SKEW_MS ? now : occurredAt;
}

function noSubscription(event: BillingEvent): never {
  throw new BillingEventError("no_subscription", `A "${event.type}" event arrived before the subscription it belongs to.`);
}

/** Whether an event can create a subscription from nothing. */
export function canStartSubscription(event: BillingEvent): boolean {
  return event.type === "started" || event.type === "snapshot";
}

/** Apply a change. An event that changes nothing returns `prev` itself and doesn't move the clock: it taught us nothing new. */
function commit(prev: SubscriptionState, patch: Partial<SubscriptionState>, at: Date): SubscriptionState {
  const changed: SubscriptionState = { ...prev, ...patch };
  if (stateEquals(prev, changed)) return prev;
  return { ...changed, lastEventAt: laterDate(prev.lastEventAt ?? null, at) };
}

/** A pending change that has been reached (or never differed) isn't pending. */
function reconcilePending(plan: PlanId, period: BillingPeriod | null, pendingPlan: PlanId | null, pendingPeriod: BillingPeriod | null) {
  if (pendingPlan === null) return { pendingPlan: null, pendingPeriod: null };
  const reached = plan === pendingPlan && (pendingPeriod === null || pendingPeriod === period);
  return reached ? { pendingPlan: null, pendingPeriod: null } : { pendingPlan, pendingPeriod };
}

/**
 * The next stored subscription after `event`.
 *
 * Returns `state` itself (the same object) when the event changes nothing —
 * a replay, a stale event, or one that doesn't apply — so callers can tell
 * "applied" from "ignored" with `===`. Throws `BillingEventError` when an
 * event needs a subscription that doesn't exist yet; the caller should retry
 * it later (the start may simply not have arrived).
 *
 * `now` is only used to refuse timestamps from the future.
 */
export function applyBillingEvent(state: SubscriptionState | null, event: BillingEvent, now: Date): SubscriptionState {
  const at = effectiveTime(event.occurredAt, now);

  if (state?.lastEventAt && at.getTime() < state.lastEventAt.getTime()) {
    // Older than something already applied: it can't be allowed to undo it. A late renewal can still
    // move the paid-until date forward, which is true whenever it arrives.
    if ((event.type === "renewed" || event.type === "period_extended") && !isTerminalStatus(state.status) && extendsPast(event.currentPeriodEnd, state.currentPeriodEnd)) {
      return commit(state, { currentPeriodEnd: event.currentPeriodEnd }, at);
    }
    return state;
  }

  switch (event.type) {
    case "started": {
      if (state && isTerminalStatus(state.status) && state.provider === event.provider && event.provider !== "manual" && !extendsPast(event.currentPeriodEnd, state.currentPeriodEnd)) {
        return state;
      }
      const trialEnd = event.trialEndsAt ?? null;
      const trialing = trialEnd !== null && trialEnd.getTime() > at.getTime();
      const autoRenew = event.autoRenew ?? true;
      const end = event.currentPeriodEnd ?? (trialing ? trialEnd : null);
      const started: SubscriptionState = {
        plan: event.plan,
        period: event.period,
        status: trialing ? "trialing" : paidStatus(autoRenew, end),
        provider: event.provider,
        autoRenew,
        currentPeriodEnd: end,
        trialEndsAt: trialEnd,
        graceEndsAt: null,
        pendingPlan: null,
        pendingPeriod: null,
        lastEventAt: at,
      };
      return state && stateEquals(state, started) ? state : started;
    }

    case "snapshot":
      return applySnapshot(state, event, at);

    case "renewed": {
      if (!state) return noSubscription(event);
      // Terminal states are only left by a period beyond the one they ended with; a renewal
      // that repeats the current period is a replay and changes nothing.
      if (!extendsPast(event.currentPeriodEnd, state.currentPeriodEnd)) return state;
      const plan = event.plan ?? state.pendingPlan ?? state.plan;
      const period = event.period ?? (event.plan ? state.period : (state.pendingPeriod ?? state.period));
      return commit(
        state,
        {
          plan,
          period,
          status: "active",
          autoRenew: true,
          currentPeriodEnd: event.currentPeriodEnd,
          graceEndsAt: null,
          ...reconcilePending(plan, period, state.pendingPlan, state.pendingPeriod),
        },
        at,
      );
    }

    case "period_extended": {
      if (!state) return noSubscription(event);
      if (isTerminalStatus(state.status) || !extendsPast(event.currentPeriodEnd, state.currentPeriodEnd)) return state;
      return commit(state, { currentPeriodEnd: event.currentPeriodEnd }, at);
    }

    case "auto_renew_off": {
      if (!state) return noSubscription(event);
      if (isTerminalStatus(state.status) || !state.autoRenew) return state;
      return commit(
        state,
        {
          autoRenew: false,
          status: state.status === "active" ? paidStatus(false, state.currentPeriodEnd) : state.status,
          // A change scheduled for the next renewal is moot when there won't be one.
          pendingPlan: null,
          pendingPeriod: null,
        },
        at,
      );
    }

    case "auto_renew_on": {
      if (!state) return noSubscription(event);
      if (isTerminalStatus(state.status) || state.autoRenew || hasEnded(state, at)) return state;
      return commit(state, { autoRenew: true, status: state.status === "canceled" ? "active" : state.status }, at);
    }

    case "payment_failed": {
      if (!state) return noSubscription(event);
      if (isTerminalStatus(state.status) || isOlderPeriod(event.periodEnd, state)) return state;
      // Nothing is being charged for a subscription that won't renew or is paused.
      if (state.status === "canceled" || state.status === "paused") return state;
      if (state.status === "past_due") {
        if (event.graceEndsAt === undefined) return state;
        // Retries of the same failure never stretch the grace period; the provider ending it (null) does shorten it.
        const grace = event.graceEndsAt === null ? null : state.graceEndsAt && state.graceEndsAt.getTime() < event.graceEndsAt.getTime() ? state.graceEndsAt : event.graceEndsAt;
        return commit(state, { graceEndsAt: grace }, at);
      }
      const grace = event.graceEndsAt === undefined ? new Date(at.getTime() + DEFAULT_GRACE_MS) : event.graceEndsAt;
      return commit(state, { status: "past_due", graceEndsAt: grace }, at);
    }

    case "payment_recovered": {
      if (!state) return noSubscription(event);
      if (isTerminalStatus(state.status)) {
        // Only a payment for a new period brings a refunded or expired subscription back.
        if (!extendsPast(event.currentPeriodEnd, state.currentPeriodEnd)) return state;
        return commit(state, { status: paidStatus(state.autoRenew, event.currentPeriodEnd ?? null), currentPeriodEnd: event.currentPeriodEnd, graceEndsAt: null }, at);
      }
      if (state.status === "paused") return state;
      const end = laterDate(state.currentPeriodEnd, event.currentPeriodEnd);
      if (state.status === "past_due") {
        return commit(state, { status: paidStatus(state.autoRenew, end), currentPeriodEnd: end, graceEndsAt: null }, at);
      }
      return commit(state, { currentPeriodEnd: end }, at);
    }

    case "paused": {
      if (!state) return noSubscription(event);
      if (isTerminalStatus(state.status) || state.status === "paused") return state;
      return commit(state, { status: "paused", graceEndsAt: null }, at);
    }

    case "resumed": {
      if (!state) return noSubscription(event);
      if (state.status !== "paused") {
        // Not paused (as far as we know), but the resume may carry a later paid-until date than we hold: keep that.
        if (isTerminalStatus(state.status) || !extendsPast(event.currentPeriodEnd, state.currentPeriodEnd)) return state;
        return commit(state, { currentPeriodEnd: event.currentPeriodEnd }, at);
      }
      const end = event.currentPeriodEnd ?? state.currentPeriodEnd;
      return commit(state, { status: paidStatus(state.autoRenew, end), currentPeriodEnd: end }, at);
    }

    case "expired": {
      if (!state) return noSubscription(event);
      if (isTerminalStatus(state.status) || isOlderPeriod(event.periodEnd, state)) return state;
      return commit(
        state,
        { status: "expired", autoRenew: false, graceEndsAt: null, pendingPlan: null, pendingPeriod: null, currentPeriodEnd: state.currentPeriodEnd ?? at },
        at,
      );
    }

    case "cancelled_now": {
      if (!state) return noSubscription(event);
      if (isTerminalStatus(state.status) || isOlderPeriod(event.periodEnd, state)) return state;
      const end = state.currentPeriodEnd === null || state.currentPeriodEnd.getTime() > at.getTime() ? at : state.currentPeriodEnd;
      return commit(
        state,
        { status: "expired", autoRenew: false, graceEndsAt: null, pendingPlan: null, pendingPeriod: null, currentPeriodEnd: end },
        at,
      );
    }

    case "refunded":
    case "revoked": {
      if (!state) return noSubscription(event);
      if (state.status === "refunded" || isOlderPeriod(event.periodEnd, state)) return state;
      return commit(state, { status: "refunded", graceEndsAt: null, pendingPlan: null, pendingPeriod: null }, at);
    }

    case "refund_reversed": {
      if (!state) return noSubscription(event);
      if (state.status !== "refunded") return state;
      return commit(state, { status: paidStatus(state.autoRenew, state.currentPeriodEnd) }, at);
    }

    case "plan_changed": {
      if (!state) return noSubscription(event);
      if (isTerminalStatus(state.status) || hasEnded(state, at)) return state;
      if (event.plan === state.plan && event.period === state.period) {
        // Back to what's already in force: any scheduled change is cancelled.
        return commit(state, { pendingPlan: null, pendingPeriod: null, currentPeriodEnd: laterDate(state.currentPeriodEnd, event.currentPeriodEnd) }, at);
      }
      const timing = event.timing ?? (planRank(event.plan) > planRank(state.plan) ? "immediate" : "next_renewal");
      if (timing === "immediate") {
        return commit(
          state,
          { plan: event.plan, period: event.period, pendingPlan: null, pendingPeriod: null, currentPeriodEnd: event.currentPeriodEnd ?? state.currentPeriodEnd },
          at,
        );
      }
      return commit(state, { pendingPlan: event.plan, pendingPeriod: event.period }, at);
    }
  }
}

function applySnapshot(state: SubscriptionState | null, event: SnapshotEvent, at: Date): SubscriptionState {
  const incomingTerminal = event.status === "expired";
  if (state && isTerminalStatus(state.status) && state.provider === event.provider && event.provider !== "manual") {
    // Once expired or refunded, only a new paid period brings it back, and a refund isn't softened to "expired".
    if (state.status === "refunded" && incomingTerminal) return state;
    if (!incomingTerminal && !extendsPast(event.currentPeriodEnd, state.currentPeriodEnd)) return state;
  }

  const end = event.currentPeriodEnd === undefined ? (state?.currentPeriodEnd ?? null) : event.currentPeriodEnd;
  let status: SubscriptionStatus = event.status;
  if (status === "active") status = paidStatus(event.autoRenew, end);
  if (status === "canceled" && end === null) status = "expired";

  let graceEndsAt: Date | null = null;
  if (status === "past_due") {
    if (event.graceEndsAt === null) graceEndsAt = null;
    else if (event.graceEndsAt === undefined) graceEndsAt = state?.status === "past_due" ? state.graceEndsAt : null;
    else if (state?.status === "past_due" && state.graceEndsAt && state.graceEndsAt.getTime() < event.graceEndsAt.getTime()) graceEndsAt = state.graceEndsAt;
    else graceEndsAt = event.graceEndsAt;
  }

  const wantedPlan = event.pendingPlan === undefined ? (state?.pendingPlan ?? null) : event.pendingPlan;
  const wantedPeriod = event.pendingPeriod === undefined ? (state?.pendingPeriod ?? null) : event.pendingPeriod;
  const pending = isTerminalStatus(status) ? { pendingPlan: null, pendingPeriod: null } : reconcilePending(event.plan, event.period, wantedPlan, wantedPeriod);

  const next: SubscriptionState = {
    plan: event.plan,
    period: event.period,
    status,
    provider: event.provider,
    autoRenew: status === "expired" ? false : event.autoRenew,
    currentPeriodEnd: end,
    trialEndsAt: event.trialEndsAt === undefined ? (state?.trialEndsAt ?? null) : event.trialEndsAt,
    graceEndsAt,
    ...pending,
    lastEventAt: laterDate(state?.lastEventAt ?? null, at),
  };
  return state && stateEquals(state, next) ? state : next;
}

/** A short description for the audit trail: what kind of event, and for which plan. Never personal or payment details. */
export function describeBillingEvent(event: BillingEvent): string {
  switch (event.type) {
    case "started":
      return `started ${event.plan}${event.period ? `/${event.period}` : ""}${event.trialEndsAt ? " (trial)" : ""}`;
    case "snapshot":
      return `snapshot ${event.plan}${event.period ? `/${event.period}` : ""} ${event.status}`;
    case "plan_changed":
      return `plan_changed ${event.plan}/${event.period}${event.timing ? ` ${event.timing}` : ""}`;
    case "renewed":
      return `renewed${event.plan ? ` ${event.plan}` : ""}`;
    default:
      return event.type;
  }
}
