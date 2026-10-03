import Stripe from "stripe";
import { afterAll, describe, expect, it } from "vitest";
import { accountTokenFor, householdFromAccountToken } from "@/server/billing/account-token";
import { BillingUnavailableError, WebhookAuthError, WebhookRetryError } from "@/server/billing/errors";
import {
  describeAppleSubscription,
  makeVerifierFactory,
  normalizeAppleNotification,
  parseRootCertificates,
  peekEnvironment,
  readAppleConfig,
  verifyNotification,
  verifyRestoreProof,
  type AppleConfig,
  type DecodedAppleNotification,
} from "@/server/billing/providers/apple";
import {
  acknowledge,
  describeGooglePurchase,
  fetchSubscription,
  GOOGLE_NOTIFICATION_NAMES,
  mapGooglePurchase,
  normalizeGoogleSubscription,
  normalizeGoogleVoided,
  parsePush,
  parseServiceAccount,
  readGoogleConfig,
  verifyPush,
  type GoogleConfig,
  type GoogleSubscriptionPurchaseV2,
} from "@/server/billing/providers/google";
import * as manual from "@/server/billing/providers/manual";
import { canSell, normalizeStripeEvent, readStripeConfig, STRIPE_GRACE_DAYS, verifyWebhook, checkoutDisclosure } from "@/server/billing/providers/stripe";
import { DEFAULT_STORE_PRODUCTS } from "@/lib/billing/product-ids";
import { detectPlatform, isNativePlatform, storeFor } from "@/lib/billing/platform";
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
  SYNTHETIC_HOUSEHOLD,
  SYNTHETIC_USER,
} from "../helpers/billing-fixtures";

/**
 * Provider adapters, with SYNTHETIC payloads only (see tests/helpers/billing-fixtures.ts):
 * nothing here talks to Stripe, Apple or Google, and no credentials are involved. What this
 * proves is Plenty's own handling — signature checks, verification, mapping and refusal
 * when unconfigured — not that the real services send exactly these shapes.
 */

const DAY = 86_400_000;
const sec = (ms: number) => Math.floor(ms / 1000);
const MAR1 = Date.UTC(2026, 2, 1);
const APR1 = Date.UTC(2026, 3, 1);

// ─── Stripe ─────────────────────────────────────────────────────────────────

describe("Stripe: configuration", () => {
  const full = { STRIPE_SECRET_KEY: "sk_test_synthetic", STRIPE_WEBHOOK_SECRET: "whsec_synthetic", STRIPE_PRICES: { "plus.monthly": STRIPE_PRICES["plus.monthly"] } };

  it("is unconfigured without a key, a webhook secret or any price", () => {
    expect(readStripeConfig({ ...full, STRIPE_SECRET_KEY: undefined })).toBeNull();
    expect(readStripeConfig({ ...full, STRIPE_WEBHOOK_SECRET: undefined })).toBeNull();
    expect(readStripeConfig({ ...full, STRIPE_PRICES: {} })).toBeNull();
  });

  it("is configured with all three, and only sells the prices that are set", () => {
    const config = readStripeConfig(full);
    expect(config).not.toBeNull();
    expect(canSell("plus", "monthly", config)).toBe(true);
    expect(canSell("plus", "annual", config)).toBe(false);
    expect(canSell("family", "monthly", config)).toBe(false);
    expect(canSell("plus", "monthly", null)).toBe(false);
  });

  it("states price, period, renewal and how to cancel next to the pay button", () => {
    const text = checkoutDisclosure("plus", "annual");
    expect(text).toContain("$49.99 a year");
    expect(text).toContain("renews automatically each year until you cancel");
    expect(text).toContain("cancel any time");
    expect(text).not.toMatch(/free trial|days are free/i); // no trial is offered
  });
});

describe("Stripe: webhook signature (raw body)", () => {
  const secret = "whsec_synthetic_test_secret";
  const config = { secretKey: "sk_test_synthetic", webhookSecret: secret, prices: { "plus.monthly": STRIPE_PRICES["plus.monthly"] } };
  const body = JSON.stringify(stripeEvent("customer.subscription.created", stripeSubscription()));
  const header = (payload: string, over: { secret?: string; timestamp?: number } = {}) =>
    Stripe.webhooks.generateTestHeaderString({ payload, secret: over.secret ?? secret, timestamp: over.timestamp });

  it("accepts a correctly signed body and returns the event", async () => {
    const event = await verifyWebhook(body, header(body), config);
    expect(event.type).toBe("customer.subscription.created");
  });

  it("refuses a tampered body, even by one character or by whitespace", async () => {
    await expect(verifyWebhook(body.replace("active", "actives"), header(body), config)).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(verifyWebhook(JSON.stringify(JSON.parse(body), null, 2), header(body), config)).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("refuses the wrong secret, a missing header and garbage", async () => {
    await expect(verifyWebhook(body, header(body, { secret: "whsec_other" }), config)).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(verifyWebhook(body, null, config)).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(verifyWebhook(body, "t=1,v1=deadbeef", config)).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(verifyWebhook(body, "garbage", config)).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("refuses a stale signature (replay protection)", async () => {
    const old = sec(Date.now()) - 3600;
    await expect(verifyWebhook(body, header(body, { timestamp: old }), config)).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("refuses to verify anything when Stripe isn't configured", async () => {
    await expect(verifyWebhook(body, header(body), null)).rejects.toBeInstanceOf(BillingUnavailableError);
  });
});

describe("Stripe: mapping events", () => {
  const prices = { ...STRIPE_PRICES };
  const norm = (type: string, object: unknown, over: { id?: string; created?: number } = {}, deps: Parameters<typeof normalizeStripeEvent>[1] = { prices }) =>
    normalizeStripeEvent(stripeEvent(type, object, over), deps);
  const created = sec(MAR1 + 60_000);

  it("a new active subscription starts the plan its price maps to, tied to the household in its metadata", async () => {
    const n = await norm("customer.subscription.created", stripeSubscription(), { created });
    expect(n).toMatchObject({
      provider: "web",
      providerType: "customer.subscription.created",
      link: { providerSubscriptionId: "sub_synthetic_1", providerCustomerId: "cus_synthetic_1", householdId: SYNTHETIC_HOUSEHOLD, purchaserUserId: SYNTHETIC_USER },
      event: { type: "started", plan: "plus", period: "monthly", autoRenew: true, trialEndsAt: null },
    });
    expect(n.event).toMatchObject({ currentPeriodEnd: new Date(APR1) });
  });

  it("maps each price to its own plan and period", async () => {
    for (const [key, priceId] of Object.entries(STRIPE_PRICES)) {
      const [plan, period] = key.split(".");
      const sub = stripeSubscription({ items: { data: [{ price: { id: priceId }, current_period_end: sec(APR1) }] } });
      expect((await norm("customer.subscription.created", sub, { created })).event).toMatchObject({ plan, period });
    }
  });

  it("ignores a price that isn't one of ours, and a household id that isn't a UUID", async () => {
    const odd = stripeSubscription({ items: { data: [{ price: { id: "price_unknown" }, current_period_end: sec(APR1) }] } });
    expect((await norm("customer.subscription.created", odd)).event).toBeNull();
    const n = await norm("customer.subscription.created", stripeSubscription({ metadata: { household_id: "not-a-uuid" } }), { created });
    expect(n.link.householdId).toBeNull();
  });

  it("a trial starts as a trial", async () => {
    const trial = stripeSubscription({ status: "trialing", trial_end: sec(MAR1 + 7 * DAY) });
    expect((await norm("customer.subscription.created", trial, { created })).event).toMatchObject({ type: "started", trialEndsAt: new Date(MAR1 + 7 * DAY) });
  });

  it("grants nothing until the first payment completes", async () => {
    for (const status of ["incomplete", "incomplete_expired"]) {
      const n = await norm("customer.subscription.created", stripeSubscription({ status }));
      expect(n.event).toBeNull();
      expect(n.note).toContain("first payment");
    }
  });

  it("turning renewal off is a snapshot that won't renew, with the paid-until date", async () => {
    const n = await norm("customer.subscription.updated", stripeSubscription({ cancel_at_period_end: true }), { created });
    expect(n.event).toMatchObject({ type: "snapshot", status: "active", autoRenew: false, plan: "plus", currentPeriodEnd: new Date(APR1) });
  });

  it("a cancellation scheduled for a date before the period ends is honoured", async () => {
    const early = MAR1 + 10 * DAY;
    const n = await norm("customer.subscription.updated", stripeSubscription({ cancel_at: sec(early) }), { created });
    expect(n.event).toMatchObject({ autoRenew: false, currentPeriodEnd: new Date(early) });
  });

  it("past due is a snapshot with a grace period; unpaid (Stripe gave up) has none", async () => {
    const due = await norm("customer.subscription.updated", stripeSubscription({ status: "past_due" }), { created });
    expect(due.event).toMatchObject({ type: "snapshot", status: "past_due", graceEndsAt: new Date(created * 1000 + STRIPE_GRACE_DAYS * DAY) });
    const unpaid = await norm("customer.subscription.updated", stripeSubscription({ status: "unpaid" }), { created });
    expect(unpaid.event).toMatchObject({ status: "past_due", graceEndsAt: null });
  });

  it("paused and a plan change are snapshots", async () => {
    expect((await norm("customer.subscription.updated", stripeSubscription({ status: "paused" }), { created })).event).toMatchObject({ status: "paused" });
    const family = stripeSubscription({ items: { data: [{ price: { id: STRIPE_PRICES["family.annual"] }, current_period_end: sec(APR1) }] } });
    expect((await norm("customer.subscription.updated", family, { created })).event).toMatchObject({ type: "snapshot", plan: "family", period: "annual" });
  });

  it("an unrecognised status is recorded and ignored, never guessed at", async () => {
    expect((await norm("customer.subscription.updated", stripeSubscription({ status: "something_new" }))).event).toBeNull();
  });

  it("a deleted subscription that ran its course expires; one ended early is cancelled now", async () => {
    const ran = await norm("customer.subscription.deleted", stripeSubscription({ status: "canceled", cancel_at_period_end: true, ended_at: sec(APR1) }), { created: sec(APR1) });
    expect(ran.event).toMatchObject({ type: "expired", periodEnd: new Date(APR1) });
    const early = await norm("customer.subscription.deleted", stripeSubscription({ status: "canceled", ended_at: sec(MAR1 + 3 * DAY) }), { created: sec(MAR1 + 3 * DAY) });
    expect(early.event).toMatchObject({ type: "cancelled_now" });
    const failed = await norm("customer.subscription.deleted", stripeSubscription({ status: "canceled", ended_at: sec(MAR1 + 3 * DAY), cancellation_details: { reason: "payment_failed" } }));
    expect(failed.event).toMatchObject({ type: "expired" });
  });

  it("a failed renewal payment starts the grace period; other invoices don't", async () => {
    const invoice = (reason: string) => ({
      id: "in_1",
      billing_reason: reason,
      customer: "cus_synthetic_1",
      parent: { subscription_details: { subscription: "sub_synthetic_1", metadata: { household_id: SYNTHETIC_HOUSEHOLD } } },
      lines: { data: [{ period: { start: sec(APR1), end: sec(APR1 + 30 * DAY) } }] },
    });
    const failed = await norm("invoice.payment_failed", invoice("subscription_cycle"), { created: sec(APR1 + 60_000) });
    expect(failed.event).toMatchObject({ type: "payment_failed", periodEnd: new Date(APR1), graceEndsAt: new Date(APR1 + 60_000 + STRIPE_GRACE_DAYS * DAY) });
    expect(failed.link).toMatchObject({ providerSubscriptionId: "sub_synthetic_1", householdId: SYNTHETIC_HOUSEHOLD });
    for (const reason of ["subscription_create", "subscription_update", "manual"]) {
      expect((await norm("invoice.payment_failed", invoice(reason))).event).toBeNull();
    }
  });

  it("a paid renewal invoice renews through the end of the period it covers", async () => {
    const invoice = {
      id: "in_2",
      billing_reason: "subscription_cycle",
      customer: "cus_synthetic_1",
      subscription: "sub_synthetic_1",
      lines: { data: [{ period: { start: sec(APR1), end: sec(APR1 + 30 * DAY) }, pricing: { price_details: { price: STRIPE_PRICES["family.monthly"] } } }] },
    };
    const n = await norm("invoice.paid", invoice);
    expect(n.event).toMatchObject({ type: "renewed", currentPeriodEnd: new Date(APR1 + 30 * DAY), plan: "family", period: "monthly" });
    expect((await norm("invoice.paid", { ...invoice, billing_reason: "subscription_create" })).event).toBeNull();
  });

  it("only a full refund ends access, and only of a subscription payment", async () => {
    const charge = { id: "ch_1", customer: "cus_synthetic_1", refunded: true, payment_intent: "pi_1" };
    const resolveCharge = async () => ({ subscriptionId: "sub_synthetic_1", periodEnd: new Date(APR1) });
    const full = await norm("charge.refunded", charge, {}, { prices, resolveCharge });
    expect(full.event).toMatchObject({ type: "refunded", periodEnd: new Date(APR1) });
    expect(full.link.providerSubscriptionId).toBe("sub_synthetic_1");
    expect((await norm("charge.refunded", { ...charge, refunded: false }, {}, { prices, resolveCharge })).event).toBeNull();
    expect((await norm("charge.refunded", charge, {}, { prices, resolveCharge: async () => null })).event).toBeNull();
  });

  it("a completed checkout only links the household; the subscription's own event does the work", async () => {
    const n = await norm("checkout.session.completed", { id: "cs_1", mode: "subscription", client_reference_id: SYNTHETIC_HOUSEHOLD, customer: "cus_1", subscription: "sub_1" });
    expect(n.event).toBeNull();
    expect(n.link).toMatchObject({ householdId: SYNTHETIC_HOUSEHOLD, providerSubscriptionId: "sub_1" });
  });

  it("a booked downgrade (subscription schedule) is a change for the next renewal", async () => {
    const schedule = {
      id: "sub_sched_1",
      status: "active",
      subscription: "sub_synthetic_1",
      customer: "cus_synthetic_1",
      phases: [
        { start_date: sec(MAR1), end_date: sec(APR1), items: [{ price: STRIPE_PRICES["family.monthly"] }] },
        { start_date: sec(APR1), end_date: null, items: [{ price: STRIPE_PRICES["plus.monthly"] }] },
      ],
    };
    const n = await norm("subscription_schedule.updated", schedule, { created: sec(MAR1 + 5 * DAY) });
    expect(n.event).toMatchObject({ type: "plan_changed", plan: "plus", period: "monthly", timing: "next_renewal" });
  });

  it("events it doesn't act on are recorded with a reason, and applied to nothing", async () => {
    const n = await norm("customer.created", { id: "cus_1" });
    expect(n.event).toBeNull();
    expect(n.note).toBeTruthy();
  });
});

// ─── Apple ──────────────────────────────────────────────────────────────────

const appleConfig = (chainRoot: Buffer, over: Partial<AppleConfig> = {}): AppleConfig => ({
  bundleId: APPLE_BUNDLE,
  appAppleId: APPLE_APP_ID,
  rootCertificates: [chainRoot],
  products: DEFAULT_STORE_PRODUCTS,
  accountSecret: "s".repeat(40),
  ...over,
});

describe("Apple: configuration", () => {
  it("is unconfigured without a bundle id or root certificates, or with unreadable ones", () => {
    const base = { APPLE_BUNDLE_ID: "app.plenty", APPLE_APP_ID: 1, APPLE_ROOT_CERTS: "not base64 der at all!", APPLE_PRODUCTS: {}, BILLING_ACCOUNT_SECRET: undefined };
    expect(readAppleConfig({ ...base, APPLE_BUNDLE_ID: undefined })).toBeNull();
    expect(readAppleConfig({ ...base, APPLE_ROOT_CERTS: undefined })).toBeNull();
    expect(readAppleConfig(base)).toBeNull();
  });

  it("peeks the environment a payload claims (only to choose what to verify against), and refuses Xcode", () => {
    const jws = (body: object) => `x.${Buffer.from(JSON.stringify(body)).toString("base64url")}.y`;
    expect(peekEnvironment(jws({ data: { environment: "Sandbox" } }))).toBe("Sandbox");
    expect(peekEnvironment(jws({ environment: "Production" }))).toBe("Production");
    expect(peekEnvironment(jws({ environment: "Xcode" }))).toBeNull();
    expect(peekEnvironment(jws({ environment: "LocalTesting" }))).toBeNull();
    expect(peekEnvironment("garbage")).toBeNull();
  });
});

describe.skipIf(!opensslAvailable)("Apple: verifying signed payloads (synthetic certificate chain, not Apple's)", () => {
  const chain = makeSyntheticAppleChain();
  afterAll(() => chain.cleanup());
  const factory = makeVerifierFactory(false); // no OCSP lookups: never touches the network
  const config = () => appleConfig(chain.rootDer);

  it("accepts a payload whose chain leads to the configured root, and decodes what is inside", async () => {
    const jws = appleNotification(chain, { type: "DID_RENEW" });
    const decoded = await verifyNotification(jws, config(), factory);
    expect(decoded.payload.notificationType).toBe("DID_RENEW");
    expect(decoded.transaction?.productId).toBe("app.plenty.plus.monthly");
    expect(decoded.renewal?.autoRenewStatus).toBe(1);
    expect(decoded.environment).toBe("Sandbox");
  });

  it("accepts production notifications for this app, and sandbox ones on the same server", async () => {
    const prod = appleNotification(chain, { type: "DID_RENEW", environment: "Production", transaction: appleTransaction({ environment: "Production" }), renewal: appleRenewal({ environment: "Production" }) });
    expect((await verifyNotification(prod, config(), factory)).environment).toBe("Production");
  });

  it("refuses a payload signed by a key that isn't the leaf's", async () => {
    const forged = chain.forge({ notificationType: "SUBSCRIBED", subtype: "INITIAL_BUY", notificationUUID: "x", version: "2.0", signedDate: Date.now(), data: { environment: "Sandbox", bundleId: APPLE_BUNDLE } });
    await expect(verifyNotification(forged, config(), factory)).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("refuses a chain that doesn't lead to a root we trust", async () => {
    const jws = appleNotification(chain, { type: "DID_RENEW" });
    await expect(verifyNotification(jws, appleConfig(chain.strangerRootDer), factory)).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("refuses a chain of the wrong length", async () => {
    const short = chain.sign({ notificationType: "TEST", data: { environment: "Sandbox", bundleId: APPLE_BUNDLE } }, { chain: "short" });
    await expect(verifyNotification(short, config(), factory)).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("refuses another app's bundle id", async () => {
    const jws = appleNotification(chain, { type: "DID_RENEW", bundleId: "com.someone.else" });
    await expect(verifyNotification(jws, config(), factory)).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("refuses a signed transaction inside a notification that is for another app", async () => {
    const jws = appleNotification(chain, { type: "DID_RENEW", transaction: appleTransaction({ bundleId: "com.someone.else" }) });
    await expect(verifyNotification(jws, config(), factory)).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("refuses production data when the app's Apple id isn't known, instead of trusting it", async () => {
    const prod = appleNotification(chain, { type: "DID_RENEW", environment: "Production", transaction: appleTransaction({ environment: "Production" }), renewal: appleRenewal({ environment: "Production" }) });
    await expect(verifyNotification(prod, appleConfig(chain.rootDer, { appAppleId: null }), factory)).rejects.toBeInstanceOf(BillingUnavailableError);
  });

  it("refuses production data for another app's Apple id", async () => {
    const prod = appleNotification(chain, { type: "DID_RENEW", environment: "Production", transaction: appleTransaction({ environment: "Production" }), renewal: appleRenewal({ environment: "Production" }) });
    await expect(verifyNotification(prod, appleConfig(chain.rootDer, { appAppleId: 42 }), factory)).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("refuses Xcode and local-testing payloads, which Apple does not sign", async () => {
    const xcode = chain.sign({ notificationType: "SUBSCRIBED", data: { environment: "Xcode", bundleId: APPLE_BUNDLE } });
    await expect(verifyNotification(xcode, config(), factory)).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("refuses to do anything when Apple isn't configured", async () => {
    await expect(verifyNotification(appleNotification(chain, { type: "TEST" }), null, factory)).rejects.toBeInstanceOf(BillingUnavailableError);
    await expect(verifyRestoreProof({ signedTransaction: "x".repeat(40) }, new Date(), null, factory)).rejects.toBeInstanceOf(BillingUnavailableError);
  });

  it("end to end: a verified notification normalises to a billing event", async () => {
    const jws = appleNotification(chain, { type: "SUBSCRIBED", subtype: "INITIAL_BUY", uuid: "aaaaaaaa-1111-4222-8333-444444444444" });
    const decoded = await verifyNotification(jws, config(), factory);
    expect(normalizeAppleNotification(decoded, config())).toMatchObject({
      provider: "apple",
      eventId: "aaaaaaaa-1111-4222-8333-444444444444",
      providerType: "SUBSCRIBED/INITIAL_BUY",
      link: { providerSubscriptionId: "2000000000000001", providerProductId: "app.plenty.plus.monthly" },
      event: { type: "started", plan: "plus", period: "monthly" },
    });
  });

  it("restore: verifies the device's transaction with Apple's rules, and finds the household from the account token", async () => {
    const token = accountTokenFor(SYNTHETIC_HOUSEHOLD, "s".repeat(40));
    const proof = {
      signedTransaction: chain.sign(appleTransaction({ expiresDate: Date.now() + 20 * DAY, appAccountToken: token })),
      signedRenewalInfo: chain.sign(appleRenewal()),
    };
    const result = await verifyRestoreProof(proof, new Date(), config(), factory);
    expect(result).toMatchObject({ provider: "apple", state: "live", plan: "plus", period: "monthly", providerSubscriptionId: "2000000000000001", householdHint: SYNTHETIC_HOUSEHOLD });
    expect(result.event).toMatchObject({ type: "snapshot", status: "active", autoRenew: true });
    const forged = { signedTransaction: chain.forge(appleTransaction()) };
    await expect(verifyRestoreProof(forged, new Date(), config(), factory)).rejects.toBeInstanceOf(WebhookAuthError);
  });
});

describe("Apple: mapping notifications", () => {
  const products = DEFAULT_STORE_PRODUCTS;
  const decode = (
    type: string,
    subtype: string | undefined,
    tx: Record<string, unknown> | null = appleTransaction(),
    renewal: Record<string, unknown> | null = appleRenewal(),
  ): DecodedAppleNotification => ({
    payload: { notificationType: type, subtype, notificationUUID: `uuid-${type}-${subtype ?? "none"}`, signedDate: MAR1 + 1000, data: { environment: "Sandbox" } },
    transaction: tx,
    renewal,
    environment: "Sandbox",
  });
  const norm = (...args: Parameters<typeof decode>) => normalizeAppleNotification(decode(...args), { products, accountSecret: null });

  it("SUBSCRIBED starts the plan; a free-trial offer starts a trial", () => {
    expect(norm("SUBSCRIBED", "INITIAL_BUY").event).toMatchObject({ type: "started", plan: "plus", period: "monthly", currentPeriodEnd: new Date(APR1), trialEndsAt: null, autoRenew: true });
    expect(norm("SUBSCRIBED", "RESUBSCRIBE").event).toMatchObject({ type: "started" });
    const trial = norm("SUBSCRIBED", "INITIAL_BUY", appleTransaction({ offerType: 1, offerDiscountType: "FREE_TRIAL" }));
    expect(trial.event).toMatchObject({ type: "started", trialEndsAt: new Date(APR1) });
  });

  it("maps the annual family product", () => {
    expect(norm("SUBSCRIBED", "INITIAL_BUY", appleTransaction({ productId: "app.plenty.family.annual" })).event).toMatchObject({ plan: "family", period: "annual" });
  });

  it("DID_RENEW renews through the new expiry", () => {
    expect(norm("DID_RENEW", undefined, appleTransaction({ expiresDate: APR1 + 30 * DAY })).event).toMatchObject({ type: "renewed", currentPeriodEnd: new Date(APR1 + 30 * DAY), plan: "plus", period: "monthly" });
  });

  it("DID_CHANGE_RENEWAL_STATUS turns renewal off and on", () => {
    expect(norm("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED", appleTransaction(), appleRenewal({ autoRenewStatus: 0 })).event).toMatchObject({ type: "auto_renew_off" });
    expect(norm("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_ENABLED").event).toMatchObject({ type: "auto_renew_on" });
  });

  it("DID_CHANGE_RENEWAL_PREF: a downgrade waits for the renewal, an upgrade is immediate, a revert cancels the change", () => {
    const familyTx = appleTransaction({ productId: "app.plenty.family.monthly" });
    expect(norm("DID_CHANGE_RENEWAL_PREF", "DOWNGRADE", familyTx, appleRenewal({ productId: "app.plenty.family.monthly", autoRenewProductId: "app.plenty.plus.monthly" })).event).toMatchObject({
      type: "plan_changed",
      plan: "plus",
      period: "monthly",
      timing: "next_renewal",
    });
    expect(norm("DID_CHANGE_RENEWAL_PREF", "UPGRADE", appleTransaction(), appleRenewal({ autoRenewProductId: "app.plenty.family.monthly" })).event).toMatchObject({ plan: "family", timing: "immediate", currentPeriodEnd: new Date(APR1) });
    expect(norm("DID_CHANGE_RENEWAL_PREF", undefined, familyTx, appleRenewal({ productId: "app.plenty.family.monthly", autoRenewProductId: "app.plenty.family.monthly" })).event).toMatchObject({ plan: "family", timing: "next_renewal" });
  });

  it("DID_FAIL_TO_RENEW: grace period keeps access until it ends; billing retry alone doesn't", () => {
    const grace = norm("DID_FAIL_TO_RENEW", "GRACE_PERIOD", appleTransaction(), appleRenewal({ isInBillingRetryPeriod: true, gracePeriodExpiresDate: APR1 + 6 * DAY }));
    expect(grace.event).toMatchObject({ type: "payment_failed", graceEndsAt: new Date(APR1 + 6 * DAY), periodEnd: new Date(APR1) });
    expect(norm("DID_FAIL_TO_RENEW", undefined, appleTransaction(), appleRenewal({ isInBillingRetryPeriod: true })).event).toMatchObject({ type: "payment_failed", graceEndsAt: null });
    // A grace-period notice without the date can't promise anything, so the default applies.
    expect((norm("DID_FAIL_TO_RENEW", "GRACE_PERIOD").event as { graceEndsAt?: Date | null }).graceEndsAt).toBeUndefined();
  });

  it("GRACE_PERIOD_EXPIRED ends the grace; EXPIRED ends the plan", () => {
    expect(norm("GRACE_PERIOD_EXPIRED", undefined).event).toMatchObject({ type: "payment_failed", graceEndsAt: null });
    expect(norm("EXPIRED", "VOLUNTARY").event).toMatchObject({ type: "expired", periodEnd: new Date(APR1) });
    expect(norm("EXPIRED", "BILLING_RETRY").event).toMatchObject({ type: "expired" });
  });

  it("REFUND and REVOKE take the plan away; a reversed refund gives it back", () => {
    expect(norm("REFUND", undefined).event).toMatchObject({ type: "refunded", periodEnd: new Date(APR1) });
    expect(norm("REVOKE", undefined).event).toMatchObject({ type: "revoked" });
    expect(norm("REFUND_REVERSED", undefined).event).toMatchObject({ type: "refund_reversed" });
  });

  it("RENEWAL_EXTENDED moves the paid-until date", () => {
    expect(norm("RENEWAL_EXTENDED", undefined, appleTransaction({ expiresDate: APR1 + 10 * DAY })).event).toMatchObject({ type: "period_extended", currentPeriodEnd: new Date(APR1 + 10 * DAY) });
  });

  it("PRICE_INCREASE, tests and unknown types change nothing but are recorded", () => {
    for (const [type, subtype] of [["PRICE_INCREASE", "PENDING"], ["PRICE_INCREASE", "ACCEPTED"], ["TEST", undefined], ["CONSUMPTION_REQUEST", undefined], ["SOMETHING_NEW", undefined]] as const) {
      const n = norm(type, subtype);
      expect(n.event, type).toBeNull();
      expect(n.note, type).toBeTruthy();
    }
  });

  it("ignores family-shared purchases and products that aren't ours", () => {
    expect(norm("DID_RENEW", undefined, appleTransaction({ inAppOwnershipType: "FAMILY_SHARED" })).event).toBeNull();
    expect(norm("SUBSCRIBED", "INITIAL_BUY", appleTransaction({ productId: "com.other.product" })).event).toBeNull();
    expect(norm("SUBSCRIBED", "INITIAL_BUY", appleTransaction({ productId: "app.plenty.pro.monthly" })).event).toBeNull();
  });

  it("links by the original transaction id, and reads the household only from a token we made", () => {
    const secret = "k".repeat(40);
    const token = accountTokenFor(SYNTHETIC_HOUSEHOLD, secret);
    const mine = normalizeAppleNotification(decode("SUBSCRIBED", "INITIAL_BUY", appleTransaction({ appAccountToken: token })), { products, accountSecret: secret });
    expect(mine.link).toMatchObject({ providerSubscriptionId: "2000000000000001", householdId: SYNTHETIC_HOUSEHOLD });
    const foreign = normalizeAppleNotification(decode("SUBSCRIBED", "INITIAL_BUY", appleTransaction({ appAccountToken: "11111111-2222-4333-8444-555555555555" })), { products, accountSecret: secret });
    expect(foreign.link.householdId).toBeNull();
    const noSecret = normalizeAppleNotification(decode("SUBSCRIBED", "INITIAL_BUY", appleTransaction({ appAccountToken: token })), { products, accountSecret: null });
    expect(noSecret.link.householdId).toBeNull();
  });
});

describe("Apple: describing a restore", () => {
  const now = new Date(MAR1 + 10 * DAY);
  const cfg = { products: DEFAULT_STORE_PRODUCTS, accountSecret: null };
  const describeIt = (tx: Record<string, unknown>, renewal: Record<string, unknown> | null = appleRenewal()) => describeAppleSubscription(tx, renewal, "Sandbox", now, cfg);

  it("a subscription in force is live, with its renewal setting", () => {
    expect(describeIt(appleTransaction())).toMatchObject({ state: "live", plan: "plus", event: { status: "active", autoRenew: true, currentPeriodEnd: new Date(APR1) } });
    expect(describeIt(appleTransaction(), appleRenewal({ autoRenewStatus: 0 })).event).toMatchObject({ autoRenew: false });
  });

  it("carries a downgrade booked for the next renewal", () => {
    const result = describeIt(appleTransaction({ productId: "app.plenty.family.monthly" }), appleRenewal({ productId: "app.plenty.family.monthly", autoRenewProductId: "app.plenty.plus.monthly" }));
    expect(result.event).toMatchObject({ plan: "family", pendingPlan: "plus", pendingPeriod: "monthly" });
  });

  it("an ended subscription has nothing to restore", () => {
    const result = describeIt(appleTransaction({ expiresDate: MAR1 + 2 * DAY }), appleRenewal({ autoRenewStatus: 0 }));
    expect(result.state).toBe("ended");
    expect(result.event).toBeNull();
    expect(result.reason).toMatch(/nothing to restore/i);
  });

  it("one still being retried is live, so linking it lets it recover", () => {
    const retry = describeIt(appleTransaction({ expiresDate: MAR1 + 2 * DAY }), appleRenewal({ isInBillingRetryPeriod: true, gracePeriodExpiresDate: MAR1 + 12 * DAY }));
    expect(retry).toMatchObject({ state: "live", event: { status: "past_due", graceEndsAt: new Date(MAR1 + 12 * DAY) } });
    const noGrace = describeIt(appleTransaction({ expiresDate: MAR1 + 2 * DAY }), appleRenewal({ isInBillingRetryPeriod: true }));
    expect(noGrace.event).toMatchObject({ status: "past_due", graceEndsAt: null });
  });

  it("a refunded purchase is refused, and so is family sharing", () => {
    expect(describeIt(appleTransaction({ revocationDate: MAR1 + DAY })).state).toBe("refunded");
    const shared = describeIt(appleTransaction({ inAppOwnershipType: "FAMILY_SHARED" }));
    expect(shared.state).toBe("unsupported");
    expect(shared.reason).toMatch(/family sharing/i);
  });

  it("refuses something that isn't one of our subscriptions, and renewal info for a different one", () => {
    expect(() => describeIt(appleTransaction({ productId: "com.other.x" }))).toThrow(WebhookAuthError);
    expect(() => describeIt(appleTransaction(), appleRenewal({ originalTransactionId: "999" }))).toThrow(WebhookAuthError);
  });

  it("stamps the restore with how old Apple's data is, so later notifications still apply on top", () => {
    const result = describeIt(appleTransaction({ signedDate: MAR1 + 3 * DAY }), appleRenewal({ signedDate: MAR1 + 2 * DAY }));
    expect(result.event?.occurredAt).toEqual(new Date(MAR1 + 2 * DAY));
  });
});

describe("Apple: root certificates setting", () => {
  it("rejects entries that aren't certificates, and reads base64 DER", () => {
    expect(() => parseRootCertificates("not a certificate")).toThrow();
    if (opensslAvailable) {
      const chain = makeSyntheticAppleChain();
      try {
        expect(parseRootCertificates(chain.rootDer.toString("base64"))[0].equals(chain.rootDer)).toBe(true);
        expect(parseRootCertificates("./root.pem", () => chain.rootDer)[0].equals(chain.rootDer)).toBe(true);
      } finally {
        chain.cleanup();
      }
    }
  });
});

// ─── Google ─────────────────────────────────────────────────────────────────

const googleConfig = (over: Partial<GoogleConfig> = {}): GoogleConfig => ({
  packageName: "app.plenty.test",
  serviceAccount: { client_email: "play@plenty.iam.gserviceaccount.com", private_key: "synthetic" },
  pubsubAudience: "https://plenty.example/api/billing/webhooks/google",
  pubsubServiceAccount: "pubsub-push@plenty.iam.gserviceaccount.com",
  products: DEFAULT_STORE_PRODUCTS,
  accountSecret: "g".repeat(40),
  ...over,
});

const purchase = (over: Partial<GoogleSubscriptionPurchaseV2> = {}, item: Record<string, unknown> = {}): GoogleSubscriptionPurchaseV2 => ({
  latestOrderId: "GPA.1111-2222-3333-44444",
  startTime: new Date(MAR1).toISOString(),
  subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
  acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
  lineItems: [{ productId: "app.plenty.plus.monthly", expiryTime: new Date(APR1).toISOString(), autoRenewingPlan: { autoRenewEnabled: true }, ...item }],
  ...over,
});

describe("Google: configuration and push authentication", () => {
  it("is unconfigured without a package, a readable service account or a push sender", () => {
    const key = JSON.stringify({ client_email: "a@b.c", private_key: "k" });
    const base = { APP_URL: "https://plenty.example", GOOGLE_PLAY_PACKAGE_NAME: "app.plenty", GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: key, GOOGLE_PUBSUB_SERVICE_ACCOUNT: "push@x.iam.gserviceaccount.com", GOOGLE_PUBSUB_AUDIENCE: undefined, GOOGLE_PRODUCTS: {}, BILLING_ACCOUNT_SECRET: undefined };
    expect(readGoogleConfig({ ...base, GOOGLE_PLAY_PACKAGE_NAME: undefined })).toBeNull();
    expect(readGoogleConfig({ ...base, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: undefined })).toBeNull();
    expect(readGoogleConfig({ ...base, GOOGLE_PUBSUB_SERVICE_ACCOUNT: undefined })).toBeNull();
    expect(readGoogleConfig({ ...base, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: "not json" })).toBeNull();
    const ok = readGoogleConfig(base);
    expect(ok?.pubsubAudience).toBe("https://plenty.example/api/billing/webhooks/google");
    expect(ok?.products).toEqual(DEFAULT_STORE_PRODUCTS);
  });

  it("reads a service account as JSON or base64 JSON, and nothing else", () => {
    const key = { client_email: "a@b.c", private_key: "k" };
    expect(parseServiceAccount(JSON.stringify(key))?.client_email).toBe("a@b.c");
    expect(parseServiceAccount(Buffer.from(JSON.stringify(key)).toString("base64"))?.client_email).toBe("a@b.c");
    expect(parseServiceAccount(JSON.stringify({ client_email: "a@b.c" }))).toBeNull();
    expect(parseServiceAccount("nope")).toBeNull();
  });

  const verifierFor = (payload: { email?: string; email_verified?: boolean } | undefined, seen?: { audience?: string }) => ({
    async verifyIdToken(options: { idToken: string; audience: string }) {
      if (seen) seen.audience = options.audience;
      if (options.idToken === "bad") throw new Error("invalid signature");
      return { getPayload: () => payload };
    },
  });
  const sender = "pubsub-push@plenty.iam.gserviceaccount.com";

  it("accepts a token from the configured service account, addressed to our endpoint", async () => {
    const seen: { audience?: string } = {};
    await expect(verifyPush("Bearer good", googleConfig(), verifierFor({ email: sender, email_verified: true }, seen))).resolves.toBeUndefined();
    expect(seen.audience).toBe("https://plenty.example/api/billing/webhooks/google");
  });

  it("refuses a missing or malformed header, a bad signature, another sender and an unverified email", async () => {
    const good = verifierFor({ email: sender, email_verified: true });
    for (const header of [null, "", "Basic abc", "Bearer", "good"]) await expect(verifyPush(header, googleConfig(), good)).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(verifyPush("Bearer bad", googleConfig(), good)).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(verifyPush("Bearer good", googleConfig(), verifierFor({ email: "attacker@evil.iam.gserviceaccount.com", email_verified: true }))).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(verifyPush("Bearer good", googleConfig(), verifierFor({ email: sender, email_verified: false }))).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(verifyPush("Bearer good", googleConfig(), verifierFor(undefined))).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("refuses everything when Google isn't configured", async () => {
    await expect(verifyPush("Bearer good", null)).rejects.toBeInstanceOf(BillingUnavailableError);
    await expect(fetchSubscription("token", null)).rejects.toBeInstanceOf(BillingUnavailableError);
    await expect(acknowledge("token", "app.plenty.plus.monthly", null)).rejects.toBeInstanceOf(BillingUnavailableError);
  });
});

describe("Google: reading a push", () => {
  const push = (notification: object, messageId = "m-1") => JSON.stringify({ message: { data: Buffer.from(JSON.stringify(notification)).toString("base64"), messageId }, subscription: "projects/p/subscriptions/s" });

  it("reads a subscription notification, a voided purchase and a test", () => {
    const sub = parsePush(push({ version: "1.0", packageName: "app.plenty.test", eventTimeMillis: "1", subscriptionNotification: { version: "1.0", notificationType: 2, purchaseToken: "tok" } }));
    expect(sub).toMatchObject({ messageId: "m-1", notification: { packageName: "app.plenty.test", subscriptionNotification: { notificationType: 2, purchaseToken: "tok" } } });
    expect(parsePush(push({ packageName: "p", voidedPurchaseNotification: { purchaseToken: "t", orderId: "o", productType: 1, refundType: 1 } })).notification.voidedPurchaseNotification?.orderId).toBe("o");
    expect(parsePush(push({ packageName: "p", testNotification: { version: "1.0" } })).notification.testNotification).toBeTruthy();
  });

  it("refuses anything that isn't a developer notification", () => {
    for (const body of ["", "nope", "{}", JSON.stringify({ message: { data: "!!!", messageId: "x" } }), push({ nothing: true }), JSON.stringify({ message: { data: Buffer.from("{}").toString("base64") } })]) {
      expect(() => parsePush(body)).toThrow(WebhookAuthError);
    }
  });
});

describe("Google: mapping subscription state", () => {
  const products = DEFAULT_STORE_PRODUCTS;

  it("maps each state to what Plenty does", () => {
    const states = [
      ["SUBSCRIPTION_STATE_ACTIVE", { status: "active", entitled: true }],
      ["SUBSCRIPTION_STATE_CANCELED", { status: "canceled", entitled: true, autoRenew: false }],
      ["SUBSCRIPTION_STATE_IN_GRACE_PERIOD", { status: "past_due", entitled: true, graceEndsAt: new Date(APR1) }],
      ["SUBSCRIPTION_STATE_ON_HOLD", { status: "past_due", entitled: false, graceEndsAt: null }],
      ["SUBSCRIPTION_STATE_PAUSED", { status: "paused", entitled: false }],
      ["SUBSCRIPTION_STATE_EXPIRED", { status: "expired", entitled: false, autoRenew: false }],
      ["SUBSCRIPTION_STATE_PENDING", { status: null, entitled: false }],
      ["SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED", { status: null, entitled: false }],
      ["SOMETHING_NEW", { status: null, entitled: false }],
    ] as const;
    for (const [state, expected] of states) expect(mapGooglePurchase(purchase({ subscriptionState: state }), products), state).toMatchObject(expected);
  });

  it("maps the product and base plan to a plan", () => {
    expect(mapGooglePurchase(purchase({}, { productId: "app.plenty.family.annual" }), products)).toMatchObject({ plan: "family", period: "annual" });
    const withBasePlans = { "plus.monthly": "app.plenty.plus:monthly", "plus.annual": "app.plenty.plus:annual" };
    expect(mapGooglePurchase(purchase({}, { productId: "app.plenty.plus", offerDetails: { basePlanId: "annual" } }), withBasePlans)).toMatchObject({ plan: "plus", period: "annual" });
    expect(mapGooglePurchase(purchase({}, { productId: "app.plenty.plus", offerDetails: { basePlanId: "weekly" } }), withBasePlans)).toBeNull();
    expect(mapGooglePurchase(purchase({}, { productId: "com.other" }), products)).toBeNull();
    expect(mapGooglePurchase({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", lineItems: [] }, products)).toBeNull();
  });

  it("reads a booked plan change and the acknowledgement state", () => {
    const m = mapGooglePurchase(purchase({}, { productId: "app.plenty.family.monthly", deferredItemReplacement: { productId: "app.plenty.plus.monthly" } }), products);
    expect(m?.pending).toEqual({ plan: "plus", period: "monthly" });
    expect(m?.needsAcknowledgement).toBe(true);
    expect(mapGooglePurchase(purchase({ acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }), products)?.needsAcknowledgement).toBe(false);
    expect(mapGooglePurchase(purchase({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD" }), products)?.needsAcknowledgement).toBe(false);
  });
});

describe("Google: mapping notifications", () => {
  const fetchedAt = new Date(MAR1 + 5 * DAY);
  const cfg = { products: DEFAULT_STORE_PRODUCTS, accountSecret: "g".repeat(40) };
  const norm = (notificationType: number, p: GoogleSubscriptionPurchaseV2 = purchase()) =>
    normalizeGoogleSubscription({ messageId: `m-${notificationType}`, notificationType, purchaseToken: "purchase-token-1", purchase: p, fetchedAt, config: cfg });

  it("names the notification types from Google's reference", () => {
    expect(GOOGLE_NOTIFICATION_NAMES[4]).toBe("SUBSCRIPTION_PURCHASED");
    expect(GOOGLE_NOTIFICATION_NAMES[13]).toBe("SUBSCRIPTION_EXPIRED");
    expect(norm(2).providerType).toBe("SUBSCRIPTION_RENEWED");
    expect(norm(99).providerType).toBe("SUBSCRIPTION_TYPE_99");
  });

  it("a purchase starts the plan and is acknowledged; the state is Google's, as fetched", () => {
    const n = norm(4);
    expect(n).toMatchObject({ provider: "google", eventId: "m-4", link: { providerSubscriptionId: "purchase-token-1" }, acknowledge: { purchaseToken: "purchase-token-1", productId: "app.plenty.plus.monthly" } });
    expect(n.event).toMatchObject({ type: "started", plan: "plus", period: "monthly", occurredAt: fetchedAt, currentPeriodEnd: new Date(APR1), autoRenew: true });
  });

  it("renewed, recovered, restarted and cancelled notifications all apply what Google says now", () => {
    expect(norm(2, purchase({ acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" })).event).toMatchObject({ type: "snapshot", status: "active", currentPeriodEnd: new Date(APR1) });
    expect(norm(1).event).toMatchObject({ type: "snapshot", status: "active" });
    expect(norm(7).event).toMatchObject({ type: "snapshot", status: "active", autoRenew: true });
    expect(norm(3, purchase({ subscriptionState: "SUBSCRIPTION_STATE_CANCELED" }, { autoRenewingPlan: null })).event).toMatchObject({ type: "snapshot", status: "canceled", autoRenew: false, currentPeriodEnd: new Date(APR1) });
  });

  it("grace keeps access until the grace ends, without moving the paid-until date; on hold has no access", () => {
    expect(norm(6, purchase({ subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" })).event).toMatchObject({ type: "snapshot", status: "past_due", graceEndsAt: new Date(APR1), currentPeriodEnd: undefined });
    expect(norm(5, purchase({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD" })).event).toMatchObject({ status: "past_due", graceEndsAt: null });
  });

  it("paused and expired", () => {
    expect(norm(10, purchase({ subscriptionState: "SUBSCRIPTION_STATE_PAUSED" })).event).toMatchObject({ status: "paused" });
    expect(norm(13, purchase({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" })).event).toMatchObject({ status: "expired", autoRenew: false });
  });

  it("a revoked purchase takes access away, whatever else the subscription says", () => {
    expect(norm(12, purchase({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" })).event).toMatchObject({ type: "revoked" });
    expect(norm(12).acknowledge).toBeNull();
  });

  it("a plan change arrives as a new purchase that points at the one it replaces", () => {
    const n = norm(4, purchase({ linkedPurchaseToken: "old-token" }, { productId: "app.plenty.family.monthly" }));
    expect(n.link.replacesProviderSubscriptionId).toBe("old-token");
    expect(n.event).toMatchObject({ plan: "family" });
  });

  it("a pending purchase grants nothing and isn't acknowledged", () => {
    const n = norm(4, purchase({ subscriptionState: "SUBSCRIPTION_STATE_PENDING" }));
    expect(n.event).toBeNull();
    expect(n.acknowledge).toBeNull();
  });

  it("products that aren't ours are ignored", () => {
    expect(norm(4, purchase({}, { productId: "com.other" })).event).toBeNull();
  });

  it("finds the household only from a token we made", () => {
    const token = accountTokenFor(SYNTHETIC_HOUSEHOLD, "g".repeat(40));
    expect(norm(4, purchase({ externalAccountIdentifiers: { obfuscatedExternalAccountId: token } })).link.householdId).toBe(SYNTHETIC_HOUSEHOLD);
    expect(norm(4, purchase({ externalAccountIdentifiers: { obfuscatedExternalAccountId: "someone-elses" } })).link.householdId).toBeNull();
  });

  it("a voided subscription purchase is a refund of the current period only, and only when full", () => {
    const voided = (over: object = {}) => ({ purchaseToken: "purchase-token-1", orderId: "GPA.1111-2222-3333-44444", productType: 1, refundType: 1, ...over });
    const run = (v: ReturnType<typeof voided>, p: GoogleSubscriptionPurchaseV2 | null = purchase()) => normalizeGoogleVoided({ messageId: "v-1", voided: v, purchase: p, fetchedAt });
    expect(run(voided()).event).toMatchObject({ type: "refunded" });
    expect(run(voided({ refundType: 2 })).event).toBeNull();
    expect(run(voided({ productType: 2 })).event).toBeNull();
    expect(run(voided({ orderId: "GPA.0000-OLD" })).event).toBeNull(); // an earlier renewal
    expect(run(voided(), null).event).toMatchObject({ type: "refunded" });
  });
});

describe("Google: describing a restore", () => {
  const cfg = { products: DEFAULT_STORE_PRODUCTS, accountSecret: "g".repeat(40) };
  const at = new Date(MAR1 + 5 * DAY);
  const describeIt = (p: GoogleSubscriptionPurchaseV2 | null) => describeGooglePurchase("purchase-token-1", p, at, cfg);

  it("a live subscription is restorable, and says it still needs acknowledging", () => {
    const r = describeIt(purchase());
    expect(r).toMatchObject({ state: "live", plan: "plus", period: "monthly", providerSubscriptionId: "purchase-token-1", needsAcknowledgement: true, event: { status: "active" } });
  });

  it("recognises the household it was bought for", () => {
    const token = accountTokenFor(SYNTHETIC_HOUSEHOLD, "g".repeat(40));
    expect(describeIt(purchase({ externalAccountIdentifiers: { obfuscatedExternalAccountId: token } })).householdHint).toBe(SYNTHETIC_HOUSEHOLD);
  });

  it("explains why something can't be restored", () => {
    expect(describeIt(null)).toMatchObject({ state: "unsupported", event: null });
    expect(describeIt(purchase({}, { productId: "com.other" })).state).toBe("unsupported");
    expect(describeIt(purchase({ subscriptionState: "SUBSCRIPTION_STATE_PENDING" })).state).toBe("unsupported");
    const ended = describeIt(purchase({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" }));
    expect(ended.state).toBe("ended");
    expect(ended.reason).toMatch(/nothing to restore/i);
  });

  it("a subscription on hold is live, so linking it lets it recover", () => {
    expect(describeIt(purchase({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD" }))).toMatchObject({ state: "live", event: { status: "past_due", graceEndsAt: null } });
  });
});

// ─── Account token, manual, platform ────────────────────────────────────────

describe("account token", () => {
  const secret = "a".repeat(40);

  it("round-trips a household id and looks like a UUID", () => {
    const token = accountTokenFor(SYNTHETIC_HOUSEHOLD, secret);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(token).not.toBe(SYNTHETIC_HOUSEHOLD);
    expect(householdFromAccountToken(token, secret)).toBe(SYNTHETIC_HOUSEHOLD);
    expect(householdFromAccountToken(token.toUpperCase(), secret)).toBe(SYNTHETIC_HOUSEHOLD);
  });

  it("can't be made without the secret, or read with another", () => {
    const token = accountTokenFor(SYNTHETIC_HOUSEHOLD, secret);
    expect(householdFromAccountToken(token, "b".repeat(40))).toBeNull();
    expect(householdFromAccountToken(token, null)).toBeNull();
    for (const bad of [null, undefined, "", "not-a-uuid", "11111111-2222-3333-4444-555555555555", SYNTHETIC_HOUSEHOLD]) {
      expect(householdFromAccountToken(bad, secret)).toBeNull();
    }
  });

  it("gives different households different tokens", () => {
    expect(accountTokenFor(SYNTHETIC_HOUSEHOLD, secret)).not.toBe(accountTokenFor(SYNTHETIC_USER, secret));
    expect(() => accountTokenFor("nope", secret)).toThrow();
  });
});

describe("manual provider and platform", () => {
  it("manual grants need no configuration", () => {
    expect(manual.isConfigured()).toBe(true);
  });

  it("detects the native shells from a header or the user agent, and treats everything else as the web", () => {
    const h = (headers: Record<string, string>) => ({ get: (name: string) => headers[name.toLowerCase()] ?? null });
    expect(detectPlatform(h({ "x-plenty-platform": "ios" }))).toBe("ios");
    expect(detectPlatform(h({ "x-plenty-platform": "ANDROID" }))).toBe("android");
    expect(detectPlatform(h({ "user-agent": "Mozilla/5.0 PlentyApp/1.2.0 (ios)" }))).toBe("ios");
    expect(detectPlatform(h({ "user-agent": "PlentyApp/1.2.0 (android)" }))).toBe("android");
    const notNative: Array<Record<string, string>> = [{}, { "x-plenty-platform": "web" }, { "x-plenty-platform": "windows" }, { "user-agent": "Mozilla/5.0 (iPhone)" }];
    for (const headers of notNative) expect(detectPlatform(h(headers))).toBe("web");
    expect(isNativePlatform("ios") && isNativePlatform("android") && !isNativePlatform("web")).toBe(true);
    expect([storeFor("ios"), storeFor("android"), storeFor("web")]).toEqual(["apple", "google", null]);
  });

  it("has distinct error types for refusal, retry and unavailable, so routes answer 400, 503 and 503 correctly", () => {
    expect(new WebhookAuthError()).not.toBeInstanceOf(WebhookRetryError);
    expect(new BillingUnavailableError().message).toMatch(/keeps working/);
  });
});
