/**
 * Billing against a real database. Run ONLY against the isolated test database:
 *   TEST_DATABASE_URL=postgres://plenty:plenty@localhost:5432/plenty_test_billing npx vitest run tests/integration/billing.test.ts
 *
 * Stripe, Apple and Google are never contacted and no credentials are used. Their network
 * calls are replaced at the module boundary (see the mocks below) and every payload is
 * SYNTHETIC (tests/helpers/billing-fixtures.ts). What these tests prove is Plenty's own
 * behaviour: signature checks, idempotency, ordering, ownership, limits and row-level
 * security. They don't prove the live services accept or send exactly these payloads.
 */
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { BillingEvent, NormalizedBillingEvent, PaidPlanId } from "@/lib/billing/events";
import type { BillingPeriod } from "@/lib/billing/plans";
import type { BillingProviderId } from "@/lib/billing/subscription";
import { APPLE_MANAGE_URL } from "@/lib/billing/management";
import { analyticsSubject } from "@/server/analytics";
import { buildHouseholdContext, type HouseholdContext } from "@/server/auth/build-context";
import { accountTokenFor } from "@/server/billing/account-token";
import { applyNormalizedEvent } from "@/server/billing/apply-event";
import { resolveHouseholdPlan } from "@/server/billing/entitlements";
import { assertRoomForMember, checkRoomForItems, consumeReceiptScan, receiptScanAllowance } from "@/server/billing/limits";
import * as manual from "@/server/billing/providers/manual";
import {
  confirmWebCheckout,
  createPortalSession,
  getBillingOverview,
  getStoreAccountToken,
  prepareHouseholdDeletion,
  restorePurchases,
  startWebCheckout,
} from "@/server/billing/service";
import { pool, systemDb, withUser } from "@/server/db/client";
import { analyticsEvents, billingEvents, households, inventoryItems, notifications, subscriptions, usageCounters } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { acceptInvitation, createInvitation } from "@/server/services/household";
import { POST as appleWebhook } from "@/app/api/billing/webhooks/apple/route";
import { GET as stripeWebhookGet, POST as stripeWebhook } from "@/app/api/billing/webhooks/stripe/route";
import { POST as googleWebhook } from "@/app/api/billing/webhooks/google/route";
import {
  APPLE_APP_ID,
  APPLE_BUNDLE,
  appleNotification,
  appleRenewal,
  appleTransaction,
  makeSyntheticAppleChain,
  opensslAvailable,
  STRIPE_PRICES,
  stripeEvent,
  stripeSubscription,
} from "../helpers/billing-fixtures";
import { makeHousehold } from "../helpers/db";

// ─── Boundary mocks (no network, no credentials) ────────────────────────────

const GOOGLE_SENDER = "pubsub-push@plenty-test.iam.gserviceaccount.com";
const GOOGLE_PACKAGE = "app.plenty.test";
const WHSEC = "whsec_synthetic_integration_secret";

const mocks = vi.hoisted(() => ({
  checkoutCalls: [] as Array<Record<string, unknown>>,
  portalCalls: [] as Array<{ customerId: string; returnUrl: string }>,
  cancelCalls: [] as string[],
  stripeSession: null as unknown,
  chargeResolver: null as null | ((charge: unknown) => Promise<unknown>),
  stripeOff: false,
  googleTokens: new Map<string, unknown>(),
  googleAcks: [] as string[],
  googleFetchFails: false,
}));

vi.mock("@/server/billing/providers/stripe", async (importActual) => {
  const actual = await importActual<typeof import("@/server/billing/providers/stripe")>();
  return {
    ...actual,
    readStripeConfig: (...args: Parameters<typeof actual.readStripeConfig>) => (mocks.stripeOff ? null : actual.readStripeConfig(...args)),
    isConfigured: (...args: Parameters<typeof actual.isConfigured>) => (mocks.stripeOff ? false : actual.isConfigured(...args)),
    createCheckoutSession: async (input: Record<string, unknown>) => {
      mocks.checkoutCalls.push(input);
      return { url: "https://checkout.stripe.test/c/pay_synthetic", sessionId: "cs_test_synthetic" };
    },
    createPortalSession: async (customerId: string, returnUrl: string) => {
      mocks.portalCalls.push({ customerId, returnUrl });
      return { url: "https://billing.stripe.test/p/session_synthetic" };
    },
    retrieveCheckoutSession: async () => mocks.stripeSession,
    cancelSubscriptionNow: async (id: string) => {
      mocks.cancelCalls.push(id);
    },
    stripeChargeResolver: () => async (charge: unknown) => (mocks.chargeResolver ? mocks.chargeResolver(charge) : null),
  };
});

vi.mock("@/server/billing/providers/apple", async (importActual) => {
  const actual = await importActual<typeof import("@/server/billing/providers/apple")>();
  const offline = actual.makeVerifierFactory(false); // no OCSP lookups
  return {
    ...actual,
    verifyRestoreProof: (proof: Parameters<typeof actual.verifyRestoreProof>[0], now: Date, config: Parameters<typeof actual.verifyRestoreProof>[2]) =>
      actual.verifyRestoreProof(proof, now, config, offline),
    verifyNotification: (jws: string, config: Parameters<typeof actual.verifyNotification>[1]) => actual.verifyNotification(jws, config, offline),
  };
});

vi.mock("@/server/billing/providers/google", async (importActual) => {
  const actual = await importActual<typeof import("@/server/billing/providers/google")>();
  return {
    ...actual,
    verifyPush: (authorization: string | null, config: Parameters<typeof actual.verifyPush>[1]) =>
      actual.verifyPush(authorization, config, {
        async verifyIdToken({ idToken }) {
          if (idToken !== "good-token") throw new Error("invalid token");
          return { getPayload: () => ({ email: GOOGLE_SENDER, email_verified: true }) };
        },
      }),
    fetchSubscription: async (token: string) => {
      if (mocks.googleFetchFails) {
        const { WebhookRetryError } = await import("@/server/billing/errors");
        throw new WebhookRetryError();
      }
      const purchase = mocks.googleTokens.get(token) as import("@/server/billing/providers/google").GoogleSubscriptionPurchaseV2 | undefined;
      return purchase ? { purchase, fetchedAt: new Date() } : null;
    },
    verifyPurchaseToken: async (token: string, _now: Date, config: Parameters<typeof actual.verifyPurchaseToken>[2]) =>
      actual.describeGooglePurchase(
        token,
        (mocks.googleTokens.get(token) as import("@/server/billing/providers/google").GoogleSubscriptionPurchaseV2 | undefined) ?? null,
        new Date(),
        config!,
      ),
    acknowledge: async (token: string) => {
      mocks.googleAcks.push(token);
      return true;
    },
  };
});

// ─── Synthetic configuration, set before anything reads the environment ─────

const chain = opensslAvailable ? makeSyntheticAppleChain() : null;
const ACCOUNT_SECRET = "t".repeat(48);
process.env.APP_URL = "https://plenty.test";
process.env.BILLING_ACCOUNT_SECRET = ACCOUNT_SECRET;
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic";
process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
process.env.STRIPE_PRICES = Object.entries(STRIPE_PRICES)
  .map(([key, id]) => `${key}=${id}`)
  .join(",");
process.env.APPLE_BUNDLE_ID = APPLE_BUNDLE;
process.env.APPLE_APP_ID = String(APPLE_APP_ID);
if (chain) process.env.APPLE_ROOT_CERTS = chain.rootDer.toString("base64");
process.env.GOOGLE_PLAY_PACKAGE_NAME = GOOGLE_PACKAGE;
process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "play@plenty-test.iam.gserviceaccount.com", private_key: "synthetic-not-a-key" });
process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT = GOOGLE_SENDER;
delete process.env.PLAN_OVERRIDE;

// ─── Helpers ────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const BASE = Date.now() - 300 * DAY;
/** A moment `n` days into a made-up timeline that ended well before now. */
const at = (n: number) => new Date(BASE + n * DAY);
const future = (days: number) => Date.now() + days * DAY;
const sec = (ms: number) => Math.floor(ms / 1000);

let seq = 0;
const uid = (prefix: string) => `${prefix}_${process.pid}_${Date.now().toString(36)}_${++seq}`;

function nev(provider: BillingProviderId, householdId: string | null, subscriptionId: string | null, event: BillingEvent | null, over: Partial<NormalizedBillingEvent> = {}): NormalizedBillingEvent {
  return {
    provider,
    eventId: uid("evt"),
    providerType: `test.${event?.type ?? "none"}`,
    link: { providerSubscriptionId: subscriptionId, providerCustomerId: provider === "web" && subscriptionId ? `cus_${subscriptionId}` : null, householdId },
    event,
    ...over,
  };
}

/** `end` may be a Date or epoch milliseconds (as `future()` returns). */
const started = (provider: BillingProviderId, plan: PaidPlanId, period: BillingPeriod, occurredAt: Date, end: Date | number | null, extra: Record<string, unknown> = {}): BillingEvent =>
  ({ type: "started", occurredAt, provider, plan, period, currentPeriodEnd: typeof end === "number" ? new Date(end) : end, ...extra }) as BillingEvent;

const go = (n: NormalizedBillingEvent, now: Date) => applyNormalizedEvent(n, { now });
const rowOf = async (householdId: string) => (await systemDb.select().from(subscriptions).where(eq(subscriptions.householdId, householdId)))[0];
const planAt = async (householdId: string, when: Date) => (await resolveHouseholdPlan(householdId, when)).effective;
const billingNotices = (householdId: string) => systemDb.select().from(notifications).where(and(eq(notifications.householdId, householdId), eq(notifications.type, "billing")));
const analyticsFor = async (householdId: string, event: string) =>
  systemDb.select().from(analyticsEvents).where(and(eq(analyticsEvents.subject, analyticsSubject(householdId)!), eq(analyticsEvents.event, event)));
const refresh = async (ctx: HouseholdContext) => (await buildHouseholdContext(ctx.user, ctx.household.id))!;
const fresh = () => makeHousehold({ plan: "free" });

async function dbFailure(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return `${err.message} ${err.cause?.message ?? ""}`;
  }
}

async function failure(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("expected the call to be refused");
}

/** A household with its owner and one ordinary member (someone from another household who joined). */
async function householdWithMember() {
  const owner = await fresh();
  const other = await fresh();
  const invite = await createInvitation(owner);
  await acceptInvitation(other.user, invite.code);
  const member = (await buildHouseholdContext(other.user, owner.household.id))!;
  return { owner, member, other };
}

const signStripe = (event: object) => {
  const body = JSON.stringify(event);
  return { body, signature: Stripe.webhooks.generateTestHeaderString({ payload: body, secret: WHSEC }) };
};
const post = (path: string, body: string, headers: Record<string, string> = {}) => new Request(`https://plenty.test${path}`, { method: "POST", body, headers });
const sendStripe = (event: object, tamper?: (body: string) => string) => {
  const { body, signature } = signStripe(event);
  return stripeWebhook(post("/api/billing/webhooks/stripe", tamper ? tamper(body) : body, { "stripe-signature": signature }));
};
const sendApple = (signedPayload: string) => appleWebhook(post("/api/billing/webhooks/apple", JSON.stringify({ signedPayload }), { "content-type": "application/json" }));
const sendGoogle = (notification: object, messageId = uid("msg"), bearer: string | null = "good-token") =>
  googleWebhook(
    post("/api/billing/webhooks/google", JSON.stringify({ message: { data: Buffer.from(JSON.stringify(notification)).toString("base64"), messageId } }), bearer ? { authorization: `Bearer ${bearer}` } : {}),
  );

const stripeSubFor = (householdId: string, over: Record<string, unknown> = {}) => {
  const id = uid("sub");
  return stripeSubscription({
    id,
    customer: `cus_${id}`,
    metadata: { household_id: householdId },
    items: { data: [{ price: { id: STRIPE_PRICES["plus.monthly"] }, current_period_start: sec(Date.now() - DAY), current_period_end: sec(future(20)) }] },
    ...over,
  });
};

beforeAll(() => {
  if (!/plenty_test/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("Refusing to run: billing integration tests must run on a test database (plenty_test*), never a real one.");
  }
});

beforeEach(() => {
  mocks.checkoutCalls.length = 0;
  mocks.portalCalls.length = 0;
  mocks.cancelCalls.length = 0;
  mocks.googleAcks.length = 0;
  mocks.googleTokens.clear();
  mocks.stripeSession = null;
  mocks.chargeResolver = null;
  mocks.stripeOff = false;
  mocks.googleFetchFails = false;
});

afterAll(async () => {
  chain?.cleanup();
  await pool.end();
});

// ─── The state machine against the database ─────────────────────────────────

describe("applying events", () => {
  it("starts a subscription, and a replayed delivery changes nothing", async () => {
    const h = await fresh();
    const sub = uid("sub");
    const first = nev("web", h.household.id, sub, started("web", "plus", "monthly", at(0), at(30), { autoRenew: true }));
    const result = await go(first, at(0));
    expect(result).toMatchObject({ outcome: "applied", householdId: h.household.id, before: null, after: { plan: "plus", status: "active" } });

    const row = await rowOf(h.household.id);
    expect(row).toMatchObject({ plan: "plus", period: "monthly", status: "active", provider: "web", providerSubscriptionId: sub, providerCustomerId: `cus_${sub}`, autoRenew: true });
    expect(row.lastEventAt).toEqual(at(0));
    expect((await planAt(h.household.id, at(5))).plan).toBe("plus");

    const replay = await go(first, at(1));
    expect(replay.outcome).toBe("duplicate");
    const after = await rowOf(h.household.id);
    expect(after.updatedAt).toEqual(row.updatedAt);
    const audit = await systemDb.select().from(billingEvents).where(and(eq(billingEvents.provider, "web"), eq(billingEvents.eventId, first.eventId)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ householdId: h.household.id, error: null });
    expect(audit[0].processedAt).not.toBeNull();
    expect(audit[0].summary).not.toMatch(/cus_|sub_/); // identifiers stay out of the audit trail
  });

  it("two copies of the same event arriving at once are applied once", async () => {
    const h = await fresh();
    const n = nev("web", h.household.id, uid("sub"), started("web", "plus", "monthly", at(0), at(30)));
    const outcomes = (await Promise.all([go(n, at(0)), go(n, at(0))])).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["applied", "duplicate"]);
    expect(await systemDb.select().from(subscriptions).where(eq(subscriptions.householdId, h.household.id))).toHaveLength(1);
    expect(await analyticsFor(h.household.id, "subscription_started")).toHaveLength(1);
  });

  it("an event that arrives before its subscription is recorded unprocessed, then applied when redelivered", async () => {
    const h = await fresh();
    const sub = uid("sub");
    const renewal = nev("web", h.household.id, sub, { type: "renewed", occurredAt: at(30), currentPeriodEnd: at(60) });
    expect((await go(renewal, at(30))).outcome).toBe("retry");
    expect(await rowOf(h.household.id)).toBeUndefined();
    const [audit] = await systemDb.select().from(billingEvents).where(eq(billingEvents.eventId, renewal.eventId));
    expect(audit.processedAt).toBeNull();
    expect(audit.error).toMatch(/before its subscription/);

    await go(nev("web", h.household.id, sub, started("web", "plus", "monthly", at(0), at(30))), at(30));
    expect((await go(renewal, at(31))).outcome).toBe("applied");
    expect((await rowOf(h.household.id)).currentPeriodEnd).toEqual(at(60));
  });

  it("a stale event can't undo something newer", async () => {
    const h = await fresh();
    const sub = uid("sub");
    await go(nev("web", h.household.id, sub, started("web", "plus", "monthly", at(0), at(30))), at(0));
    await go(nev("web", h.household.id, sub, { type: "renewed", occurredAt: at(31), currentPeriodEnd: at(60) }), at(31));
    // A payment failure for the period that has since been paid, delivered late.
    const late = await go(nev("web", h.household.id, sub, { type: "payment_failed", occurredAt: at(30), graceEndsAt: at(37), periodEnd: at(30) }), at(32));
    expect(late.outcome).toBe("unchanged");
    const row = await rowOf(h.household.id);
    expect(row).toMatchObject({ status: "active", currentPeriodEnd: at(60), graceEndsAt: null });
    expect(await billingNotices(h.household.id)).toHaveLength(0);
    // A late expiry for the old period likewise.
    expect((await go(nev("web", h.household.id, sub, { type: "expired", occurredAt: at(30), periodEnd: at(30) }), at(33))).outcome).toBe("unchanged");
    expect((await planAt(h.household.id, at(40))).plan).toBe("plus");
  });

  it("cancelling renewal keeps the plan until the period ends, and is counted as one cancellation", async () => {
    const h = await fresh();
    const sub = uid("sub");
    await go(nev("web", h.household.id, sub, started("web", "plus", "monthly", at(0), at(30))), at(0));
    const off = await go(nev("web", h.household.id, sub, { type: "auto_renew_off", occurredAt: at(10) }), at(10));
    expect(off.outcome).toBe("applied");
    const row = await rowOf(h.household.id);
    expect(row).toMatchObject({ status: "canceled", autoRenew: false, currentPeriodEnd: at(30) });
    expect(row.canceledAt).toEqual(at(10));
    expect(await planAt(h.household.id, at(20))).toMatchObject({ plan: "plus", reason: "cancelled_until_period_end", willRenew: false });
    expect((await planAt(h.household.id, at(31))).plan).toBe("free");

    // The provider says it again in a new notification: nothing changes and it isn't counted twice.
    expect((await go(nev("web", h.household.id, sub, { type: "auto_renew_off", occurredAt: at(11) }), at(11))).outcome).toBe("unchanged");
    expect(await analyticsFor(h.household.id, "subscription_cancelled")).toHaveLength(1);
    expect(await analyticsFor(h.household.id, "subscription_started")).toHaveLength(1);

    // Changing their mind before the end resumes it.
    await go(nev("web", h.household.id, sub, { type: "auto_renew_on", occurredAt: at(12) }), at(12));
    expect(await rowOf(h.household.id)).toMatchObject({ status: "active", autoRenew: true, canceledAt: null });
  });

  it("records analytics with only plan, period and provider: no names, ids or free text", async () => {
    const h = await fresh();
    await go(nev("apple", h.household.id, uid("orig"), started("apple", "family", "annual", at(0), at(365))), at(0));
    const [row] = await analyticsFor(h.household.id, "subscription_started");
    expect(JSON.parse(row.props!)).toEqual({ plan: "family", provider: "apple", period: "annual" });
    expect(row).toMatchObject({ plan: "family", platform: "ios" });
    expect(row.subject).not.toContain(h.household.id);
  });

  it("a failed renewal gives a grace period and one calm notice, then recovers", async () => {
    const h = await fresh();
    const sub = uid("sub");
    await go(nev("web", h.household.id, sub, started("web", "plus", "monthly", at(0), at(30))), at(0));
    await go(nev("web", h.household.id, sub, { type: "payment_failed", occurredAt: at(30), graceEndsAt: at(37), periodEnd: at(30) }), at(30));
    expect(await rowOf(h.household.id)).toMatchObject({ status: "past_due", graceEndsAt: at(37) });
    expect(await planAt(h.household.id, at(33))).toMatchObject({ plan: "plus", reason: "grace_period", needsPaymentAttention: true });
    expect((await planAt(h.household.id, at(38))).plan).toBe("free");

    const notices = await billingNotices(h.household.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ userId: h.user.id, link: "/settings/plan", title: "We couldn't take your payment" });
    expect(notices[0].body).toContain("Plenty Plus");
    expect(notices[0].body).not.toMatch(/!|urgent|suspend|delete|lose/i);
    expect(notices[0].dedupeKey).toMatch(/^billing:payment_failed:\d{4}-\d{2}-\d{2}$/);

    // The provider retries and fails again: no second notice, and the grace period isn't stretched.
    await go(nev("web", h.household.id, sub, { type: "payment_failed", occurredAt: at(32), graceEndsAt: at(40) }), at(32));
    expect(await billingNotices(h.household.id)).toHaveLength(1);
    expect((await rowOf(h.household.id)).graceEndsAt).toEqual(at(37));

    await go(nev("web", h.household.id, sub, { type: "payment_recovered", occurredAt: at(34), currentPeriodEnd: at(60) }), at(34));
    expect(await rowOf(h.household.id)).toMatchObject({ status: "active", graceEndsAt: null, currentPeriodEnd: at(60) });
    expect((await planAt(h.household.id, at(45))).plan).toBe("plus");
  });

  it("with no grace period, the failure notice says the household is on the free plan for now and nothing is lost", async () => {
    const h = await fresh();
    const sub = uid("sub");
    await go(nev("google", h.household.id, sub, started("google", "plus", "monthly", at(0), at(30))), at(0));
    await go(nev("google", h.household.id, sub, { type: "payment_failed", occurredAt: at(31), graceEndsAt: null, periodEnd: at(30) }), at(31));
    const [notice] = await billingNotices(h.household.id);
    expect(notice.body).toMatch(/free plan for now/);
    expect(notice.body).toMatch(/Nothing you've saved has been removed/);
    expect(notice.body).toContain("Google Play");
  });

  it("a refund returns the household to free at once, and nothing revives it afterwards", async () => {
    const h = await fresh();
    const sub = uid("sub");
    await go(nev("web", h.household.id, sub, started("web", "family", "monthly", at(0), at(30))), at(0));
    expect((await planAt(h.household.id, at(5))).plan).toBe("family");
    await go(nev("web", h.household.id, sub, { type: "refunded", occurredAt: at(5) }), at(5));
    expect(await rowOf(h.household.id)).toMatchObject({ status: "refunded" });
    expect((await rowOf(h.household.id)).endedAt).not.toBeNull();
    expect(await planAt(h.household.id, at(6))).toMatchObject({ plan: "free", reason: "refunded" });

    // A late renewal for the same period, and a replayed start, can't bring it back.
    expect((await go(nev("web", h.household.id, sub, { type: "renewed", occurredAt: at(4), currentPeriodEnd: at(30) }), at(7))).outcome).toBe("unchanged");
    expect((await go(nev("web", h.household.id, sub, started("web", "family", "monthly", at(6), at(30))), at(7))).outcome).toBe("unchanged");
    expect((await planAt(h.household.id, at(8))).plan).toBe("free");

    // A genuinely new purchase does.
    const again = await go(nev("web", h.household.id, uid("sub"), started("web", "plus", "annual", at(20), at(385))), at(20));
    expect(again.outcome).toBe("applied");
    expect(await rowOf(h.household.id)).toMatchObject({ plan: "plus", status: "active", endedAt: null });
    expect(await systemDb.select().from(subscriptions).where(eq(subscriptions.householdId, h.household.id))).toHaveLength(1);
  });

  it("an expiry returns the household to free, and a new subscription starts afresh", async () => {
    const h = await fresh();
    const sub = uid("sub");
    await go(nev("apple", h.household.id, sub, started("apple", "plus", "monthly", at(0), at(30))), at(0));
    await go(nev("apple", h.household.id, sub, { type: "expired", occurredAt: at(30), periodEnd: at(30) }), at(30));
    expect(await planAt(h.household.id, at(31))).toMatchObject({ plan: "free", reason: "ended" });
    await go(nev("apple", h.household.id, sub, started("apple", "plus", "monthly", at(60), at(90))), at(60));
    expect((await planAt(h.household.id, at(61))).plan).toBe("plus");
  });

  it("an upgrade is immediate; a downgrade waits for the renewal and the household keeps what it paid for", async () => {
    const h = await fresh();
    const sub = uid("sub");
    await go(nev("web", h.household.id, sub, started("web", "plus", "monthly", at(0), at(30))), at(0));
    await go(nev("web", h.household.id, sub, { type: "plan_changed", occurredAt: at(5), plan: "family", period: "monthly" }), at(5));
    expect((await planAt(h.household.id, at(6))).plan).toBe("family");

    await go(nev("web", h.household.id, sub, { type: "plan_changed", occurredAt: at(10), plan: "plus", period: "monthly" }), at(10));
    expect(await rowOf(h.household.id)).toMatchObject({ plan: "family", pendingPlan: "plus", pendingPeriod: "monthly" });
    const effective = await planAt(h.household.id, at(11));
    expect(effective).toMatchObject({ plan: "family", pendingChange: { plan: "plus", period: "monthly" } });

    const overview = await getBillingOverview(h, { now: at(11) });
    expect(overview.plan).toBe("family");
    expect(overview.pendingChange).toMatchObject({ plan: "plus", planName: "Plenty Plus" });
    expect(overview.pendingChange?.description).toContain("You keep Plenty Family until then");

    await go(nev("web", h.household.id, sub, { type: "renewed", occurredAt: at(30), currentPeriodEnd: at(60) }), at(30));
    expect(await rowOf(h.household.id)).toMatchObject({ plan: "plus", pendingPlan: null, pendingPeriod: null, currentPeriodEnd: at(60) });
    expect((await planAt(h.household.id, at(31))).plan).toBe("plus");
  });

  it("supports a trial, converting to a paid plan", async () => {
    const h = await fresh();
    const sub = uid("sub");
    await go(nev("web", h.household.id, sub, started("web", "plus", "monthly", at(0), null, { trialEndsAt: at(7) })), at(0));
    expect(await rowOf(h.household.id)).toMatchObject({ status: "trialing", trialEndsAt: at(7) });
    expect(await planAt(h.household.id, at(3))).toMatchObject({ plan: "plus", reason: "trial" });
    await go(nev("web", h.household.id, sub, { type: "renewed", occurredAt: at(7), currentPeriodEnd: at(37) }), at(7));
    expect(await rowOf(h.household.id)).toMatchObject({ status: "active", currentPeriodEnd: at(37) });
  });

  it("a snapshot can create the subscription from nothing (Google, Stripe updates)", async () => {
    const h = await fresh();
    const sub = uid("gtoken");
    await go(
      nev("google", h.household.id, sub, { type: "snapshot", occurredAt: at(0), provider: "google", plan: "plus", period: "annual", status: "active", autoRenew: false, currentPeriodEnd: at(365) }),
      at(0),
    );
    expect(await rowOf(h.household.id)).toMatchObject({ provider: "google", status: "canceled", autoRenew: false, plan: "plus" });
  });

  it("records an unlinkable event and applies nothing", async () => {
    const n = nev("web", null, uid("sub_nobody"), started("web", "plus", "monthly", at(0), at(30)));
    const result = await go(n, at(0));
    expect(result).toMatchObject({ outcome: "unlinked", householdId: null });
    const [audit] = await systemDb.select().from(billingEvents).where(eq(billingEvents.eventId, n.eventId));
    expect(audit).toMatchObject({ processedAt: null });
    expect(audit.error).toMatch(/no household/);
  });

  it("a household hint never moves a subscription that is already linked to another household", async () => {
    const a = await fresh();
    const b = await fresh();
    const sub = uid("sub");
    await go(nev("web", a.household.id, sub, started("web", "plus", "monthly", at(0), at(30))), at(0));
    // A notification about A's subscription that names B.
    await go(nev("web", b.household.id, sub, { type: "auto_renew_off", occurredAt: at(5) }), at(5));
    expect(await rowOf(a.household.id)).toMatchObject({ status: "canceled", autoRenew: false });
    expect(await rowOf(b.household.id)).toBeUndefined();
    // A start naming B but carrying A's subscription id is A's too.
    await go(nev("web", b.household.id, sub, started("web", "family", "annual", at(6), at(371))), at(6));
    expect(await rowOf(b.household.id)).toBeUndefined();
  });

  it("a second subscription never silently replaces one that is giving access; the owners are told", async () => {
    const h = await fresh();
    const web = uid("sub");
    await go(nev("web", h.household.id, web, started("web", "plus", "monthly", at(0), at(30))), at(0));
    const apple = uid("orig");
    const result = await go(nev("apple", h.household.id, apple, started("apple", "family", "annual", at(5), at(370))), at(5));
    expect(result.outcome).toBe("conflict");
    expect(await rowOf(h.household.id)).toMatchObject({ provider: "web", plan: "plus", providerSubscriptionId: web });
    const [notice] = await billingNotices(h.household.id);
    expect(notice.title).toBe("You may have paid twice");
    expect(notice.body).toContain("the web");
    expect(notice.body).toContain("the App Store");
    // Redelivering it doesn't pile up notices.
    await go(nev("apple", h.household.id, apple, started("apple", "family", "annual", at(5), at(370))), at(6));
    expect(await billingNotices(h.household.id)).toHaveLength(1);

    // Once the first has ended, a new purchase takes its place.
    await go(nev("web", h.household.id, web, { type: "expired", occurredAt: at(30), periodEnd: at(30) }), at(30));
    const replaced = await go(nev("apple", h.household.id, apple, started("apple", "family", "annual", at(40), at(405))), at(40));
    expect(replaced.outcome).toBe("applied");
    expect(await rowOf(h.household.id)).toMatchObject({ provider: "apple", plan: "family", providerSubscriptionId: apple });
  });

  it("a store plan change that arrives as a new purchase carries on from the one it replaces", async () => {
    const h = await fresh();
    const oldToken = uid("gtoken");
    const newToken = uid("gtoken");
    await go(nev("google", h.household.id, oldToken, started("google", "plus", "monthly", at(0), at(30))), at(0));
    const upgrade = nev("google", h.household.id, newToken, started("google", "family", "monthly", at(10), at(40)), {
      link: { providerSubscriptionId: newToken, replacesProviderSubscriptionId: oldToken, householdId: h.household.id },
    });
    expect((await go(upgrade, at(10))).outcome).toBe("applied");
    expect(await rowOf(h.household.id)).toMatchObject({ provider: "google", plan: "family", providerSubscriptionId: newToken });
    // Notifications about the old token still find this household, and are ignored as stale.
    expect((await go(nev("google", null, oldToken, { type: "expired", occurredAt: at(30), periodEnd: at(30) }), at(31))).householdId).toBeNull();
  });

  it("operator grants flow through the same machinery, are never counted as sales, and never override a paid subscription", async () => {
    const h = await fresh();
    expect((await manual.grantPlan({ householdId: h.household.id, plan: "family", until: null, reason: "support case" }, at(0))).outcome).toBe("applied");
    expect(await rowOf(h.household.id)).toMatchObject({ provider: "manual", plan: "family", status: "active", autoRenew: false, currentPeriodEnd: null });
    expect((await planAt(h.household.id, at(500))).plan).toBe("family");
    expect(await analyticsFor(h.household.id, "subscription_started")).toHaveLength(0);
    await manual.revokeGrant(h.household.id, "support case closed", at(10));
    expect((await planAt(h.household.id, at(11))).plan).toBe("free");

    const paid = await fresh();
    await go(nev("web", paid.household.id, uid("sub"), started("web", "plus", "monthly", at(0), at(30))), at(0));
    expect((await manual.grantPlan({ householdId: paid.household.id, plan: "family", until: null, reason: "x" }, at(1))).outcome).toBe("conflict");
    expect((await rowOf(paid.household.id)).provider).toBe("web");

    const demo = await fresh();
    await manual.grantDemoPlan(demo.household.id, at(0));
    expect((await planAt(demo.household.id, at(2000))).plan).toBe("family");
  });

  it("an event for a deleted household is not applied to it", async () => {
    const h = await fresh();
    await systemDb.update(households).set({ deletedAt: new Date() }).where(eq(households.id, h.household.id));
    expect((await go(nev("web", h.household.id, uid("sub"), started("web", "plus", "monthly", at(0), at(30))), at(0))).outcome).toBe("unlinked");
  });

  it("never records card or payment details: only a short note and a provider event id", async () => {
    const h = await fresh();
    const n = nev("web", h.household.id, uid("sub"), started("web", "plus", "monthly", at(0), at(30)));
    await go(n, at(0));
    const [audit] = await systemDb.select().from(billingEvents).where(eq(billingEvents.eventId, n.eventId));
    expect(Object.keys(audit).sort()).toEqual(["error", "eventId", "householdId", "id", "processedAt", "provider", "receivedAt", "summary", "type"]);
  });
});

// ─── Limits follow the plan, and never delete anything ──────────────────────

describe("plan limits", () => {
  it("members: blocked at the limit on free, lifted by Plus, and nobody is removed on a downgrade", async () => {
    const { owner, other } = await householdWithMember();
    const sub = uid("sub");
    let ctx = await refresh(owner);
    expect(ctx.plan.plan).toBe("free");
    expect((await failure(assertRoomForMember(ctx))).code).toBe("plan_limit");

    await go(nev("web", owner.household.id, sub, started("web", "plus", "monthly", at(0), future(30))), new Date());
    ctx = await refresh(owner);
    expect(ctx.plan.plan).toBe("plus");
    await expect(assertRoomForMember(ctx)).resolves.toBeUndefined();

    // A third and fourth person join on Plus ...
    const third = await fresh();
    const fourth = await fresh();
    const invite = await createInvitation(owner);
    await acceptInvitation(third.user, invite.code);
    await acceptInvitation(fourth.user, invite.code);

    // ... then the plan ends: all four stay, and only adding more waits.
    await go(nev("web", owner.household.id, sub, { type: "expired", occurredAt: new Date(), periodEnd: null }), new Date(Date.now() + 1000));
    ctx = await refresh(owner);
    expect(ctx.plan.plan).toBe("free");
    expect((await failure(assertRoomForMember(ctx))).message).toMatch(/covers up to 2 people/);
    const overview = await getBillingOverview(ctx);
    expect(overview.usage.members).toEqual({ used: 4, limit: 2 });
    expect(overview.overLimit.over).toBe(true);
    expect(overview.overLimit.limits[0]).toMatchObject({ kind: "members", used: 4, limit: 2, over: 2 });
    expect(overview.overLimit.message).toMatch(/nobody is removed or hidden/i);
    expect(other.user.id).toBeTruthy();
  });

  it("items: adding waits when over, finishing is always allowed, and nothing is deleted", async () => {
    const h = await fresh();
    await systemDb.insert(inventoryItems).values(Array.from({ length: 51 }, (_, i) => ({ householdId: h.household.id, name: `Synthetic item ${i}`, quantity: 1 })));
    expect((await checkRoomForItems(h, 1)).ok).toBe(false);
    const overview = await getBillingOverview(h);
    expect(overview.usage.items).toEqual({ used: 51, limit: 50 });
    expect(overview.overLimit.limits[0]).toMatchObject({ kind: "items", over: 1 });
    expect(overview.overLimit.message).toMatch(/finish or remove items any time/i);

    // Finishing two items is not blocked by the limit (it is not an "add"), and frees room.
    await systemDb.execute(sql`update inventory_items set status = 'finished' where id in (select id from inventory_items where household_id = ${h.household.id} limit 2)`);
    expect((await checkRoomForItems(h, 1)).ok).toBe(true);
    const [{ n }] = await systemDb.execute<{ n: number }>(sql`select count(*)::int as n from inventory_items where household_id = ${h.household.id}`).then((r) => r.rows);
    expect(n).toBe(51);

    // Plus has no limit.
    await go(nev("web", h.household.id, uid("sub"), started("web", "plus", "monthly", at(0), future(30))), new Date());
    expect((await checkRoomForItems(await refresh(h), 1000)).ok).toBe(true);
  });

  it("receipt scans: five a month on free, reset next month, unlimited on Plus, back to the limit after a refund", async () => {
    const h = await fresh();
    const june = new Date("2026-06-15T03:00:00Z");
    const july = new Date("2026-07-15T03:00:00Z");
    for (let i = 0; i < 5; i++) await consumeReceiptScan(h, june);
    expect((await failure(consumeReceiptScan(h, june))).code).toBe("plan_limit");
    expect(await receiptScanAllowance(h, june)).toMatchObject({ used: 5, limit: 5, remaining: 0, period: "2026-06" });
    // Scans reset with the calendar month, and the failed sixth was given back.
    await expect(consumeReceiptScan(h, july)).resolves.toBe("2026-07");
    expect(await receiptScanAllowance(h, july)).toMatchObject({ used: 1, remaining: 4 });
    const [june5] = await systemDb.select().from(usageCounters).where(and(eq(usageCounters.householdId, h.household.id), eq(usageCounters.period, "2026-06")));
    expect(june5.count).toBe(5);

    const sub = uid("sub");
    await go(nev("web", h.household.id, sub, started("web", "plus", "monthly", at(0), future(30))), new Date());
    const plus = await refresh(h);
    for (let i = 0; i < 8; i++) await consumeReceiptScan(plus, june);
    expect((await receiptScanAllowance(plus, june)).limit).toBeNull();

    await go(nev("web", h.household.id, sub, { type: "refunded", occurredAt: new Date() }), new Date(Date.now() + 1000));
    const back = await refresh(h);
    expect(back.plan.plan).toBe("free");
    expect((await failure(consumeReceiptScan(back, june))).code).toBe("plan_limit");
    await expect(consumeReceiptScan(back, new Date("2026-09-15T03:00:00Z"))).resolves.toBe("2026-09");
  });
});

// ─── The service: overview, checkout, portal, confirm ───────────────────────

describe("billing overview", () => {
  it("shows a free household its limits and what it can buy on the web, without ever offering Pro", async () => {
    const { owner, member } = await householdWithMember();
    const overview = await getBillingOverview(owner);
    expect(overview).toMatchObject({ plan: "free", reason: "no_subscription", summary: "You're on the free plan.", provider: null, management: null, willRenew: false, overridden: false });
    expect(overview.usage.members.limit).toBe(2);
    expect(overview.usage.items.limit).toBe(50);
    expect(overview.usage.receiptScans).toMatchObject({ used: 0, limit: 5, remaining: 5 });
    expect(overview.purchase).toMatchObject({ platform: "web", canStartCheckout: true, blockedReason: null, trialDays: 0, providers: { web: true } });
    expect(overview.purchase.options.map((o) => `${o.plan}.${o.period}:${o.web}`)).toEqual(["plus.monthly:true", "plus.annual:true", "family.monthly:true", "family.annual:true"]);
    expect(overview.purchase.options.find((o) => o.plan === "plus" && o.period === "annual")).toMatchObject({ priceText: "$49.99 a year", planName: "Plenty Plus" });
    expect(JSON.stringify(overview)).not.toMatch(/pro\b/i);

    const asMember = await getBillingOverview(member);
    expect(asMember.purchase).toMatchObject({ canStartCheckout: false, blockedReason: "Only a household owner can change the plan." });
    expect(asMember.management).toBeNull();
  });

  it("describes a paid web subscription and where to manage it", async () => {
    const h = await fresh();
    await go(nev("web", h.household.id, uid("sub"), started("web", "plus", "annual", at(0), future(200))), new Date());
    await go(nev("web", h.household.id, null, { type: "auto_renew_off", occurredAt: new Date() }, { link: { providerSubscriptionId: (await rowOf(h.household.id)).providerSubscriptionId, householdId: h.household.id } }), new Date(Date.now() + 1000));
    const o = await getBillingOverview(h);
    expect(o).toMatchObject({ plan: "plus", reason: "cancelled_until_period_end", provider: "web", period: "annual", priceText: "$49.99 a year", willRenew: false });
    expect(o.summary).toMatch(/Plenty Plus is cancelled\. You keep it until .+, and it won't renew\./);
    expect(o.management).toMatchObject({ kind: "web_portal", canManage: true, portal: true, url: null, label: "Manage billing" });
    expect(o.purchase.canStartCheckout).toBe(false);
    expect(o.purchase.blockedReason).toMatch(/already have a subscription/);
  });

  it("points store subscriptions at the store's own settings", async () => {
    const apple = await fresh();
    await go(nev("apple", apple.household.id, uid("orig"), started("apple", "family", "monthly", at(0), future(20))), new Date());
    expect((await getBillingOverview(apple)).management).toMatchObject({ kind: "app_store", url: APPLE_MANAGE_URL, portal: false, label: "Manage in Apple ID settings" });
    const google = await fresh();
    await go(nev("google", google.household.id, uid("gtok"), started("google", "plus", "monthly", at(0), future(20), {}), {}), new Date());
    await systemDb.update(subscriptions).set({ providerProductId: "app.plenty.plus.monthly" }).where(eq(subscriptions.householdId, google.household.id));
    const g = await getBillingOverview(google);
    expect(g.management).toMatchObject({ kind: "google_play", portal: false });
    expect(g.management?.url).toBe(`https://play.google.com/store/account/subscriptions?sku=app.plenty.plus.monthly&package=${GOOGLE_PACKAGE}`);
    expect(g.purchase.blockedReason).toMatch(/through Google Play/);
  });

  it("explains each way a plan can lapse, in plain words", async () => {
    const h = await fresh();
    const sub = uid("sub");
    await go(nev("web", h.household.id, sub, started("web", "family", "monthly", at(0), at(30))), at(0));
    const refunded = nev("web", h.household.id, sub, { type: "refunded", occurredAt: at(5) });
    await go(refunded, at(5));
    const o = await getBillingOverview(h, { now: at(6) });
    expect(o).toMatchObject({ plan: "free", reason: "refunded", subscribedPlan: "family", summary: "Plenty Family was refunded, so you're on the free plan." });
    expect(o.management).toBeNull(); // nothing left to manage
    expect(o.purchase.canStartCheckout).toBe(true); // and they can subscribe again
  });

  it("inside the iOS and Android shells there is no web checkout, no portal link and no web price steering", async () => {
    const h = await fresh();
    for (const platform of ["ios", "android"] as const) {
      const o = await getBillingOverview(h, { platform });
      expect(o.purchase.canStartCheckout).toBe(false);
      expect(o.purchase.options.every((x) => x.web === false)).toBe(true);
      expect(o.purchase.platform).toBe(platform);
    }
    if (chain) {
      const ios = (await getBillingOverview(h, { platform: "ios" })).purchase.store;
      expect(ios).toMatchObject({ provider: "apple", available: true });
      expect(ios.products.map((p) => p.productId)).toEqual(["app.plenty.plus.monthly", "app.plenty.plus.annual", "app.plenty.family.monthly", "app.plenty.family.annual"]);
    }
    const android = (await getBillingOverview(h, { platform: "android" })).purchase.store;
    expect(android).toMatchObject({ provider: "google", available: true });
    expect((await getBillingOverview(h)).purchase.store).toEqual({ provider: null, available: false, products: [] });

    // A web subscription seen from a native shell is explained in words, with no link.
    await go(nev("web", h.household.id, uid("sub"), started("web", "plus", "monthly", at(0), future(20))), new Date());
    const o = await getBillingOverview(h, { platform: "ios" });
    expect(o.management).toMatchObject({ kind: "web_portal", portal: false, url: null, label: "Managed on the web" });
    expect(o.management?.text).toMatch(/web browser/);
    expect(JSON.stringify(o)).not.toMatch(/https?:\/\//);
  });

  it("offers nothing on the web when Stripe isn't configured, and says nothing alarming", async () => {
    mocks.stripeOff = true;
    const h = await fresh();
    const o = await getBillingOverview(h);
    expect(o.purchase).toMatchObject({ canStartCheckout: false, blockedReason: null, providers: { web: false } });
    expect(o.purchase.options.every((x) => x.web === false)).toBe(true);
  });
});

describe("starting checkout", () => {
  it("creates a hosted checkout tied to this household, for an owner", async () => {
    const h = await fresh();
    await expect(startWebCheckout(h, "plus", "monthly")).resolves.toEqual({ url: "https://checkout.stripe.test/c/pay_synthetic" });
    expect(mocks.checkoutCalls).toHaveLength(1);
    expect(mocks.checkoutCalls[0]).toMatchObject({
      householdId: h.household.id,
      userId: h.user.id,
      plan: "plus",
      period: "monthly",
      customerId: null,
      email: h.user.email,
      successUrl: "https://plenty.test/settings/plan?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://plenty.test/settings/plan?checkout=cancelled",
    });
  });

  it("reuses the household's Stripe customer after a previous web subscription ended", async () => {
    const h = await fresh();
    const sub = uid("sub");
    await go(nev("web", h.household.id, sub, started("web", "plus", "monthly", at(0), at(30))), at(0));
    await go(nev("web", h.household.id, sub, { type: "expired", occurredAt: at(30), periodEnd: at(30) }), at(30));
    await startWebCheckout(h, "family", "annual");
    expect(mocks.checkoutCalls[0]).toMatchObject({ customerId: `cus_${sub}`, plan: "family", period: "annual" });
  });

  it("refuses Pro, the free plan, nonsense, and anyone but an owner", async () => {
    const { owner, member } = await householdWithMember();
    expect((await failure(startWebCheckout(owner, "pro", "monthly"))).message).toBe("That plan isn't available yet.");
    expect((await failure(startWebCheckout(owner, "pro", "annual"))).code).toBe("validation");
    expect((await failure(startWebCheckout(owner, "free", "monthly"))).code).toBe("validation");
    expect((await failure(startWebCheckout(owner, "enterprise", "monthly"))).code).toBe("validation");
    expect((await failure(startWebCheckout(owner, "plus", "weekly"))).code).toBe("validation");
    expect((await failure(startWebCheckout(member, "plus", "monthly"))).code).toBe("forbidden");
    expect(mocks.checkoutCalls).toHaveLength(0);
  });

  it("refuses when already subscribed: same plan, other plan, store subscription, or one in trouble", async () => {
    const same = await fresh();
    await go(nev("web", same.household.id, uid("sub"), started("web", "plus", "monthly", at(0), future(20))), new Date());
    expect((await failure(startWebCheckout(same, "plus", "monthly"))).message).toMatch(/already on Plenty Plus, paid monthly/);
    expect((await failure(startWebCheckout(same, "family", "monthly"))).message).toMatch(/open Manage billing/);

    const store = await fresh();
    await go(nev("apple", store.household.id, uid("orig"), started("apple", "plus", "monthly", at(0), future(20))), new Date());
    expect((await failure(startWebCheckout(store, "family", "monthly"))).message).toMatch(/through the App Store/);

    const failing = await fresh();
    const sub = uid("sub");
    await go(nev("web", failing.household.id, sub, started("web", "plus", "monthly", at(0), future(5))), new Date());
    await go(nev("web", failing.household.id, sub, { type: "payment_failed", occurredAt: new Date(), graceEndsAt: new Date(future(3)) }), new Date(Date.now() + 1000));
    expect((await failure(startWebCheckout(failing, "plus", "annual"))).message).toMatch(/problem with your current subscription/);
    expect(mocks.checkoutCalls).toHaveLength(0);
  });

  it("is unavailable, with a plain message, when Stripe isn't set up or a native shell asks", async () => {
    const h = await fresh();
    mocks.stripeOff = true;
    expect((await failure(startWebCheckout(h, "plus", "monthly"))).message).toMatch(/isn't available right now\. Everything on your current plan keeps working/);
    mocks.stripeOff = false;
    for (const platform of ["ios", "android"] as const) {
      const err = await failure(startWebCheckout(h, "plus", "monthly", { platform }));
      expect(err.code).toBe("forbidden");
      expect(err.message).toMatch(/App Store or Google Play/);
      expect((await failure(createPortalSession(h, { platform }))).code).toBe("forbidden");
    }
    expect(mocks.checkoutCalls).toHaveLength(0);
  });
});

describe("billing portal and confirming a checkout", () => {
  it("opens the portal for the household's own customer, owners only", async () => {
    const { owner, member } = await householdWithMember();
    expect((await failure(createPortalSession(owner))).code).toBe("not_found");
    const sub = uid("sub");
    await go(nev("web", owner.household.id, sub, started("web", "plus", "monthly", at(0), future(20))), new Date());
    await expect(createPortalSession(owner)).resolves.toEqual({ url: "https://billing.stripe.test/p/session_synthetic" });
    expect(mocks.portalCalls).toEqual([{ customerId: `cus_${sub}`, returnUrl: "https://plenty.test/settings/plan" }]);
    expect((await failure(createPortalSession(member))).code).toBe("forbidden");
    mocks.stripeOff = true;
    expect((await failure(createPortalSession(owner))).message).toMatch(/isn't available right now/);
  });

  it("won't open the web portal for a store subscription", async () => {
    const h = await fresh();
    await go(nev("apple", h.household.id, uid("orig"), started("apple", "plus", "monthly", at(0), future(20))), new Date());
    expect((await failure(createPortalSession(h))).message).toMatch(/App Store or Google Play/);
  });

  it("confirms a purchase on return from checkout, idempotently, and only for this household's own session", async () => {
    const h = await fresh();
    const sub = stripeSubFor(h.household.id);
    mocks.stripeSession = { id: "cs_test_abcdef123456", mode: "subscription", client_reference_id: h.household.id, subscription: sub };
    await expect(confirmWebCheckout(h, "cs_test_abcdef123456")).resolves.toEqual({ confirmed: true });
    expect(await rowOf(h.household.id)).toMatchObject({ provider: "web", plan: "plus", status: "active", providerSubscriptionId: sub.id });
    await expect(confirmWebCheckout(h, "cs_test_abcdef123456")).resolves.toEqual({ confirmed: true });
    expect(await analyticsFor(h.household.id, "subscription_started")).toHaveLength(1);

    const other = await fresh();
    mocks.stripeSession = { id: "cs_test_zzzzzz999999", mode: "subscription", client_reference_id: h.household.id, subscription: sub };
    expect((await failure(confirmWebCheckout(other, "cs_test_zzzzzz999999"))).code).toBe("forbidden");
    expect(await rowOf(other.household.id)).toBeUndefined();
    expect((await failure(confirmWebCheckout(h, "../etc/passwd"))).code).toBe("validation");
  });

  it("a checkout whose payment hasn't completed grants nothing", async () => {
    const h = await fresh();
    mocks.stripeSession = { id: "cs_test_pending12345", mode: "subscription", client_reference_id: h.household.id, subscription: stripeSubFor(h.household.id, { status: "incomplete" }) };
    await confirmWebCheckout(h, "cs_test_pending12345");
    expect(await rowOf(h.household.id)).toBeUndefined();
  });
});

describe("store account token", () => {
  it("is given to owners only, and identifies the household without revealing its id", async () => {
    const { owner, member } = await householdWithMember();
    const { token } = getStoreAccountToken(owner);
    expect(token).toBe(accountTokenFor(owner.household.id, ACCOUNT_SECRET));
    expect(token).not.toContain(owner.household.id);
    expect((await failure(Promise.resolve().then(() => getStoreAccountToken(member)))).code).toBe("forbidden");
  });
});

// ─── Restore purchases ──────────────────────────────────────────────────────

describe.skipIf(!chain)("restoring an App Store purchase (synthetic certificate chain)", () => {
  const liveTx = (orig: string, over: Record<string, unknown> = {}) => appleTransaction({ originalTransactionId: orig, transactionId: `${orig}-t`, purchaseDate: Date.now() - DAY, expiresDate: future(20), ...over });
  const proofFor = (orig: string, txOver: Record<string, unknown> = {}, renewalOver: Record<string, unknown> = {}) => ({
    provider: "apple",
    signedTransaction: chain!.sign(liveTx(orig, txOver)),
    signedRenewalInfo: chain!.sign(appleRenewal({ originalTransactionId: orig, ...renewalOver })),
  });

  it("links a verified subscription to this household", async () => {
    const h = await fresh();
    const orig = uid("orig");
    const result = await restorePurchases(h, "apple", proofFor(orig));
    expect(result.outcome).toBe("linked");
    expect(result.message).toMatch(/Plenty Plus is now part of your household\. It's billed by the App Store/);
    expect(await rowOf(h.household.id)).toMatchObject({ provider: "apple", providerSubscriptionId: orig, plan: "plus", status: "active", purchaserUserId: h.user.id, autoRenew: true });
    expect((await planAt(h.household.id, new Date())).plan).toBe("plus");
    // Doing it again is harmless and says so.
    expect((await restorePurchases(h, "apple", proofFor(orig))).outcome).toBe("already_linked");
  });

  it("never moves a subscription that belongs to another household", async () => {
    const a = await fresh();
    const b = await fresh();
    const orig = uid("orig");
    await restorePurchases(a, "apple", proofFor(orig));
    const err = await failure(restorePurchases(b, "apple", proofFor(orig)));
    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/already belongs to another household/);
    expect(err.message).toMatch(/never moves it/);
    expect(await rowOf(b.household.id)).toBeUndefined();
    expect(await rowOf(a.household.id)).toMatchObject({ providerSubscriptionId: orig, status: "active" });
  });

  it("refuses a purchase that was made for another household, when that household exists", async () => {
    const a = await fresh();
    const b = await fresh();
    const token = accountTokenFor(a.household.id, ACCOUNT_SECRET);
    const err = await failure(restorePurchases(b, "apple", proofFor(uid("orig"), { appAccountToken: token })));
    expect(err.message).toMatch(/already belongs to another household/);
    expect(await rowOf(b.household.id)).toBeUndefined();
    // The household it was made for can restore it.
    expect((await restorePurchases(a, "apple", proofFor(uid("orig"), { appAccountToken: token }))).outcome).toBe("linked");
  });

  it("won't replace a different subscription that is giving access", async () => {
    const h = await fresh();
    await go(nev("web", h.household.id, uid("sub"), started("web", "plus", "monthly", at(0), future(20))), new Date());
    const err = await failure(restorePurchases(h, "apple", proofFor(uid("orig"))));
    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/already has Plenty Plus through the web/);
    expect((await rowOf(h.household.id)).provider).toBe("web");
  });

  it("restores into a household whose own subscription has ended", async () => {
    const h = await fresh();
    const sub = uid("sub");
    await go(nev("web", h.household.id, sub, started("web", "plus", "monthly", at(0), at(30))), at(0));
    await go(nev("web", h.household.id, sub, { type: "expired", occurredAt: at(30) }), at(30));
    expect((await restorePurchases(h, "apple", proofFor(uid("orig")))).outcome).toBe("linked");
    expect((await rowOf(h.household.id)).provider).toBe("apple");
  });

  it("says plainly when there is nothing to restore", async () => {
    const h = await fresh();
    const ended = await restorePurchases(h, "apple", proofFor(uid("orig"), { expiresDate: Date.now() - 5 * DAY }, { autoRenewStatus: 0 }));
    expect(ended).toMatchObject({ outcome: "nothing_to_restore" });
    expect(ended.message).toMatch(/nothing to restore/i);
    const refunded = await restorePurchases(h, "apple", proofFor(uid("orig"), { revocationDate: Date.now() - DAY }));
    expect(refunded.outcome).toBe("nothing_to_restore");
    expect(refunded.message).toMatch(/refunded/);
    expect(await rowOf(h.household.id)).toBeUndefined();
  });

  it("refuses what Apple's checks refuse, and anyone but an owner", async () => {
    const { owner, member } = await householdWithMember();
    const forged = { provider: "apple", signedTransaction: chain!.forge(liveTx(uid("orig"))) };
    const err = await failure(restorePurchases(owner, "apple", forged));
    expect(err.message).toMatch(/wouldn't confirm that purchase/);
    expect((await failure(restorePurchases(owner, "apple", { provider: "apple" }))).code).toBe("validation");
    expect((await failure(restorePurchases(owner, "apple", { provider: "apple", signedTransaction: "x".repeat(30_000) }))).code).toBe("validation");
    expect((await failure(restorePurchases(member, "apple", proofFor(uid("orig"))))).code).toBe("forbidden");
    expect((await failure(restorePurchases(owner, "windows", {}))).code).toBe("validation");
    expect(await rowOf(owner.household.id)).toBeUndefined();
  });

  it("a later notification for a restored subscription goes to the household that holds it, whatever the token says", async () => {
    const a = await fresh();
    const b = await fresh();
    const orig = uid("orig");
    await restorePurchases(a, "apple", proofFor(orig));
    const forgedHint = accountTokenFor(b.household.id, ACCOUNT_SECRET);
    const jws = appleNotification(chain!, { type: "DID_CHANGE_RENEWAL_STATUS", subtype: "AUTO_RENEW_DISABLED", uuid: uid("uuid"), transaction: liveTx(orig, { appAccountToken: forgedHint }), renewal: appleRenewal({ originalTransactionId: orig, autoRenewStatus: 0 }) });
    const res = await sendApple(jws);
    expect(res.status).toBe(200);
    expect(await rowOf(a.household.id)).toMatchObject({ autoRenew: false, status: "canceled" });
    expect(await rowOf(b.household.id)).toBeUndefined();
  });
});

describe("restoring a Google Play purchase (synthetic)", () => {
  const purchase = (over: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => ({
    latestOrderId: "GPA.synthetic-1",
    startTime: new Date(Date.now() - DAY).toISOString(),
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    lineItems: [{ productId: "app.plenty.family.annual", expiryTime: new Date(future(300)).toISOString(), autoRenewingPlan: { autoRenewEnabled: true }, ...item }],
    ...over,
  });
  const token = () => `gtoken-${uid("p")}-0123456789`;

  it("links it, acknowledges it so Google doesn't refund it, and refuses to move it afterwards", async () => {
    const a = await fresh();
    const b = await fresh();
    const t = token();
    mocks.googleTokens.set(t, purchase());
    const result = await restorePurchases(a, "google", { provider: "google", purchaseToken: t });
    expect(result.outcome).toBe("linked");
    expect(await rowOf(a.household.id)).toMatchObject({ provider: "google", providerSubscriptionId: t, plan: "family", period: "annual", status: "active" });
    expect(mocks.googleAcks).toEqual([t]);

    const err = await failure(restorePurchases(b, "google", { provider: "google", purchaseToken: t }));
    expect(err.message).toMatch(/already belongs to another household/);
    expect(await rowOf(b.household.id)).toBeUndefined();
    expect(mocks.googleAcks).toEqual([t]);
  });

  it("explains an unknown, pending or ended purchase, and acknowledges none of them", async () => {
    const h = await fresh();
    const unknown = await restorePurchases(h, "google", { provider: "google", purchaseToken: token() });
    expect(unknown.outcome).toBe("nothing_to_restore");
    expect(unknown.message).toMatch(/doesn't recognise/);
    const pending = token();
    mocks.googleTokens.set(pending, purchase({ subscriptionState: "SUBSCRIPTION_STATE_PENDING" }));
    expect((await restorePurchases(h, "google", { provider: "google", purchaseToken: pending })).message).toMatch(/still being processed/);
    const ended = token();
    mocks.googleTokens.set(ended, purchase({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" }));
    expect((await restorePurchases(h, "google", { provider: "google", purchaseToken: ended })).message).toMatch(/nothing to restore/i);
    expect(mocks.googleAcks).toEqual([]);
    expect(await rowOf(h.household.id)).toBeUndefined();
    expect((await failure(restorePurchases(h, "google", { provider: "google", purchaseToken: "short" }))).code).toBe("validation");
  });

  it("a purchase made for another household can't be restored here", async () => {
    const a = await fresh();
    const b = await fresh();
    const t = token();
    mocks.googleTokens.set(t, purchase({ externalAccountIdentifiers: { obfuscatedExternalAccountId: accountTokenFor(a.household.id, ACCOUNT_SECRET) } }));
    expect((await failure(restorePurchases(b, "google", { provider: "google", purchaseToken: t }))).message).toMatch(/already belongs to another household/);
    expect((await restorePurchases(a, "google", { provider: "google", purchaseToken: t })).outcome).toBe("linked");
  });
});

// ─── Webhook routes ─────────────────────────────────────────────────────────

describe("Stripe webhook route", () => {
  it("applies a correctly signed event once, and a replay is acknowledged without changing anything", async () => {
    const h = await fresh();
    const sub = stripeSubFor(h.household.id);
    const event = stripeEvent("customer.subscription.created", sub, { id: uid("evt"), created: sec(Date.now() - 1000) });
    const first = await sendStripe(event);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, outcome: "applied" });
    expect(await rowOf(h.household.id)).toMatchObject({ provider: "web", plan: "plus", status: "active", providerSubscriptionId: sub.id, providerCustomerId: `cus_${sub.id}` });

    const replay = await sendStripe(event);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ outcome: "duplicate" });
    expect(await systemDb.select().from(billingEvents).where(eq(billingEvents.eventId, event.id))).toHaveLength(1);
  });

  it("refuses a bad or missing signature, and a tampered body, applying nothing", async () => {
    const h = await fresh();
    const event = stripeEvent("customer.subscription.created", stripeSubFor(h.household.id), { id: uid("evt"), created: sec(Date.now() - 1000) });
    expect((await sendStripe(event, (b) => b.replace("active", "actives"))).status).toBe(400);
    expect((await stripeWebhook(post("/api/billing/webhooks/stripe", JSON.stringify(event)))).status).toBe(400);
    expect((await stripeWebhook(post("/api/billing/webhooks/stripe", JSON.stringify(event), { "stripe-signature": "t=1,v1=00" }))).status).toBe(400);
    const wrongSecret = Stripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(event), secret: "whsec_someone_else" });
    expect((await stripeWebhook(post("/api/billing/webhooks/stripe", JSON.stringify(event), { "stripe-signature": wrongSecret }))).status).toBe(400);
    expect(await rowOf(h.household.id)).toBeUndefined();
    expect(await systemDb.select().from(billingEvents).where(eq(billingEvents.eventId, event.id))).toHaveLength(0);
  });

  it("answers 503 when Stripe isn't configured, 405 to a GET and 413 to an oversized body", async () => {
    mocks.stripeOff = true;
    const res = await sendStripe(stripeEvent("customer.created", { id: "cus_x" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "not_configured" });
    mocks.stripeOff = false;
    expect(stripeWebhookGet().status).toBe(405);
    const big = await stripeWebhook(post("/api/billing/webhooks/stripe", "x", { "content-length": "5000000", "stripe-signature": "t=1,v1=00" }));
    expect(big.status).toBe(413);
  });

  it("handles delivery out of order: a later cancellation is not undone by an earlier creation", async () => {
    const h = await fresh();
    const sub = stripeSubFor(h.household.id);
    const t = Date.now() - 60_000;
    const cancelled = stripeEvent("customer.subscription.updated", { ...sub, cancel_at_period_end: true }, { id: uid("evt"), created: sec(t + 30_000) });
    const created = stripeEvent("customer.subscription.created", sub, { id: uid("evt"), created: sec(t) });
    expect(await (await sendStripe(cancelled)).json()).toMatchObject({ outcome: "applied" });
    expect(await (await sendStripe(created)).json()).toMatchObject({ outcome: "unchanged" });
    expect(await rowOf(h.household.id)).toMatchObject({ status: "canceled", autoRenew: false, plan: "plus" });
    expect((await planAt(h.household.id, new Date())).reason).toBe("cancelled_until_period_end");
  });

  it("a renewal that arrives before its subscription gets 503 so Stripe sends it again", async () => {
    const h = await fresh();
    const sub = stripeSubFor(h.household.id);
    const invoice = {
      id: "in_synthetic",
      billing_reason: "subscription_cycle",
      customer: sub.customer,
      parent: { subscription_details: { subscription: sub.id, metadata: { household_id: h.household.id } } },
      lines: { data: [{ period: { start: sec(Date.now() - DAY), end: sec(future(29)) }, pricing: { price_details: { price: STRIPE_PRICES["plus.monthly"] } } }] },
    };
    const paid = stripeEvent("invoice.paid", invoice, { id: uid("evt"), created: sec(Date.now() - 1000) });
    const early = await sendStripe(paid);
    expect(early.status).toBe(503);
    await sendStripe(stripeEvent("customer.subscription.created", sub, { id: uid("evt"), created: sec(Date.now() - 5000) }));
    const again = await sendStripe(paid);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ outcome: "applied" });
  });

  it("a failed renewal payment starts the grace period; a full refund ends access", async () => {
    const h = await fresh();
    const sub = stripeSubFor(h.household.id);
    await sendStripe(stripeEvent("customer.subscription.created", sub, { id: uid("evt"), created: sec(Date.now() - 20_000) }));
    const periodEnd = sec(future(20)) * 1000;
    const failed = stripeEvent(
      "invoice.payment_failed",
      // On a renewal invoice the line's period is the NEW one, starting where the paid period ends.
      { id: "in_f", billing_reason: "subscription_cycle", customer: sub.customer, subscription: sub.id, lines: { data: [{ period: { start: sec(periodEnd), end: sec(periodEnd + 30 * DAY) } }] } },
      { id: uid("evt"), created: sec(Date.now() - 10_000) },
    );
    expect(await (await sendStripe(failed)).json()).toMatchObject({ outcome: "applied" });
    expect(await rowOf(h.household.id)).toMatchObject({ status: "past_due" });
    expect(await billingNotices(h.household.id)).toHaveLength(1);

    mocks.chargeResolver = async () => ({ subscriptionId: sub.id, periodEnd: null });
    const refund = stripeEvent("charge.refunded", { id: "ch_1", customer: sub.customer, refunded: true, payment_intent: "pi_1" }, { id: uid("evt"), created: sec(Date.now() - 1000) });
    expect(await (await sendStripe(refund)).json()).toMatchObject({ outcome: "applied" });
    expect(await rowOf(h.household.id)).toMatchObject({ status: "refunded" });
    expect((await planAt(h.household.id, new Date())).plan).toBe("free");
  });

  it("an event with no household is acknowledged (so Stripe stops retrying) and applies to nothing", async () => {
    const sub = stripeSubFor("00000000-0000-4000-8000-000000000000", { metadata: {} });
    const res = await sendStripe(stripeEvent("customer.subscription.created", sub, { id: uid("evt"), created: sec(Date.now() - 1000) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "unlinked" });
  });

  it("an event for a different household's metadata can't take over a linked subscription", async () => {
    const a = await fresh();
    const b = await fresh();
    const sub = stripeSubFor(a.household.id);
    await sendStripe(stripeEvent("customer.subscription.created", sub, { id: uid("evt"), created: sec(Date.now() - 20_000) }));
    const spoofed = { ...sub, metadata: { household_id: b.household.id }, cancel_at_period_end: true };
    await sendStripe(stripeEvent("customer.subscription.updated", spoofed, { id: uid("evt"), created: sec(Date.now() - 10_000) }));
    expect(await rowOf(a.household.id)).toMatchObject({ autoRenew: false });
    expect(await rowOf(b.household.id)).toBeUndefined();
  });
});

describe.skipIf(!chain)("App Store webhook route (synthetic certificate chain)", () => {
  const tx = (orig: string, over: Record<string, unknown> = {}) => appleTransaction({ originalTransactionId: orig, transactionId: `${orig}-t`, purchaseDate: Date.now() - DAY, expiresDate: future(20), ...over });
  const renewal = (orig: string, over: Record<string, unknown> = {}) => appleRenewal({ originalTransactionId: orig, ...over });

  it("starts a subscription for the household named by its account token, then applies the lifecycle", async () => {
    const h = await fresh();
    const orig = uid("orig");
    const token = accountTokenFor(h.household.id, ACCOUNT_SECRET);
    const start = appleNotification(chain!, { type: "SUBSCRIBED", subtype: "INITIAL_BUY", uuid: uid("uuid"), transaction: tx(orig, { appAccountToken: token }), renewal: renewal(orig) });
    const res = await sendApple(start);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "applied" });
    expect(await rowOf(h.household.id)).toMatchObject({ provider: "apple", providerSubscriptionId: orig, plan: "plus", period: "monthly", status: "active" });
    expect((await sendApple(start)).status).toBe(200);
    expect(await systemDb.select().from(subscriptions).where(eq(subscriptions.providerSubscriptionId, orig))).toHaveLength(1);

    // Billing trouble with a grace period, then recovery by renewing.
    const graceEnd = future(6);
    await sendApple(appleNotification(chain!, { type: "DID_FAIL_TO_RENEW", subtype: "GRACE_PERIOD", uuid: uid("uuid"), transaction: tx(orig), renewal: renewal(orig, { isInBillingRetryPeriod: true, gracePeriodExpiresDate: graceEnd }) }));
    expect(await rowOf(h.household.id)).toMatchObject({ status: "past_due", graceEndsAt: new Date(graceEnd) });
    expect(await billingNotices(h.household.id)).toHaveLength(1);
    await sendApple(appleNotification(chain!, { type: "DID_RENEW", uuid: uid("uuid"), transaction: tx(orig, { expiresDate: future(50) }), renewal: renewal(orig) }));
    expect(await rowOf(h.household.id)).toMatchObject({ status: "active", graceEndsAt: null });

    // A refund ends access.
    await sendApple(appleNotification(chain!, { type: "REFUND", uuid: uid("uuid"), transaction: tx(orig, { expiresDate: future(50), revocationDate: Date.now() }), renewal: renewal(orig) }));
    expect(await rowOf(h.household.id)).toMatchObject({ status: "refunded" });
    expect((await planAt(h.household.id, new Date())).plan).toBe("free");
  });

  it("refuses forged or foreign payloads with 400, and malformed bodies with 400, applying nothing", async () => {
    const h = await fresh();
    const orig = uid("orig");
    const token = accountTokenFor(h.household.id, ACCOUNT_SECRET);
    const forged = chain!.forge({ notificationType: "SUBSCRIBED", subtype: "INITIAL_BUY", notificationUUID: uid("uuid"), version: "2.0", signedDate: Date.now(), data: { environment: "Sandbox", bundleId: APPLE_BUNDLE, signedTransactionInfo: chain!.sign(tx(orig, { appAccountToken: token })) } });
    expect((await sendApple(forged)).status).toBe(400);
    const otherApp = appleNotification(chain!, { type: "SUBSCRIBED", subtype: "INITIAL_BUY", uuid: uid("uuid"), bundleId: "com.someone.else", transaction: tx(orig, { appAccountToken: token }) });
    expect((await sendApple(otherApp)).status).toBe(400);
    expect((await appleWebhook(post("/api/billing/webhooks/apple", "not json"))).status).toBe(400);
    expect((await appleWebhook(post("/api/billing/webhooks/apple", JSON.stringify({ nothing: true })))).status).toBe(400);
    expect(await rowOf(h.household.id)).toBeUndefined();
  });

  it("acknowledges a purchase with no identifiable household without applying it", async () => {
    const res = await sendApple(appleNotification(chain!, { type: "SUBSCRIBED", subtype: "INITIAL_BUY", uuid: uid("uuid"), transaction: tx(uid("orig")), renewal: renewal("x") }));
    // The renewal's original transaction differs from the transaction's, but linking uses the transaction's id.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "unlinked" });
  });
});

describe("Google Play webhook route (verified push, subscription fetched from the API)", () => {
  const purchase = (householdId: string | null, over: Record<string, unknown> = {}) => ({
    latestOrderId: "GPA.route-1",
    startTime: new Date(Date.now() - DAY).toISOString(),
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    lineItems: [{ productId: "app.plenty.plus.annual", expiryTime: new Date(future(300)).toISOString(), autoRenewingPlan: { autoRenewEnabled: true } }],
    ...(householdId ? { externalAccountIdentifiers: { obfuscatedExternalAccountId: accountTokenFor(householdId, ACCOUNT_SECRET) } } : {}),
    ...over,
  });
  const sub = (purchaseToken: string, notificationType: number) => ({ packageName: GOOGLE_PACKAGE, eventTimeMillis: String(Date.now()), subscriptionNotification: { version: "1.0", notificationType, purchaseToken } });

  it("starts, acknowledges, and is idempotent per Pub/Sub message", async () => {
    const h = await fresh();
    const t = `gtoken-${uid("r")}-0123456789`;
    mocks.googleTokens.set(t, purchase(h.household.id));
    const messageId = uid("msg");
    const first = await sendGoogle(sub(t, 4), messageId);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, outcome: "applied" });
    expect(await rowOf(h.household.id)).toMatchObject({ provider: "google", providerSubscriptionId: t, plan: "plus", period: "annual", status: "active" });
    expect(mocks.googleAcks).toEqual([t]);

    const replay = await sendGoogle(sub(t, 4), messageId);
    expect(await replay.json()).toMatchObject({ outcome: "duplicate" });
    expect(mocks.googleAcks).toEqual([t]);
  });

  it("applies the state Google reports, whatever the notification type says", async () => {
    const h = await fresh();
    const t = `gtoken-${uid("r")}-0123456789`;
    mocks.googleTokens.set(t, purchase(h.household.id));
    await sendGoogle(sub(t, 4));
    mocks.googleTokens.set(t, purchase(h.household.id, { subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", lineItems: [{ productId: "app.plenty.plus.annual", expiryTime: new Date(future(3)).toISOString(), autoRenewingPlan: { autoRenewEnabled: true } }] }));
    await sendGoogle(sub(t, 6));
    expect(await rowOf(h.household.id)).toMatchObject({ status: "past_due" });
    expect((await planAt(h.household.id, new Date())).reason).toBe("grace_period");
    mocks.googleTokens.set(t, purchase(h.household.id, { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", lineItems: [{ productId: "app.plenty.plus.annual", expiryTime: new Date(Date.now() - 1000).toISOString(), autoRenewingPlan: null }] }));
    await sendGoogle(sub(t, 13));
    expect((await planAt(h.household.id, new Date())).plan).toBe("free");
  });

  it("a voided (refunded) subscription purchase ends access", async () => {
    const h = await fresh();
    const t = `gtoken-${uid("r")}-0123456789`;
    mocks.googleTokens.set(t, purchase(h.household.id));
    await sendGoogle(sub(t, 4));
    const res = await sendGoogle({ packageName: GOOGLE_PACKAGE, voidedPurchaseNotification: { purchaseToken: t, orderId: "GPA.route-1", productType: 1, refundType: 1 } });
    expect(await res.json()).toMatchObject({ outcome: "applied" });
    expect(await rowOf(h.household.id)).toMatchObject({ status: "refunded" });
  });

  it("refuses an unauthenticated push with 400, applying nothing", async () => {
    const h = await fresh();
    const t = `gtoken-${uid("r")}-0123456789`;
    mocks.googleTokens.set(t, purchase(h.household.id));
    expect((await sendGoogle(sub(t, 4), uid("msg"), null)).status).toBe(400);
    expect((await sendGoogle(sub(t, 4), uid("msg"), "forged-token")).status).toBe(400);
    expect((await googleWebhook(post("/api/billing/webhooks/google", "garbage", { authorization: "Bearer good-token" }))).status).toBe(400);
    expect(await rowOf(h.household.id)).toBeUndefined();
    expect(mocks.googleAcks).toEqual([]);
  });

  it("acknowledges (2xx) tests, other apps and unknown purchase tokens without applying anything", async () => {
    const test = await sendGoogle({ packageName: GOOGLE_PACKAGE, testNotification: { version: "1.0" } });
    expect(await test.json()).toMatchObject({ received: true, outcome: "test" });
    const other = await sendGoogle({ ...sub("tok-0123456789", 4), packageName: "com.someone.else" });
    expect(await other.json()).toMatchObject({ outcome: "ignored" });
    const unknown = await sendGoogle(sub("never-seen-0123456789", 4));
    expect(await unknown.json()).toMatchObject({ outcome: "ignored" });
  });

  it("answers 503 when Google can't be reached, so Pub/Sub redelivers", async () => {
    mocks.googleFetchFails = true;
    const res = await sendGoogle(sub("tok-0123456789", 2));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ retry: true });
  });

  it("an acknowledged purchase for a household that already has another subscription isn't acknowledged, so Google refunds it", async () => {
    const h = await fresh();
    await go(nev("web", h.household.id, uid("sub"), started("web", "plus", "monthly", at(0), future(20))), new Date());
    const t = `gtoken-${uid("r")}-0123456789`;
    mocks.googleTokens.set(t, purchase(h.household.id));
    const res = await sendGoogle(sub(t, 4));
    expect(await res.json()).toMatchObject({ outcome: "conflict" });
    expect(mocks.googleAcks).toEqual([]);
    expect((await rowOf(h.household.id)).provider).toBe("web");
  });
});

// ─── Household deletion ─────────────────────────────────────────────────────

describe("deleting a household", () => {
  it("cancels a web subscription so it isn't billed again, and tells the owner about store subscriptions", async () => {
    const web = await fresh();
    const sub = uid("sub");
    await go(nev("web", web.household.id, sub, started("web", "plus", "monthly", at(0), future(20))), new Date());
    expect(await prepareHouseholdDeletion(web.household.id)).toMatchObject({ webCancelled: true, storeManaged: null });
    expect(mocks.cancelCalls).toEqual([sub]);

    const apple = await fresh();
    await go(nev("apple", apple.household.id, uid("orig"), started("apple", "plus", "monthly", at(0), future(20))), new Date());
    const result = await prepareHouseholdDeletion(apple.household.id);
    expect(result).toMatchObject({ webCancelled: false, storeManaged: "apple" });
    expect(result.message).toMatch(/doesn't cancel it/);
    expect(mocks.cancelCalls).toEqual([sub]);

    const none = await fresh();
    expect(await prepareHouseholdDeletion(none.household.id)).toEqual({ webCancelled: false, storeManaged: null, message: null });
  });
});

// ─── Row-level security ─────────────────────────────────────────────────────

describe("row-level security on billing tables", () => {
  it("a member can read their own household's subscription and usage, and nobody else's", async () => {
    const { owner, member } = await householdWithMember();
    const stranger = await fresh();
    await go(nev("web", owner.household.id, uid("sub"), started("web", "plus", "monthly", at(0), at(30))), at(0));
    await go(nev("web", stranger.household.id, uid("sub"), started("web", "family", "monthly", at(0), at(30))), at(0));
    await systemDb.insert(usageCounters).values({ householdId: owner.household.id, metric: "receipt_scans", period: "2026-06", count: 2 });
    await systemDb.insert(usageCounters).values({ householdId: stranger.household.id, metric: "receipt_scans", period: "2026-06", count: 4 });

    for (const reader of [owner, member]) {
      const subs = await withUser(reader.user.id, (tx) => tx.select({ householdId: subscriptions.householdId, plan: subscriptions.plan }).from(subscriptions));
      expect(subs.map((s) => s.householdId)).toContain(owner.household.id);
      expect(subs.map((s) => s.householdId)).not.toContain(stranger.household.id);
      const counters = await withUser(reader.user.id, (tx) => tx.select().from(usageCounters));
      expect(counters.map((c) => c.householdId)).not.toContain(stranger.household.id);
      expect(counters.find((c) => c.householdId === owner.household.id)?.count).toBe(2);
    }
    // The stranger sees only their own.
    const theirs = await withUser(stranger.user.id, (tx) => tx.select({ householdId: subscriptions.householdId }).from(subscriptions));
    expect(theirs.map((s) => s.householdId)).toEqual([stranger.household.id]);
    // And asking for someone else's by id returns nothing.
    expect(await withUser(stranger.user.id, (tx) => tx.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.householdId, owner.household.id)))).toHaveLength(0);
  });

  it("the billing provider's own identifiers can't be read by the app role at all, even for the household's own subscription", async () => {
    const { owner } = await householdWithMember();
    await go(nev("web", owner.household.id, uid("sub"), started("web", "plus", "monthly", at(0), at(30))), at(0));
    for (const column of [subscriptions.providerCustomerId, subscriptions.providerSubscriptionId, subscriptions.providerProductId]) {
      await expect(withUser(owner.user.id, (tx) => tx.select({ value: column }).from(subscriptions))).rejects.toThrow();
    }
    // The whole row is refused too: a stray `select()` can't pull the identifiers in by accident.
    await expect(withUser(owner.user.id, (tx) => tx.select().from(subscriptions))).rejects.toThrow();
    // What the app does need is still there.
    const [row] = await withUser(owner.user.id, (tx) => tx.select({ plan: subscriptions.plan, provider: subscriptions.provider }).from(subscriptions).where(eq(subscriptions.householdId, owner.household.id)));
    expect(row.plan).toBe("plus");
  });

  it("the app role can never write subscriptions, billing events or usage, even for its own household", async () => {
    const h = await fresh();
    await go(nev("web", h.household.id, uid("sub"), started("web", "plus", "monthly", at(0), at(30))), at(0));
    const denied = /permission denied|row-level security/;

    expect(await dbFailure(withUser(h.user.id, (tx) => tx.insert(subscriptions).values({ householdId: h.household.id, plan: "pro", status: "active", provider: "manual" })))).toMatch(denied);
    expect(await dbFailure(withUser(h.user.id, (tx) => tx.update(subscriptions).set({ plan: "family" }).where(eq(subscriptions.householdId, h.household.id))))).toMatch(denied);
    expect(await dbFailure(withUser(h.user.id, (tx) => tx.delete(subscriptions).where(eq(subscriptions.householdId, h.household.id))))).toMatch(denied);
    expect(await dbFailure(withUser(h.user.id, (tx) => tx.insert(billingEvents).values({ provider: "web", eventId: uid("evt"), type: "x", householdId: h.household.id })))).toMatch(denied);
    expect(await dbFailure(withUser(h.user.id, (tx) => tx.select().from(billingEvents)))).toMatch(denied);
    expect(await dbFailure(withUser(h.user.id, (tx) => tx.insert(usageCounters).values({ householdId: h.household.id, metric: "receipt_scans", period: "2026-01", count: 0 })))).toMatch(denied);
    expect(await dbFailure(withUser(h.user.id, (tx) => tx.update(usageCounters).set({ count: 0 }).where(eq(usageCounters.householdId, h.household.id))))).toMatch(denied);

    // Nothing changed.
    expect(await rowOf(h.household.id)).toMatchObject({ plan: "plus", status: "active" });
  });

  it("a household can't give itself a plan by writing to the table, and the plan in force comes only from the stored subscription", async () => {
    const h = await fresh();
    expect(await dbFailure(withUser(h.user.id, (tx) => tx.insert(subscriptions).values({ householdId: h.household.id, plan: "family", status: "active", provider: "manual" })))).toMatch(/permission denied|row-level security/);
    expect((await resolveHouseholdPlan(h.household.id)).plan).toBe("free");
  });
});
