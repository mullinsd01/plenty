import { describe, expect, it } from "vitest";
import {
  applyBillingEvent,
  BILLING_EVENT_TYPES,
  BillingEventError,
  canStartSubscription,
  DEFAULT_GRACE_MS,
  describeBillingEvent,
  isTerminalStatus,
  MAX_CLOCK_SKEW_MS,
  type BillingEvent,
} from "@/lib/billing/events";
import { resolveEffectivePlan, type SubscriptionState } from "@/lib/billing/subscription";

/**
 * The billing state machine, event by event. Times are days after a fixed
 * start so the cases read as a timeline; `NOW` is later than every event so
 * nothing is mistaken for a clock from the future (that has its own tests).
 */

const DAY = 86_400_000;
const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const day = (n: number) => new Date(T0 + n * DAY);
const NOW = day(1000);

const sub = (overrides: Partial<SubscriptionState> = {}): SubscriptionState => ({
  plan: "plus",
  period: "monthly",
  status: "active",
  provider: "web",
  autoRenew: true,
  currentPeriodEnd: day(30),
  trialEndsAt: null,
  graceEndsAt: null,
  pendingPlan: null,
  pendingPeriod: null,
  lastEventAt: day(0),
  ...overrides,
});

const apply = (state: SubscriptionState | null, event: BillingEvent, now = NOW) => applyBillingEvent(state, event, now);

const started = (over: Partial<Extract<BillingEvent, { type: "started" }>> = {}): BillingEvent => ({
  type: "started",
  occurredAt: day(0),
  provider: "web",
  plan: "plus",
  period: "monthly",
  currentPeriodEnd: day(30),
  ...over,
});

describe("started", () => {
  it("begins a monthly subscription", () => {
    const next = apply(null, started());
    expect(next).toEqual({
      plan: "plus",
      period: "monthly",
      status: "active",
      provider: "web",
      autoRenew: true,
      currentPeriodEnd: day(30),
      trialEndsAt: null,
      graceEndsAt: null,
      pendingPlan: null,
      pendingPeriod: null,
      lastEventAt: day(0),
    });
  });

  it("begins an annual family subscription on the App Store", () => {
    const next = apply(null, started({ provider: "apple", plan: "family", period: "annual", currentPeriodEnd: day(365) }));
    expect(next).toMatchObject({ plan: "family", period: "annual", provider: "apple", status: "active", currentPeriodEnd: day(365) });
  });

  it("starts a trial: trialing until the trial ends, which is also the end of the first period", () => {
    const next = apply(null, started({ currentPeriodEnd: null, trialEndsAt: day(7) }));
    expect(next).toMatchObject({ status: "trialing", trialEndsAt: day(7), currentPeriodEnd: day(7), autoRenew: true });
    expect(resolveEffectivePlan(next, day(3)).reason).toBe("trial");
  });

  it("a trial that had already ended when the event happened is simply active", () => {
    const next = apply(null, started({ occurredAt: day(10), trialEndsAt: day(7), currentPeriodEnd: day(40) }));
    expect(next.status).toBe("active");
  });

  it("a subscription started with renewal off is cancelled-until-the-end from the start", () => {
    const next = apply(null, started({ autoRenew: false }));
    expect(next).toMatchObject({ status: "canceled", autoRenew: false, currentPeriodEnd: day(30) });
  });

  it("an operator grant with no end and no renewal stays active", () => {
    const next = apply(null, started({ provider: "manual", period: null, currentPeriodEnd: null, autoRenew: false }));
    expect(next).toMatchObject({ status: "active", autoRenew: false, currentPeriodEnd: null, period: null });
  });

  it("is idempotent: the same event again is the same state (and the same object)", () => {
    const once = apply(null, started());
    expect(apply(once, started())).toBe(once);
  });

  it("resubscribing after expiry starts afresh: later period, no leftovers", () => {
    const expired = sub({ status: "expired", autoRenew: false, currentPeriodEnd: day(30), graceEndsAt: null, pendingPlan: "free", lastEventAt: day(31) });
    const next = apply(expired, started({ occurredAt: day(60), currentPeriodEnd: day(90), plan: "family" }));
    expect(next).toMatchObject({ status: "active", plan: "family", autoRenew: true, currentPeriodEnd: day(90), pendingPlan: null, lastEventAt: day(60) });
  });

  it("resubscribing through another provider is a new subscription, not a revival of the old one", () => {
    const refunded = sub({ status: "refunded", currentPeriodEnd: day(30), lastEventAt: day(5) });
    const next = apply(refunded, started({ provider: "apple", occurredAt: day(6), currentPeriodEnd: day(20) }));
    expect(next).toMatchObject({ status: "active", provider: "apple", currentPeriodEnd: day(20) });
  });

  it("a replayed start for the same refunded or expired subscription does not bring it back", () => {
    const refunded = sub({ status: "refunded", currentPeriodEnd: day(30), lastEventAt: day(5) });
    // Same provider, same period, and a timestamp that isn't older: still the period that was refunded.
    expect(apply(refunded, started({ occurredAt: day(5) }))).toBe(refunded);
    const expired = sub({ status: "expired", currentPeriodEnd: day(30), lastEventAt: day(31) });
    expect(apply(expired, started({ occurredAt: day(31) }))).toBe(expired);
  });

  it("an operator can grant a plan to a household whose own subscription was refunded", () => {
    const refunded = sub({ provider: "manual", status: "refunded", currentPeriodEnd: null, lastEventAt: day(5) });
    const next = apply(refunded, started({ provider: "manual", period: null, currentPeriodEnd: null, autoRenew: false, occurredAt: day(6) }));
    expect(next.status).toBe("active");
  });
});

describe("renewed", () => {
  it("begins the next paid period", () => {
    const next = apply(sub(), { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60) });
    expect(next).toMatchObject({ status: "active", currentPeriodEnd: day(60), autoRenew: true, lastEventAt: day(30) });
  });

  it("is idempotent, and a repeat is the same object", () => {
    const event: BillingEvent = { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60) };
    const once = apply(sub(), event);
    expect(apply(once, event)).toBe(once);
  });

  it("a renewal that repeats or precedes the current period changes nothing", () => {
    const s = sub({ currentPeriodEnd: day(60), lastEventAt: day(30) });
    expect(apply(s, { type: "renewed", occurredAt: day(31), currentPeriodEnd: day(60) })).toBe(s);
    expect(apply(s, { type: "renewed", occurredAt: day(31), currentPeriodEnd: day(30) })).toBe(s);
  });

  it("recovers a household in its grace period and clears the grace", () => {
    const s = sub({ status: "past_due", graceEndsAt: day(37), lastEventAt: day(30) });
    const next = apply(s, { type: "renewed", occurredAt: day(33), currentPeriodEnd: day(60) });
    expect(next).toMatchObject({ status: "active", graceEndsAt: null, currentPeriodEnd: day(60) });
  });

  it("renewal after renewal-off means it renewed: back to active and renewing", () => {
    const s = sub({ status: "canceled", autoRenew: false, lastEventAt: day(10) });
    const next = apply(s, { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60) });
    expect(next).toMatchObject({ status: "active", autoRenew: true });
  });

  it("takes a scheduled downgrade into effect when the renewal carries no plan", () => {
    const s = sub({ plan: "family", period: "annual", pendingPlan: "plus", pendingPeriod: "monthly" });
    const next = apply(s, { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60) });
    expect(next).toMatchObject({ plan: "plus", period: "monthly", pendingPlan: null, pendingPeriod: null });
  });

  it("uses the plan the renewal names, and clears the pending change it fulfils", () => {
    const s = sub({ plan: "family", pendingPlan: "plus", pendingPeriod: "monthly" });
    const next = apply(s, { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60), plan: "plus", period: "monthly" });
    expect(next).toMatchObject({ plan: "plus", period: "monthly", pendingPlan: null });
  });

  it("keeps a pending change the renewal didn't fulfil", () => {
    const s = sub({ plan: "family", pendingPlan: "plus", pendingPeriod: "monthly" });
    const next = apply(s, { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60), plan: "family", period: "monthly" });
    expect(next).toMatchObject({ plan: "family", pendingPlan: "plus", pendingPeriod: "monthly" });
  });

  it("brings an expired subscription back only for a period beyond the one that ended", () => {
    const expired = sub({ status: "expired", autoRenew: false, currentPeriodEnd: day(30), lastEventAt: day(31) });
    expect(apply(expired, { type: "renewed", occurredAt: day(32), currentPeriodEnd: day(30) })).toBe(expired);
    expect(apply(expired, { type: "renewed", occurredAt: day(32), currentPeriodEnd: day(62) })).toMatchObject({ status: "active", currentPeriodEnd: day(62) });
  });

  it("never revives a refunded period, but a later paid one is real money", () => {
    const refunded = sub({ status: "refunded", currentPeriodEnd: day(30), lastEventAt: day(31) });
    expect(apply(refunded, { type: "renewed", occurredAt: day(32), currentPeriodEnd: day(30) })).toBe(refunded);
    expect(apply(refunded, { type: "renewed", occurredAt: day(60), currentPeriodEnd: day(90) }).status).toBe("active");
  });

  it("needs a subscription to renew", () => {
    expect(() => apply(null, { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60) })).toThrow(BillingEventError);
  });
});

describe("period_extended", () => {
  it("moves the paid-until date later without touching anything else", () => {
    const s = sub({ status: "canceled", autoRenew: false });
    const next = apply(s, { type: "period_extended", occurredAt: day(10), currentPeriodEnd: day(45) });
    expect(next).toMatchObject({ status: "canceled", autoRenew: false, currentPeriodEnd: day(45) });
  });

  it("never shortens, and never revives an ended subscription", () => {
    const s = sub();
    expect(apply(s, { type: "period_extended", occurredAt: day(10), currentPeriodEnd: day(20) })).toBe(s);
    const expired = sub({ status: "expired" });
    expect(apply(expired, { type: "period_extended", occurredAt: day(40), currentPeriodEnd: day(90) })).toBe(expired);
  });
});

describe("auto-renew off and on", () => {
  it("turning renewal off keeps the plan until the period ends", () => {
    const next = apply(sub(), { type: "auto_renew_off", occurredAt: day(10) });
    expect(next).toMatchObject({ status: "canceled", autoRenew: false, currentPeriodEnd: day(30), plan: "plus" });
    expect(resolveEffectivePlan(next, day(20))).toMatchObject({ plan: "plus", reason: "cancelled_until_period_end", willRenew: false });
    expect(resolveEffectivePlan(next, day(31)).plan).toBe("free");
  });

  it("clears a change that was scheduled for a renewal that won't happen", () => {
    const next = apply(sub({ plan: "family", pendingPlan: "plus", pendingPeriod: "monthly" }), { type: "auto_renew_off", occurredAt: day(10) });
    expect(next).toMatchObject({ pendingPlan: null, pendingPeriod: null });
  });

  it("is idempotent", () => {
    const off = apply(sub(), { type: "auto_renew_off", occurredAt: day(10) });
    expect(apply(off, { type: "auto_renew_off", occurredAt: day(10) })).toBe(off);
  });

  it("a trial that won't convert stays a trial until it ends", () => {
    const trial = sub({ status: "trialing", trialEndsAt: day(7), currentPeriodEnd: day(7) });
    const next = apply(trial, { type: "auto_renew_off", occurredAt: day(2) });
    expect(next).toMatchObject({ status: "trialing", autoRenew: false });
    expect(resolveEffectivePlan(next, day(3)).plan).toBe("plus");
    expect(resolveEffectivePlan(next, day(8)).plan).toBe("free");
  });

  it("with no known end date it can't promise 'until the period ends', so it stays active", () => {
    const next = apply(sub({ currentPeriodEnd: null }), { type: "auto_renew_off", occurredAt: day(10) });
    expect(next).toMatchObject({ status: "active", autoRenew: false });
  });

  it("does nothing to an expired or refunded subscription", () => {
    for (const status of ["expired", "refunded"] as const) {
      const s = sub({ status, autoRenew: false });
      expect(apply(s, { type: "auto_renew_off", occurredAt: day(40) })).toBe(s);
      expect(apply(s, { type: "auto_renew_on", occurredAt: day(40) })).toBe(s);
    }
  });

  it("turning renewal back on before the end resumes it", () => {
    const off = apply(sub(), { type: "auto_renew_off", occurredAt: day(10) });
    const next = apply(off, { type: "auto_renew_on", occurredAt: day(12) });
    expect(next).toMatchObject({ status: "active", autoRenew: true, currentPeriodEnd: day(30) });
  });

  it("can't resume a cancelled subscription whose period is already over", () => {
    const ended = sub({ status: "canceled", autoRenew: false, currentPeriodEnd: day(30), lastEventAt: day(10) });
    expect(apply(ended, { type: "auto_renew_on", occurredAt: day(31) })).toBe(ended);
  });

  it("renewal on for a subscription that is already renewing changes nothing", () => {
    const s = sub();
    expect(apply(s, { type: "auto_renew_on", occurredAt: day(5) })).toBe(s);
  });

  it("need a subscription", () => {
    expect(() => apply(null, { type: "auto_renew_off", occurredAt: day(1) })).toThrow(BillingEventError);
    expect(() => apply(null, { type: "auto_renew_on", occurredAt: day(1) })).toThrow(BillingEventError);
  });
});

describe("payment failed and recovered", () => {
  it("a failed renewal puts the household in its grace period, with access until it ends", () => {
    const next = apply(sub({ lastEventAt: day(0) }), { type: "payment_failed", occurredAt: day(30), graceEndsAt: day(37), periodEnd: day(30) });
    expect(next).toMatchObject({ status: "past_due", graceEndsAt: day(37) });
    expect(resolveEffectivePlan(next, day(33))).toMatchObject({ plan: "plus", reason: "grace_period", needsPaymentAttention: true });
    expect(resolveEffectivePlan(next, day(38))).toMatchObject({ plan: "free", reason: "payment_failed", needsPaymentAttention: true });
  });

  it("uses a default grace period when the provider doesn't say", () => {
    const next = apply(sub(), { type: "payment_failed", occurredAt: day(30) });
    expect(next.graceEndsAt).toEqual(new Date(day(30).getTime() + DEFAULT_GRACE_MS));
  });

  it("no grace at all when the provider says so (billing retry without access)", () => {
    const next = apply(sub(), { type: "payment_failed", occurredAt: day(30), graceEndsAt: null });
    expect(next).toMatchObject({ status: "past_due", graceEndsAt: null });
  });

  it("paid-for time is never taken back early because a later payment failed", () => {
    // A failure partway through a paid period (say a proration invoice) doesn't end the period already paid.
    const next = apply(sub({ currentPeriodEnd: day(30) }), { type: "payment_failed", occurredAt: day(10), graceEndsAt: null, periodEnd: day(30) });
    expect(resolveEffectivePlan(next, day(20)).plan).toBe("plus");
    expect(resolveEffectivePlan(next, day(31)).plan).toBe("free");
  });

  it("retries of the same failure never stretch the grace period", () => {
    const first = apply(sub(), { type: "payment_failed", occurredAt: day(30), graceEndsAt: day(37) });
    const retry = apply(first, { type: "payment_failed", occurredAt: day(32), graceEndsAt: day(39) });
    expect(retry.graceEndsAt).toEqual(day(37));
  });

  it("the provider can end the grace period early", () => {
    const first = apply(sub(), { type: "payment_failed", occurredAt: day(30), graceEndsAt: day(37) });
    const ended = apply(first, { type: "payment_failed", occurredAt: day(34), graceEndsAt: null });
    expect(ended).toMatchObject({ status: "past_due", graceEndsAt: null });
    expect(resolveEffectivePlan(ended, day(35)).plan).toBe("free");
  });

  it("a failure notice with no grace information doesn't change a grace already in place", () => {
    const first = apply(sub(), { type: "payment_failed", occurredAt: day(30), graceEndsAt: day(37) });
    expect(apply(first, { type: "payment_failed", occurredAt: day(31) })).toBe(first);
  });

  it("a failed first payment after the trial puts the household in grace too", () => {
    const trial = sub({ status: "trialing", trialEndsAt: day(7), currentPeriodEnd: day(7) });
    expect(apply(trial, { type: "payment_failed", occurredAt: day(7), graceEndsAt: day(10) }).status).toBe("past_due");
  });

  it("nothing is charged to a subscription that won't renew or is paused, so a failure doesn't apply", () => {
    for (const status of ["canceled", "paused"] as const) {
      const s = sub({ status, autoRenew: status === "paused" });
      expect(apply(s, { type: "payment_failed", occurredAt: day(30) })).toBe(s);
    }
  });

  it("ignores a failure for a period older than the one held, and for ended subscriptions", () => {
    const renewed = sub({ currentPeriodEnd: day(60), lastEventAt: day(30) });
    expect(apply(renewed, { type: "payment_failed", occurredAt: day(31), periodEnd: day(30) })).toBe(renewed);
    const expired = sub({ status: "expired" });
    expect(apply(expired, { type: "payment_failed", occurredAt: day(40) })).toBe(expired);
  });

  it("recovery returns to active, clears the grace and takes the new period", () => {
    const failed = sub({ status: "past_due", graceEndsAt: day(37), lastEventAt: day(30) });
    const next = apply(failed, { type: "payment_recovered", occurredAt: day(33), currentPeriodEnd: day(60) });
    expect(next).toMatchObject({ status: "active", graceEndsAt: null, currentPeriodEnd: day(60) });
  });

  it("recovery on a household that has since turned renewal off lands on cancelled-until-the-end", () => {
    const failed = sub({ status: "past_due", autoRenew: false, graceEndsAt: day(37), lastEventAt: day(30) });
    const next = apply(failed, { type: "payment_recovered", occurredAt: day(33), currentPeriodEnd: day(60) });
    expect(next).toMatchObject({ status: "canceled", autoRenew: false, graceEndsAt: null });
  });

  it("a payment on a healthy subscription only extends the paid-until date", () => {
    const s = sub();
    expect(apply(s, { type: "payment_recovered", occurredAt: day(5), currentPeriodEnd: day(20) })).toBe(s);
    expect(apply(s, { type: "payment_recovered", occurredAt: day(5), currentPeriodEnd: day(60) })).toMatchObject({ status: "active", currentPeriodEnd: day(60) });
  });

  it("a paused subscription stays paused", () => {
    const paused = sub({ status: "paused" });
    expect(apply(paused, { type: "payment_recovered", occurredAt: day(5), currentPeriodEnd: day(60) })).toBe(paused);
  });

  it("after expiry or refund only a payment for a new period counts", () => {
    for (const status of ["expired", "refunded"] as const) {
      const s = sub({ status, currentPeriodEnd: day(30), lastEventAt: day(31) });
      expect(apply(s, { type: "payment_recovered", occurredAt: day(32), currentPeriodEnd: day(30) })).toBe(s);
      expect(apply(s, { type: "payment_recovered", occurredAt: day(32), currentPeriodEnd: day(60) }).status).toBe("active");
    }
  });

  it("recovery and failure both need a subscription", () => {
    expect(() => apply(null, { type: "payment_failed", occurredAt: day(1) })).toThrow(BillingEventError);
    expect(() => apply(null, { type: "payment_recovered", occurredAt: day(1) })).toThrow(BillingEventError);
  });
});

describe("paused and resumed", () => {
  it("pausing stops the plan; resuming gives it back", () => {
    const paused = apply(sub(), { type: "paused", occurredAt: day(10) });
    expect(paused.status).toBe("paused");
    expect(resolveEffectivePlan(paused, day(11))).toMatchObject({ plan: "free", reason: "paused" });
    const resumed = apply(paused, { type: "resumed", occurredAt: day(20), currentPeriodEnd: day(50) });
    expect(resumed).toMatchObject({ status: "active", currentPeriodEnd: day(50) });
  });

  it("is idempotent", () => {
    const paused = apply(sub(), { type: "paused", occurredAt: day(10) });
    expect(apply(paused, { type: "paused", occurredAt: day(10) })).toBe(paused);
    const resumed = apply(paused, { type: "resumed", occurredAt: day(20) });
    expect(apply(resumed, { type: "resumed", occurredAt: day(20) })).toBe(resumed);
  });

  it("resuming a subscription that wasn't paused does nothing", () => {
    const s = sub();
    expect(apply(s, { type: "resumed", occurredAt: day(5) })).toBe(s);
  });

  it("pausing something that has ended does nothing", () => {
    const s = sub({ status: "expired" });
    expect(apply(s, { type: "paused", occurredAt: day(40) })).toBe(s);
  });

  it("resuming a subscription whose renewal is off lands on cancelled-until-the-end", () => {
    const paused = sub({ status: "paused", autoRenew: false });
    expect(apply(paused, { type: "resumed", occurredAt: day(20) }).status).toBe("canceled");
  });

  it("need a subscription", () => {
    expect(() => apply(null, { type: "paused", occurredAt: day(1) })).toThrow(BillingEventError);
    expect(() => apply(null, { type: "resumed", occurredAt: day(1) })).toThrow(BillingEventError);
  });
});

describe("expired and cancelled now", () => {
  it("expiry ends the plan, keeping the end date as a record", () => {
    const next = apply(sub(), { type: "expired", occurredAt: day(30), periodEnd: day(30) });
    expect(next).toMatchObject({ status: "expired", autoRenew: false, currentPeriodEnd: day(30), graceEndsAt: null, pendingPlan: null });
    expect(resolveEffectivePlan(next, day(31))).toMatchObject({ plan: "free", reason: "ended" });
  });

  it("expiry after a failed payment ends the grace period too", () => {
    const failed = sub({ status: "past_due", graceEndsAt: day(37), lastEventAt: day(30) });
    expect(apply(failed, { type: "expired", occurredAt: day(37) })).toMatchObject({ status: "expired", graceEndsAt: null });
  });

  it("is idempotent", () => {
    const once = apply(sub(), { type: "expired", occurredAt: day(30) });
    expect(apply(once, { type: "expired", occurredAt: day(30) })).toBe(once);
  });

  it("an expiry for an older period never ends a newer one", () => {
    const renewed = sub({ currentPeriodEnd: day(60), lastEventAt: day(30) });
    expect(apply(renewed, { type: "expired", occurredAt: day(31), periodEnd: day(30) })).toBe(renewed);
  });

  it("a refunded subscription stays refunded when it later expires", () => {
    const refunded = sub({ status: "refunded" });
    expect(apply(refunded, { type: "expired", occurredAt: day(40) })).toBe(refunded);
  });

  it("cancelling now ends access at that moment, not at the old end date", () => {
    const next = apply(sub(), { type: "cancelled_now", occurredAt: day(10) });
    expect(next).toMatchObject({ status: "expired", autoRenew: false, currentPeriodEnd: day(10) });
    expect(resolveEffectivePlan(next, day(11)).plan).toBe("free");
  });

  it("cancelling now after the period ended keeps the real end", () => {
    const next = apply(sub({ currentPeriodEnd: day(30) }), { type: "cancelled_now", occurredAt: day(35) });
    expect(next.currentPeriodEnd).toEqual(day(30));
  });

  it("cancelling now with no known end records when it ended", () => {
    expect(apply(sub({ currentPeriodEnd: null }), { type: "cancelled_now", occurredAt: day(10) }).currentPeriodEnd).toEqual(day(10));
  });

  it("cancelling now is idempotent and respects the period it was about", () => {
    const once = apply(sub(), { type: "cancelled_now", occurredAt: day(10) });
    expect(apply(once, { type: "cancelled_now", occurredAt: day(10) })).toBe(once);
    const renewed = sub({ currentPeriodEnd: day(60), lastEventAt: day(30) });
    expect(apply(renewed, { type: "cancelled_now", occurredAt: day(31), periodEnd: day(30) })).toBe(renewed);
  });

  it("need a subscription", () => {
    expect(() => apply(null, { type: "expired", occurredAt: day(1) })).toThrow(BillingEventError);
    expect(() => apply(null, { type: "cancelled_now", occurredAt: day(1) })).toThrow(BillingEventError);
  });
});

describe("refunded and revoked", () => {
  it("a refund takes the plan away at once, even mid-period", () => {
    const next = apply(sub(), { type: "refunded", occurredAt: day(5) });
    expect(next.status).toBe("refunded");
    expect(resolveEffectivePlan(next, day(6))).toMatchObject({ plan: "free", reason: "refunded" });
  });

  it("revoking does the same", () => {
    expect(apply(sub(), { type: "revoked", occurredAt: day(5) }).status).toBe("refunded");
  });

  it("clears grace and pending changes", () => {
    const s = sub({ status: "past_due", graceEndsAt: day(37), pendingPlan: "plus", pendingPeriod: "annual" });
    expect(apply(s, { type: "refunded", occurredAt: day(33) })).toMatchObject({ graceEndsAt: null, pendingPlan: null, pendingPeriod: null });
  });

  it("is idempotent", () => {
    const once = apply(sub(), { type: "refunded", occurredAt: day(5) });
    expect(apply(once, { type: "refunded", occurredAt: day(5) })).toBe(once);
    expect(apply(once, { type: "revoked", occurredAt: day(6) })).toBe(once);
  });

  it("refunding last period's payment doesn't take away this period", () => {
    const renewed = sub({ currentPeriodEnd: day(60), lastEventAt: day(30) });
    expect(apply(renewed, { type: "refunded", occurredAt: day(40), periodEnd: day(30) })).toBe(renewed);
    expect(apply(renewed, { type: "refunded", occurredAt: day(40), periodEnd: day(60) }).status).toBe("refunded");
  });

  it("an expired subscription that is then refunded is recorded as refunded", () => {
    const expired = sub({ status: "expired" });
    expect(apply(expired, { type: "refunded", occurredAt: day(40) }).status).toBe("refunded");
  });

  it("a reversed refund restores the period", () => {
    const refunded = apply(sub(), { type: "refunded", occurredAt: day(5) });
    expect(apply(refunded, { type: "refund_reversed", occurredAt: day(6) })).toMatchObject({ status: "active", currentPeriodEnd: day(30) });
    const off = apply(sub({ autoRenew: false, status: "canceled" }), { type: "refunded", occurredAt: day(5) });
    expect(apply(off, { type: "refund_reversed", occurredAt: day(6) }).status).toBe("canceled");
  });

  it("a reversal of something that wasn't refunded does nothing", () => {
    const s = sub();
    expect(apply(s, { type: "refund_reversed", occurredAt: day(6) })).toBe(s);
  });

  it("need a subscription", () => {
    expect(() => apply(null, { type: "refunded", occurredAt: day(1) })).toThrow(BillingEventError);
    expect(() => apply(null, { type: "revoked", occurredAt: day(1) })).toThrow(BillingEventError);
    expect(() => apply(null, { type: "refund_reversed", occurredAt: day(1) })).toThrow(BillingEventError);
  });
});

describe("plan changes", () => {
  it("an upgrade takes effect immediately", () => {
    const next = apply(sub(), { type: "plan_changed", occurredAt: day(10), plan: "family", period: "monthly" });
    expect(next).toMatchObject({ plan: "family", period: "monthly", pendingPlan: null, pendingPeriod: null });
    expect(resolveEffectivePlan(next, day(11)).plan).toBe("family");
  });

  it("an upgrade can start a new period", () => {
    const next = apply(sub(), { type: "plan_changed", occurredAt: day(10), plan: "family", period: "annual", currentPeriodEnd: day(375) });
    expect(next).toMatchObject({ plan: "family", period: "annual", currentPeriodEnd: day(375) });
  });

  it("a downgrade is scheduled for the next renewal; the household keeps what it paid for", () => {
    const s = sub({ plan: "family", period: "monthly" });
    const next = apply(s, { type: "plan_changed", occurredAt: day(10), plan: "plus", period: "monthly" });
    expect(next).toMatchObject({ plan: "family", pendingPlan: "plus", pendingPeriod: "monthly" });
    const effective = resolveEffectivePlan(next, day(11));
    expect(effective.plan).toBe("family");
    expect(effective.pendingChange).toEqual({ plan: "plus", period: "monthly" });
  });

  it("a change of billing period alone is scheduled too, in either direction", () => {
    const toAnnual = apply(sub({ period: "monthly" }), { type: "plan_changed", occurredAt: day(10), plan: "plus", period: "annual" });
    expect(toAnnual).toMatchObject({ plan: "plus", period: "monthly", pendingPlan: "plus", pendingPeriod: "annual" });
    const toMonthly = apply(sub({ period: "annual" }), { type: "plan_changed", occurredAt: day(10), plan: "plus", period: "monthly" });
    expect(toMonthly).toMatchObject({ period: "annual", pendingPeriod: "monthly" });
  });

  it("going back to what is already in force cancels the scheduled change", () => {
    const scheduled = apply(sub({ plan: "family" }), { type: "plan_changed", occurredAt: day(10), plan: "plus", period: "monthly" });
    const reverted = apply(scheduled, { type: "plan_changed", occurredAt: day(12), plan: "family", period: "monthly" });
    expect(reverted).toMatchObject({ plan: "family", pendingPlan: null, pendingPeriod: null });
  });

  it("a provider that reports a downgrade as already in force is believed", () => {
    const next = apply(sub({ plan: "family" }), { type: "plan_changed", occurredAt: day(10), plan: "plus", period: "monthly", timing: "immediate" });
    expect(next).toMatchObject({ plan: "plus", pendingPlan: null });
  });

  it("an upgrade can be reported as scheduled", () => {
    const next = apply(sub(), { type: "plan_changed", occurredAt: day(10), plan: "family", period: "monthly", timing: "next_renewal" });
    expect(next).toMatchObject({ plan: "plus", pendingPlan: "family" });
  });

  it("an immediate change clears any older scheduled one", () => {
    const s = sub({ plan: "family", pendingPlan: "plus", pendingPeriod: "annual" });
    const next = apply(s, { type: "plan_changed", occurredAt: day(10), plan: "family", period: "annual", timing: "immediate" });
    expect(next).toMatchObject({ plan: "family", period: "annual", pendingPlan: null });
  });

  it("is idempotent", () => {
    const upgraded = apply(sub(), { type: "plan_changed", occurredAt: day(10), plan: "family", period: "monthly" });
    expect(apply(upgraded, { type: "plan_changed", occurredAt: day(10), plan: "family", period: "monthly" })).toBe(upgraded);
    const scheduled = apply(sub({ plan: "family" }), { type: "plan_changed", occurredAt: day(10), plan: "plus", period: "monthly" });
    expect(apply(scheduled, { type: "plan_changed", occurredAt: day(10), plan: "plus", period: "monthly" })).toBe(scheduled);
  });

  it("changes nothing on a subscription that has ended", () => {
    for (const s of [sub({ status: "expired" }), sub({ status: "refunded" }), sub({ status: "canceled", autoRenew: false, currentPeriodEnd: day(5), lastEventAt: day(1) })]) {
      expect(apply(s, { type: "plan_changed", occurredAt: day(10), plan: "family", period: "monthly" })).toBe(s);
    }
  });

  it("needs a subscription", () => {
    expect(() => apply(null, { type: "plan_changed", occurredAt: day(1), plan: "family", period: "monthly" })).toThrow(BillingEventError);
  });
});

describe("snapshot (the provider's own account of the subscription)", () => {
  const snapshot = (over: Partial<Extract<BillingEvent, { type: "snapshot" }>> = {}): BillingEvent => ({
    type: "snapshot",
    occurredAt: day(10),
    provider: "google",
    plan: "plus",
    period: "monthly",
    status: "active",
    autoRenew: true,
    currentPeriodEnd: day(30),
    ...over,
  });

  it("can create a subscription from nothing", () => {
    expect(apply(null, snapshot())).toMatchObject({ plan: "plus", provider: "google", status: "active", currentPeriodEnd: day(30), graceEndsAt: null });
  });

  it("an active snapshot with renewal off is cancelled-until-the-end", () => {
    expect(apply(null, snapshot({ autoRenew: false }))).toMatchObject({ status: "canceled", autoRenew: false });
  });

  it("a cancelled snapshot with no end date can't be given access, so it is ended", () => {
    expect(apply(null, snapshot({ status: "canceled", autoRenew: false, currentPeriodEnd: null })).status).toBe("expired");
  });

  it("an expired snapshot ends the plan", () => {
    const next = apply(sub({ provider: "google", lastEventAt: day(5) }), snapshot({ status: "expired", autoRenew: true }));
    expect(next).toMatchObject({ status: "expired", autoRenew: false });
  });

  it("a snapshot in grace sets the grace and leaves the paid-until date alone when it doesn't know it", () => {
    const next = apply(sub({ provider: "google", lastEventAt: day(5) }), snapshot({ status: "past_due", currentPeriodEnd: undefined, graceEndsAt: day(33) }));
    expect(next).toMatchObject({ status: "past_due", graceEndsAt: day(33), currentPeriodEnd: day(30) });
  });

  it("a snapshot on hold has no grace", () => {
    const next = apply(sub({ provider: "google", lastEventAt: day(5) }), snapshot({ status: "past_due", currentPeriodEnd: undefined, graceEndsAt: null }));
    expect(next.graceEndsAt).toBeNull();
    expect(resolveEffectivePlan(next, day(35)).plan).toBe("free");
  });

  it("repeated past-due snapshots never extend a grace period", () => {
    const first = apply(sub({ provider: "google", lastEventAt: day(5) }), snapshot({ status: "past_due", currentPeriodEnd: undefined, graceEndsAt: day(33) }));
    const later = apply(first, snapshot({ occurredAt: day(12), status: "past_due", currentPeriodEnd: undefined, graceEndsAt: day(40) }));
    expect(later.graceEndsAt).toEqual(day(33));
    const unspecified = apply(first, snapshot({ occurredAt: day(13), status: "past_due", currentPeriodEnd: undefined }));
    expect(unspecified.graceEndsAt).toEqual(day(33));
  });

  it("recovery is a snapshot that is active again, and clears the grace", () => {
    const failed = sub({ provider: "google", status: "past_due", graceEndsAt: day(33), lastEventAt: day(31) });
    expect(apply(failed, snapshot({ occurredAt: day(32), currentPeriodEnd: day(60) }))).toMatchObject({ status: "active", graceEndsAt: null, currentPeriodEnd: day(60) });
  });

  it("carries a scheduled change, and drops it when the plan has reached it", () => {
    const scheduled = apply(null, snapshot({ plan: "family", pendingPlan: "plus", pendingPeriod: "monthly" }));
    expect(scheduled).toMatchObject({ plan: "family", pendingPlan: "plus", pendingPeriod: "monthly" });
    const arrived = apply(scheduled, snapshot({ occurredAt: day(31), plan: "plus", currentPeriodEnd: day(61), pendingPlan: "plus", pendingPeriod: "monthly" }));
    expect(arrived).toMatchObject({ plan: "plus", pendingPlan: null });
  });

  it("leaves unspecified fields as stored, and clears them when told null", () => {
    const s = sub({ provider: "google", trialEndsAt: day(7), lastEventAt: day(5) });
    expect(apply(s, snapshot({ currentPeriodEnd: undefined })).currentPeriodEnd).toEqual(day(30));
    expect(apply(s, snapshot({ trialEndsAt: null })).trialEndsAt).toBeNull();
  });

  it("is idempotent", () => {
    const once = apply(null, snapshot());
    expect(apply(once, snapshot())).toBe(once);
  });

  it("a refund isn't softened to 'expired' and isn't undone by a snapshot of the same period", () => {
    const refunded = sub({ provider: "google", status: "refunded", currentPeriodEnd: day(30), lastEventAt: day(11) });
    expect(apply(refunded, snapshot({ occurredAt: day(12), status: "expired" }))).toBe(refunded);
    expect(apply(refunded, snapshot({ occurredAt: day(12), status: "active", currentPeriodEnd: day(30) }))).toBe(refunded);
    expect(apply(refunded, snapshot({ occurredAt: day(40), status: "active", currentPeriodEnd: day(60) })).status).toBe("active");
  });

  it("an expired subscription needs a new period to come back", () => {
    const expired = sub({ provider: "google", status: "expired", currentPeriodEnd: day(30), lastEventAt: day(31) });
    expect(apply(expired, snapshot({ occurredAt: day(32), currentPeriodEnd: day(30) }))).toBe(expired);
    expect(apply(expired, snapshot({ occurredAt: day(40), currentPeriodEnd: day(70) })).status).toBe("active");
  });

  it("another provider's subscription isn't held back by this one having ended", () => {
    const expired = sub({ provider: "apple", status: "expired", currentPeriodEnd: day(30), lastEventAt: day(31) });
    expect(apply(expired, snapshot({ occurredAt: day(32), currentPeriodEnd: day(20) })).provider).toBe("google");
  });
});

describe("delivery order and replays", () => {
  it("a late 'payment failed' can't undo a payment that has since gone through", () => {
    const paid = apply(sub(), { type: "renewed", occurredAt: day(31), currentPeriodEnd: day(60) });
    expect(apply(paid, { type: "payment_failed", occurredAt: day(30), graceEndsAt: day(37), periodEnd: day(30) })).toBe(paid);
  });

  it("a late expiry can't end a subscription that has since renewed", () => {
    const renewed = apply(sub(), { type: "renewed", occurredAt: day(31), currentPeriodEnd: day(60) });
    expect(apply(renewed, { type: "expired", occurredAt: day(30), periodEnd: day(30) })).toBe(renewed);
  });

  it("a late start can't overwrite a newer state", () => {
    const later = apply(sub(), { type: "auto_renew_off", occurredAt: day(10) });
    expect(apply(later, started({ occurredAt: day(0) }))).toBe(later);
  });

  it("a late renewal still moves the paid-until date forward, but no more than that", () => {
    const off = apply(sub(), { type: "auto_renew_off", occurredAt: day(32) });
    const next = apply(off, { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60) });
    expect(next).toMatchObject({ currentPeriodEnd: day(60), status: "canceled", autoRenew: false });
    expect(next.lastEventAt).toEqual(day(32));
  });

  it("a late renewal can't revive anything that ended", () => {
    const expired = apply(sub(), { type: "expired", occurredAt: day(40) });
    expect(apply(expired, { type: "renewed", occurredAt: day(35), currentPeriodEnd: day(90) })).toBe(expired);
  });

  it("events at the same instant are all applied", () => {
    const failed = apply(sub(), { type: "payment_failed", occurredAt: day(30), graceEndsAt: day(37) });
    const off = apply(failed, { type: "auto_renew_off", occurredAt: day(30) });
    expect(off).toMatchObject({ status: "past_due", autoRenew: false });
  });

  it("a timestamp from the future is treated as now, so one bad clock can't freeze a subscription", () => {
    const now = day(100);
    const bogus = apply(sub({ lastEventAt: day(0), currentPeriodEnd: day(200) }), { type: "auto_renew_off", occurredAt: new Date(now.getTime() + 365 * DAY) }, now);
    expect(bogus.lastEventAt).toEqual(now);
    const real = apply(bogus, { type: "auto_renew_on", occurredAt: new Date(now.getTime() + 60_000) }, now);
    expect(real.autoRenew).toBe(true);
    // Within the allowed skew, the event's own time is kept.
    const near = new Date(now.getTime() + MAX_CLOCK_SKEW_MS - 1000);
    expect(apply(sub({ lastEventAt: day(0) }), { type: "auto_renew_off", occurredAt: near }, now).lastEventAt).toEqual(near);
  });

  it("an invalid timestamp is treated as now", () => {
    const now = day(100);
    expect(apply(null, started({ occurredAt: new Date("garbage") }), now).lastEventAt).toEqual(now);
  });

  /** Apply events in the given order, tolerating events that arrive before there is anything to apply them to. */
  function run(events: BillingEvent[], from: SubscriptionState | null) {
    return events.reduce<SubscriptionState | null>((state, event) => {
      try {
        return apply(state, event);
      } catch (err) {
        if (err instanceof BillingEventError) return state;
        throw err;
      }
    }, from);
  }

  it("pairs of events reach the same state in either order", () => {
    const base = sub({ lastEventAt: day(0) });
    const pairs: Array<[string, BillingEvent, BillingEvent]> = [
      ["failure then renewal", { type: "payment_failed", occurredAt: day(30), graceEndsAt: day(37), periodEnd: day(30) }, { type: "renewed", occurredAt: day(33), currentPeriodEnd: day(60) }],
      ["renewal off then renewal", { type: "auto_renew_off", occurredAt: day(20) }, { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60) }],
      ["renewal then renewal off", { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60) }, { type: "auto_renew_off", occurredAt: day(35) }],
      ["renewal then expiry of the old period", { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60) }, { type: "expired", occurredAt: day(30), periodEnd: day(30) }],
      ["pause then resume", { type: "paused", occurredAt: day(10) }, { type: "resumed", occurredAt: day(20), currentPeriodEnd: day(50) }],
      ["downgrade booked then renewal", { type: "plan_changed", occurredAt: day(10), plan: "plus", period: "monthly" }, { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60), plan: "plus", period: "monthly" }],
    ];
    for (const [name, a, b] of pairs) {
      const forward = run([a, b], name.includes("downgrade") ? { ...base, plan: "family" } : base);
      const backward = run([b, a], name.includes("downgrade") ? { ...base, plan: "family" } : base);
      expect(backward, name).toEqual(forward);
    }
  });

  it("a whole lifecycle replayed gives the same final state", () => {
    const lifecycle: BillingEvent[] = [
      started({ occurredAt: day(0), currentPeriodEnd: day(30) }),
      { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60) },
      { type: "payment_failed", occurredAt: day(60), graceEndsAt: day(67), periodEnd: day(60) },
      { type: "renewed", occurredAt: day(62), currentPeriodEnd: day(90) },
      { type: "plan_changed", occurredAt: day(70), plan: "family", period: "monthly" },
      { type: "auto_renew_off", occurredAt: day(80) },
      { type: "expired", occurredAt: day(90), periodEnd: day(90) },
    ];
    const once = run(lifecycle, null);
    const twice = run([...lifecycle, ...lifecycle], null);
    expect(once).toMatchObject({ status: "expired", plan: "family" });
    expect(twice).toEqual(once);
    // And every prefix is stable under replay of its own events.
    for (let i = 1; i <= lifecycle.length; i++) {
      const prefix = lifecycle.slice(0, i);
      expect(run([...prefix, ...prefix], null)).toEqual(run(prefix, null));
    }
  });

  it("walks a household through a full life: start, renew, cancel, lapse, come back", () => {
    let s = apply(null, started({ currentPeriodEnd: day(30) }));
    expect(resolveEffectivePlan(s, day(5)).plan).toBe("plus");
    s = apply(s, { type: "renewed", occurredAt: day(30), currentPeriodEnd: day(60) });
    s = apply(s, { type: "auto_renew_off", occurredAt: day(40) });
    expect(resolveEffectivePlan(s, day(50))).toMatchObject({ plan: "plus", willRenew: false });
    s = apply(s, { type: "expired", occurredAt: day(60), periodEnd: day(60) });
    expect(resolveEffectivePlan(s, day(61)).plan).toBe("free");
    s = apply(s, started({ occurredAt: day(100), currentPeriodEnd: day(130), plan: "family" }));
    expect(resolveEffectivePlan(s, day(101)).plan).toBe("family");
  });
});

describe("helpers", () => {
  it("knows which events can start a subscription", () => {
    const starters = BILLING_EVENT_TYPES.filter((type) => canStartSubscription({ type } as BillingEvent));
    expect(starters.sort()).toEqual(["snapshot", "started"]);
  });

  it("knows which statuses are end states", () => {
    expect(isTerminalStatus("expired")).toBe(true);
    expect(isTerminalStatus("refunded")).toBe(true);
    for (const status of ["trialing", "active", "past_due", "paused", "canceled"] as const) expect(isTerminalStatus(status)).toBe(false);
  });

  it("describes events for the audit trail without personal or payment details", () => {
    expect(describeBillingEvent(started())).toBe("started plus/monthly");
    expect(describeBillingEvent(started({ trialEndsAt: day(7) }))).toBe("started plus/monthly (trial)");
    expect(describeBillingEvent({ type: "plan_changed", occurredAt: day(1), plan: "family", period: "annual", timing: "immediate" })).toBe("plan_changed family/annual immediate");
    expect(describeBillingEvent({ type: "paused", occurredAt: day(1) })).toBe("paused");
  });

  it("covers every event type exactly once", () => {
    expect(new Set(BILLING_EVENT_TYPES).size).toBe(BILLING_EVENT_TYPES.length);
    expect(BILLING_EVENT_TYPES).toHaveLength(16);
  });
});
