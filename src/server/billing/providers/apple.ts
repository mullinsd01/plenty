import "server-only";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { JWSRenewalInfoDecodedPayload, JWSTransactionDecodedPayload, ResponseBodyV2DecodedPayload } from "@apple/app-store-server-library";
import type { BillingEvent, BillingLink, NormalizedBillingEvent } from "@/lib/billing/events";
import { planForProductId, resolveProducts, type ProductMap } from "@/lib/billing/product-ids";
import { env, type Env } from "@/server/env";
import { householdFromAccountToken } from "../account-token";
import { BillingUnavailableError, WebhookAuthError, WebhookRetryError } from "../errors";
import type { StoreRestoreResult } from "./types";

/**
 * App Store subscriptions: App Store Server Notifications V2 and the
 * transactions a signed-in owner sends to restore a purchase.
 *
 * Everything from Apple is a signed JWS. Nothing is read from a payload until
 * its certificate chain has been checked back to an Apple root certificate you
 * supply (APPLE_ROOT_CERTS) by Apple's own library, which also checks the
 * bundle id and the App Store environment. Only the Sandbox and Production
 * environments are ever accepted: the library skips signature checks for
 * Xcode and local testing data, which would let anyone forge a purchase.
 *
 * Sandbox notifications are accepted by a production server on purpose: App
 * Review tests subscriptions in the sandbox against the production build.
 *
 * What we can't know from here (and say so): this has been written against
 * Apple's documentation and the library's types and tested with synthetic
 * payloads only. It needs real App Store Connect configuration to be proven.
 */

export type AppleEnvironment = "Sandbox" | "Production";

// ─── Configuration ──────────────────────────────────────────────────────────

export interface AppleConfig {
  bundleId: string;
  /** The app's numeric id. Needed to verify production data; without it only the sandbox is accepted. */
  appAppleId: number | null;
  /** DER-encoded Apple root certificates. */
  rootCertificates: Buffer[];
  products: ProductMap;
  /** For reading the household out of a purchase's account token. */
  accountSecret: string | null;
}

type AppleEnv = Pick<Env, "APPLE_BUNDLE_ID" | "APPLE_APP_ID" | "APPLE_ROOT_CERTS" | "APPLE_PRODUCTS" | "BILLING_ACCOUNT_SECRET">;

function toDer(raw: Buffer): Buffer {
  const cert = new X509Certificate(raw);
  return cert.raw;
}

/** Comma-separated entries, each a path to a certificate file (PEM or DER) or the certificate itself as base64 DER. */
export function parseRootCertificates(value: string, readFile: (path: string) => Buffer = (p) => readFileSync(p)): Buffer[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => toDer(/^[./~]/.test(entry) ? readFile(entry) : Buffer.from(entry, "base64")));
}

let parsedCerts: { source: string; certs: Buffer[] | null } | null = null;

/** The Apple settings, or null when Apple isn't set up (a bundle id and at least one readable root certificate are needed). */
export function readAppleConfig(source: AppleEnv = env()): AppleConfig | null {
  if (!source.APPLE_BUNDLE_ID || !source.APPLE_ROOT_CERTS) return null;
  if (parsedCerts?.source !== source.APPLE_ROOT_CERTS) {
    let certs: Buffer[] | null = null;
    try {
      certs = parseRootCertificates(source.APPLE_ROOT_CERTS);
      if (certs.length === 0) certs = null;
    } catch (err) {
      console.error("[billing.apple] APPLE_ROOT_CERTS could not be read:", err instanceof Error ? err.message : err);
    }
    parsedCerts = { source: source.APPLE_ROOT_CERTS, certs };
  }
  if (!parsedCerts.certs) return null;
  return {
    bundleId: source.APPLE_BUNDLE_ID,
    appAppleId: source.APPLE_APP_ID ?? null,
    rootCertificates: parsedCerts.certs,
    products: resolveProducts("apple", source.APPLE_PRODUCTS),
    accountSecret: source.BILLING_ACCOUNT_SECRET ?? null,
  };
}

export function isConfigured(config: AppleConfig | null = readAppleConfig()): boolean {
  return config !== null;
}

function requireConfig(config: AppleConfig | null): AppleConfig {
  if (!config) throw new BillingUnavailableError("Restoring App Store purchases isn't available on this server. Everything on your current plan keeps working.");
  return config;
}

// ─── Verification ───────────────────────────────────────────────────────────

interface Verifier {
  verifyAndDecodeNotification(signedPayload: string): Promise<ResponseBodyV2DecodedPayload>;
  verifyAndDecodeTransaction(signedTransaction: string): Promise<JWSTransactionDecodedPayload>;
  verifyAndDecodeRenewalInfo(signedRenewalInfo: string): Promise<JWSRenewalInfoDecodedPayload>;
}

/** Builds the checker for one App Store environment. Replaceable so tests can run without network access. */
export type VerifierFactory = (environment: AppleEnvironment, config: AppleConfig) => Promise<Verifier>;

/** Apple's library checks revocation (OCSP) over the network when online checks are on, which is what production should do. */
export function makeVerifierFactory(onlineChecks: boolean): VerifierFactory {
  const cache = new Map<string, Verifier>();
  return async (environment, config) => {
    // Keyed by which roots are trusted too: a verifier built for one set of certificates must never answer for another.
    const roots = createHash("sha256").update(Buffer.concat(config.rootCertificates)).digest("hex");
    const key = `${environment}|${config.bundleId}|${config.appAppleId}|${roots}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const { SignedDataVerifier, Environment } = await import("@apple/app-store-server-library");
    const verifier = new SignedDataVerifier(
      config.rootCertificates,
      onlineChecks,
      environment === "Production" ? Environment.PRODUCTION : Environment.SANDBOX,
      config.bundleId,
      config.appAppleId ?? undefined,
    );
    cache.set(key, verifier);
    return verifier;
  };
}

const defaultFactory: VerifierFactory = makeVerifierFactory(true);

/** The environment a signed payload claims, read *before* verification only to pick which environment to verify against. */
export function peekEnvironment(jws: string): AppleEnvironment | null {
  const part = jws.split(".")[1];
  if (!part) return null;
  try {
    const body = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      environment?: string;
      data?: { environment?: string };
      summary?: { environment?: string };
    };
    const claimed = body.environment ?? body.data?.environment ?? body.summary?.environment;
    return claimed === "Sandbox" || claimed === "Production" ? claimed : null;
  } catch {
    return null;
  }
}

async function verifierFor(jws: string, config: AppleConfig, factory: VerifierFactory): Promise<{ verifier: Verifier; environment: AppleEnvironment }> {
  const environment = peekEnvironment(jws);
  // Xcode and local-testing payloads aren't signed by Apple, so they are never accepted.
  if (!environment) throw new WebhookAuthError("Unsupported or missing App Store environment.");
  if (environment === "Production" && config.appAppleId === null) {
    throw new BillingUnavailableError("App Store production purchases can't be verified until APPLE_APP_ID is set.");
  }
  return { verifier: await factory(environment, config), environment };
}

/** Turn a verification failure into the right webhook outcome: forged data is refused, a network hiccup is retried. */
async function classify(err: unknown): Promise<never> {
  const { VerificationException, VerificationStatus } = await import("@apple/app-store-server-library");
  if (err instanceof VerificationException && err.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
    throw new WebhookRetryError("Apple's certificate status couldn't be checked just now.");
  }
  if (err instanceof WebhookAuthError || err instanceof BillingUnavailableError || err instanceof WebhookRetryError) throw err;
  throw new WebhookAuthError("The App Store payload couldn't be verified.");
}

export interface DecodedAppleNotification {
  payload: ResponseBodyV2DecodedPayload;
  transaction: JWSTransactionDecodedPayload | null;
  renewal: JWSRenewalInfoDecodedPayload | null;
  environment: AppleEnvironment;
}

/** Verify a `signedPayload` and the signed transaction and renewal information inside it. */
export async function verifyNotification(
  signedPayload: string,
  config: AppleConfig | null = readAppleConfig(),
  factory: VerifierFactory = defaultFactory,
): Promise<DecodedAppleNotification> {
  const cfg = requireConfig(config);
  const { verifier, environment } = await verifierFor(signedPayload, cfg, factory);
  try {
    const payload = await verifier.verifyAndDecodeNotification(signedPayload);
    const transaction = payload.data?.signedTransactionInfo ? await verifier.verifyAndDecodeTransaction(payload.data.signedTransactionInfo) : null;
    const renewal = payload.data?.signedRenewalInfo ? await verifier.verifyAndDecodeRenewalInfo(payload.data.signedRenewalInfo) : null;
    return { payload, transaction, renewal, environment };
  } catch (err) {
    return classify(err);
  }
}

// ─── Normalisation ──────────────────────────────────────────────────────────

const toDate = (ms: number | null | undefined): Date | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms) : null);

/** Translate a verified notification. Pure. */
export function normalizeAppleNotification(decoded: DecodedAppleNotification, config: Pick<AppleConfig, "products" | "accountSecret">): NormalizedBillingEvent {
  const { payload, transaction: tx, renewal } = decoded;
  const type = String(payload.notificationType ?? "UNKNOWN");
  const subtype = payload.subtype ? String(payload.subtype) : null;
  const at = toDate(payload.signedDate) ?? new Date();
  const productId = tx?.productId ?? renewal?.productId ?? null;
  const originalTransactionId = tx?.originalTransactionId ?? renewal?.originalTransactionId ?? null;
  const base = {
    provider: "apple" as const,
    eventId: payload.notificationUUID ?? `apple:${type}:${tx?.transactionId ?? originalTransactionId ?? "none"}:${payload.signedDate ?? 0}`,
    providerType: subtype ? `${type}/${subtype}` : type,
  };
  const link: BillingLink = {
    providerSubscriptionId: originalTransactionId,
    providerProductId: productId,
    householdId: householdFromAccountToken(tx?.appAccountToken ?? renewal?.appAccountToken, config.accountSecret),
    currentPeriodStart: toDate(tx?.purchaseDate),
  };
  const ignore = (note: string): NormalizedBillingEvent => ({ ...base, link, event: null, note: `${decoded.environment}: ${note}` });
  const done = (event: BillingEvent): NormalizedBillingEvent => ({ ...base, link, event, note: decoded.environment });

  if (tx?.inAppOwnershipType === "FAMILY_SHARED") return ignore("a family-shared purchase isn't tied to a household");

  const ref = planForProductId(config.products, productId);
  const periodEnd = toDate(tx?.expiresDate);
  const autoRenew = renewal ? renewal.autoRenewStatus !== 0 : true;

  switch (type) {
    case "SUBSCRIBED":
    case "OFFER_REDEEMED": {
      if (type === "OFFER_REDEEMED" && subtype !== "INITIAL_BUY" && subtype !== "RESUBSCRIBE") return ignore(`offer redeemed (${subtype ?? "no subtype"}); plan changes arrive as their own notifications`);
      if (!ref) return ignore("product isn't mapped to a plan");
      const freeTrial = tx?.offerType === 1 && tx.offerDiscountType === "FREE_TRIAL";
      return done({
        type: "started",
        occurredAt: at,
        provider: "apple",
        plan: ref.plan,
        period: ref.period,
        currentPeriodEnd: periodEnd,
        trialEndsAt: freeTrial ? periodEnd : null,
        autoRenew,
      });
    }

    case "DID_RENEW": {
      if (!ref) return ignore("product isn't mapped to a plan");
      if (!periodEnd) return ignore("renewal without an expiry date");
      return done({ type: "renewed", occurredAt: at, currentPeriodEnd: periodEnd, plan: ref.plan, period: ref.period });
    }

    case "DID_CHANGE_RENEWAL_STATUS": {
      const on = subtype === "AUTO_RENEW_ENABLED" ? true : subtype === "AUTO_RENEW_DISABLED" ? false : renewal ? renewal.autoRenewStatus !== 0 : null;
      if (on === null) return ignore("renewal status change without detail");
      return done({ type: on ? "auto_renew_on" : "auto_renew_off", occurredAt: at });
    }

    case "DID_CHANGE_RENEWAL_PREF": {
      // UPGRADE takes effect now; DOWNGRADE at the next renewal; no subtype means the person went back to their current plan.
      const target = planForProductId(config.products, subtype === "DOWNGRADE" || subtype === "UPGRADE" ? (renewal?.autoRenewProductId ?? productId) : productId);
      if (!target) return ignore("product isn't mapped to a plan");
      return done({
        type: "plan_changed",
        occurredAt: at,
        plan: target.plan,
        period: target.period,
        timing: subtype === "UPGRADE" ? "immediate" : "next_renewal",
        currentPeriodEnd: subtype === "UPGRADE" ? periodEnd : null,
      });
    }

    case "DID_FAIL_TO_RENEW": {
      // With the GRACE_PERIOD subtype access continues until the grace period ends; without it, Apple is retrying and access stops.
      const graceEnd = subtype === "GRACE_PERIOD" ? toDate(renewal?.gracePeriodExpiresDate) : null;
      return done({
        type: "payment_failed",
        occurredAt: at,
        graceEndsAt: subtype === "GRACE_PERIOD" && !graceEnd ? undefined : graceEnd,
        periodEnd,
      });
    }

    case "GRACE_PERIOD_EXPIRED":
      return done({ type: "payment_failed", occurredAt: at, graceEndsAt: null, periodEnd });

    case "EXPIRED":
      return done({ type: "expired", occurredAt: at, periodEnd });

    case "REFUND":
      return done({ type: "refunded", occurredAt: at, periodEnd });

    case "REVOKE":
      return done({ type: "revoked", occurredAt: at, periodEnd });

    case "REFUND_REVERSED":
      return done({ type: "refund_reversed", occurredAt: at });

    case "RENEWAL_EXTENDED":
      if (!periodEnd) return ignore("renewal extension without an expiry date");
      return done({ type: "period_extended", occurredAt: at, currentPeriodEnd: periodEnd });

    case "PRICE_INCREASE":
      return ignore(`price increase (${subtype ?? "no subtype"}); access is unchanged and Apple tells the person directly`);

    case "TEST":
      return ignore("test notification");

    default:
      return ignore(`${type} isn't something Plenty acts on`);
  }
}

// ─── Restore ────────────────────────────────────────────────────────────────

export interface AppleRestoreProof {
  /** The transaction's JWS (`Transaction.jsonRepresentation`/`jwsRepresentation` in StoreKit 2). */
  signedTransaction: string;
  /** The renewal information's JWS. Without it the renewal setting can't be known, and is assumed to be on. */
  signedRenewalInfo?: string | null;
}

/**
 * Verify what a device presents as proof of a subscription and describe it.
 * Verification is Apple's: a payload that doesn't chain to the root
 * certificates, or that is for another app or environment, is refused.
 */
export async function verifyRestoreProof(
  proof: AppleRestoreProof,
  now: Date,
  config: AppleConfig | null = readAppleConfig(),
  factory: VerifierFactory = defaultFactory,
): Promise<StoreRestoreResult> {
  const cfg = requireConfig(config);
  const { verifier, environment } = await verifierFor(proof.signedTransaction, cfg, factory);
  let tx: JWSTransactionDecodedPayload;
  let renewal: JWSRenewalInfoDecodedPayload | null = null;
  try {
    tx = await verifier.verifyAndDecodeTransaction(proof.signedTransaction);
    if (proof.signedRenewalInfo) renewal = await verifier.verifyAndDecodeRenewalInfo(proof.signedRenewalInfo);
  } catch (err) {
    return classify(err);
  }
  return describeAppleSubscription(tx, renewal, environment, now, cfg);
}

/** Pure part of a restore: what a verified transaction (and renewal info) mean for access right now. */
export function describeAppleSubscription(
  tx: JWSTransactionDecodedPayload,
  renewal: JWSRenewalInfoDecodedPayload | null,
  environment: AppleEnvironment,
  now: Date,
  config: Pick<AppleConfig, "products" | "accountSecret">,
): StoreRestoreResult {
  const ref = planForProductId(config.products, tx.productId);
  if (!ref || !tx.originalTransactionId || !tx.productId) {
    throw new WebhookAuthError("That purchase isn't one of Plenty's subscriptions.");
  }
  if (renewal && renewal.originalTransactionId !== tx.originalTransactionId) {
    throw new WebhookAuthError("The renewal information is for a different subscription.");
  }
  const periodEnd = toDate(tx.expiresDate);
  const link: BillingLink = {
    providerSubscriptionId: tx.originalTransactionId,
    providerProductId: tx.productId,
    householdId: null,
    currentPeriodStart: toDate(tx.purchaseDate),
  };
  const result = (state: StoreRestoreResult["state"], reason: string | null, event: StoreRestoreResult["event"]): StoreRestoreResult => ({
    provider: "apple",
    providerSubscriptionId: tx.originalTransactionId!,
    providerProductId: tx.productId!,
    plan: ref.plan,
    period: ref.period,
    environment,
    householdHint: householdFromAccountToken(tx.appAccountToken ?? renewal?.appAccountToken, config.accountSecret),
    state,
    reason,
    event,
    link,
  });

  if (tx.inAppOwnershipType === "FAMILY_SHARED") {
    return result("unsupported", "That subscription is shared through Apple Family Sharing, which Plenty doesn't use. It belongs to whoever bought it.", null);
  }
  if (tx.revocationDate) {
    return result("refunded", "Apple refunded that purchase, so there's nothing to restore.", null);
  }

  const autoRenew = renewal ? renewal.autoRenewStatus !== 0 : true;
  const signed = [toDate(tx.signedDate), toDate(renewal?.signedDate)].filter((d): d is Date => d !== null);
  // The data is as old as the oldest signature on it: events Apple sent after that still have to be applied on top.
  const occurredAt = signed.length > 0 ? new Date(Math.min(...signed.map((d) => d.getTime()))) : now;
  const graceEnd = toDate(renewal?.gracePeriodExpiresDate);

  if (periodEnd && periodEnd.getTime() <= now.getTime()) {
    // Past its end: still alive only while Apple is retrying the payment (with or without access during a grace period).
    if (renewal?.isInBillingRetryPeriod) {
      return result("live", null, {
        type: "snapshot",
        occurredAt,
        provider: "apple",
        plan: ref.plan,
        period: ref.period,
        status: "past_due",
        autoRenew,
        currentPeriodEnd: periodEnd,
        graceEndsAt: graceEnd && graceEnd.getTime() > now.getTime() ? graceEnd : null,
      });
    }
    return result("ended", "That subscription has ended, so there's nothing to restore. You can subscribe again whenever you like.", null);
  }

  const pending = renewal && autoRenew ? planForProductId(config.products, renewal.autoRenewProductId) : null;
  const freeTrial = tx.offerType === 1 && tx.offerDiscountType === "FREE_TRIAL";
  return result("live", null, {
    type: "snapshot",
    occurredAt,
    provider: "apple",
    plan: ref.plan,
    period: ref.period,
    status: freeTrial ? "trialing" : "active",
    autoRenew,
    currentPeriodEnd: periodEnd,
    trialEndsAt: freeTrial ? periodEnd : null,
    pendingPlan: pending && (pending.plan !== ref.plan || pending.period !== ref.period) ? pending.plan : null,
    pendingPeriod: pending && (pending.plan !== ref.plan || pending.period !== ref.period) ? pending.period : null,
  });
}
