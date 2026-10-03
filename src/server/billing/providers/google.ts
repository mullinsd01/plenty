import "server-only";
import { z } from "zod";
import type { BillingEvent, BillingLink, NormalizedBillingEvent, PaidPlanId, SnapshotEvent } from "@/lib/billing/events";
import type { BillingPeriod } from "@/lib/billing/plans";
import { planForProductId, resolveProducts, type ProductMap } from "@/lib/billing/product-ids";
import { env, type Env } from "@/server/env";
import { householdFromAccountToken } from "../account-token";
import { BillingUnavailableError, WebhookAuthError, WebhookRetryError } from "../errors";
import type { StoreRestoreResult } from "./types";

/**
 * Google Play subscriptions: real-time developer notifications delivered by a
 * Pub/Sub push subscription, plus the purchase tokens an owner sends to
 * restore a purchase.
 *
 * A notification only says "something changed". The truth is fetched from the
 * Play Developer API (`purchases.subscriptionsv2.get`) every time, so a
 * forged, duplicated or out-of-order notification can at worst cause one
 * extra lookup, and what is applied is always what Google says *now*.
 * Authenticity of the push itself is checked first: Pub/Sub signs each request
 * with an OIDC token for the service account you configure, addressed to your
 * endpoint's URL.
 *
 * Purchases are acknowledged once Plenty has linked them to a household.
 * Google refunds a purchase that isn't acknowledged within three days, which is
 * the right outcome for one that never reached a household.
 *
 * Written against Google's documentation and tested with synthetic payloads
 * only; it needs a real Play Console and service account to be proven.
 */

const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

// ─── Configuration ──────────────────────────────────────────────────────────

export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  [field: string]: unknown;
}

export interface GoogleConfig {
  packageName: string;
  serviceAccount: GoogleServiceAccount;
  /** What Pub/Sub's token must be addressed to: the push endpoint's URL. */
  pubsubAudience: string;
  /** The service account the push subscription signs its token as. */
  pubsubServiceAccount: string;
  products: ProductMap;
  accountSecret: string | null;
}

type GoogleEnv = Pick<
  Env,
  | "APP_URL"
  | "GOOGLE_PLAY_PACKAGE_NAME"
  | "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"
  | "GOOGLE_PUBSUB_AUDIENCE"
  | "GOOGLE_PUBSUB_SERVICE_ACCOUNT"
  | "GOOGLE_PRODUCTS"
  | "BILLING_ACCOUNT_SECRET"
>;

/** A service account key given as JSON, or as base64 of that JSON (easier in environment variables). */
export function parseServiceAccount(value: string): GoogleServiceAccount | null {
  const candidates = [value, Buffer.from(value, "base64").toString("utf8")];
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text) as Partial<GoogleServiceAccount>;
      if (typeof parsed.client_email === "string" && typeof parsed.private_key === "string") return parsed as GoogleServiceAccount;
    } catch {
      // try the next form
    }
  }
  return null;
}

/** The Google settings, or null when Google Play isn't set up. */
export function readGoogleConfig(source: GoogleEnv = env()): GoogleConfig | null {
  if (!source.GOOGLE_PLAY_PACKAGE_NAME || !source.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || !source.GOOGLE_PUBSUB_SERVICE_ACCOUNT) return null;
  const serviceAccount = parseServiceAccount(source.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
  if (!serviceAccount) {
    console.error("[billing.google] GOOGLE_PLAY_SERVICE_ACCOUNT_JSON isn't a service account key.");
    return null;
  }
  return {
    packageName: source.GOOGLE_PLAY_PACKAGE_NAME,
    serviceAccount,
    pubsubAudience: source.GOOGLE_PUBSUB_AUDIENCE ?? `${source.APP_URL.replace(/\/$/, "")}/api/billing/webhooks/google`,
    pubsubServiceAccount: source.GOOGLE_PUBSUB_SERVICE_ACCOUNT,
    products: resolveProducts("google", source.GOOGLE_PRODUCTS),
    accountSecret: source.BILLING_ACCOUNT_SECRET ?? null,
  };
}

export function isConfigured(config: GoogleConfig | null = readGoogleConfig()): boolean {
  return config !== null;
}

function requireConfig(config: GoogleConfig | null): GoogleConfig {
  if (!config) throw new BillingUnavailableError("Restoring Google Play purchases isn't available on this server. Everything on your current plan keeps working.");
  return config;
}

// ─── Push authentication and parsing ────────────────────────────────────────

export interface PushTokenVerifier {
  verifyIdToken(options: { idToken: string; audience: string }): Promise<{ getPayload(): { email?: string; email_verified?: boolean } | undefined }>;
}

let defaultVerifier: PushTokenVerifier | null = null;

async function oidcVerifier(): Promise<PushTokenVerifier> {
  if (!defaultVerifier) {
    const { OAuth2Client } = await import("google-auth-library");
    defaultVerifier = new OAuth2Client() as unknown as PushTokenVerifier;
  }
  return defaultVerifier;
}

/**
 * Verify the `Authorization: Bearer <OIDC token>` Pub/Sub attaches to a push:
 * Google's signature, our endpoint as the audience, and the one service
 * account we configured as the sender. Anything else is refused.
 */
export async function verifyPush(authorization: string | null, config: GoogleConfig | null = readGoogleConfig(), verifier?: PushTokenVerifier): Promise<void> {
  const cfg = requireConfig(config);
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match) throw new WebhookAuthError("Missing bearer token.");
  let payload: { email?: string; email_verified?: boolean } | undefined;
  try {
    const ticket = await (verifier ?? (await oidcVerifier())).verifyIdToken({ idToken: match[1], audience: cfg.pubsubAudience });
    payload = ticket.getPayload();
  } catch {
    throw new WebhookAuthError("The bearer token couldn't be verified.");
  }
  if (!payload || payload.email_verified !== true || payload.email !== cfg.pubsubServiceAccount) {
    throw new WebhookAuthError("The bearer token isn't from the expected service account.");
  }
}

const subscriptionNotificationSchema = z.object({
  version: z.string().optional(),
  notificationType: z.number().int(),
  purchaseToken: z.string().min(1).max(4096),
  subscriptionId: z.string().optional(),
});

const developerNotificationSchema = z.object({
  version: z.string().optional(),
  packageName: z.string(),
  eventTimeMillis: z.union([z.string(), z.number()]).optional(),
  subscriptionNotification: subscriptionNotificationSchema.optional(),
  voidedPurchaseNotification: z
    .object({
      purchaseToken: z.string().min(1).max(4096),
      orderId: z.string().optional(),
      productType: z.number().int().optional(),
      refundType: z.number().int().optional(),
    })
    .optional(),
  oneTimeProductNotification: z.unknown().optional(),
  testNotification: z.object({ version: z.string().optional() }).optional(),
});

export type DeveloperNotification = z.infer<typeof developerNotificationSchema>;

const pushBodySchema = z.object({
  message: z.object({ data: z.string(), messageId: z.string().min(1), publishTime: z.string().optional() }),
  subscription: z.string().optional(),
});

export interface ParsedPush {
  messageId: string;
  notification: DeveloperNotification;
}

/** Read a Pub/Sub push body. Throws `WebhookAuthError` (answered 400) for anything that isn't a well-formed developer notification. */
export function parsePush(rawBody: string): ParsedPush {
  try {
    const body = pushBodySchema.parse(JSON.parse(rawBody));
    const notification = developerNotificationSchema.parse(JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8")));
    return { messageId: body.message.messageId, notification };
  } catch {
    throw new WebhookAuthError("The notification isn't a Google Play developer notification.");
  }
}

// ─── The Play Developer API ─────────────────────────────────────────────────

/** The parts of `SubscriptionPurchaseV2` Plenty reads. */
export interface GoogleSubscriptionPurchaseV2 {
  latestOrderId?: string;
  startTime?: string;
  subscriptionState?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  testPurchase?: object | null;
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    latestSuccessfulOrderId?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean } | null;
    offerDetails?: { basePlanId?: string } | null;
    deferredItemReplacement?: { productId?: string } | null;
  }>;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string } | null;
}

interface PublisherClient {
  request<T>(options: { url: string; method?: string; data?: unknown }): Promise<{ data: T }>;
}

let cachedClient: { email: string; client: PublisherClient } | null = null;

async function publisher(config: GoogleConfig): Promise<PublisherClient> {
  if (cachedClient?.email === config.serviceAccount.client_email) return cachedClient.client;
  const { GoogleAuth } = await import("google-auth-library");
  const client = new GoogleAuth({ credentials: config.serviceAccount, scopes: [ANDROID_PUBLISHER_SCOPE] }) as unknown as PublisherClient;
  cachedClient = { email: config.serviceAccount.client_email, client };
  return client;
}

function statusOf(err: unknown): number | null {
  const status = (err as { response?: { status?: number } } | null)?.response?.status ?? (err as { status?: number } | null)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * Ask Google for the subscription's current state. `null` means Google doesn't
 * know the token (or it's too old to look up). Anything else that goes wrong is
 * a `WebhookRetryError`: the notification is delivered again later.
 */
export async function fetchSubscription(
  purchaseToken: string,
  config: GoogleConfig | null = readGoogleConfig(),
): Promise<{ purchase: GoogleSubscriptionPurchaseV2; fetchedAt: Date } | null> {
  const cfg = requireConfig(config);
  // Taken before the request: what comes back is at least this recent, so ordering stays safe.
  const fetchedAt = new Date();
  try {
    const client = await publisher(cfg);
    const res = await client.request<GoogleSubscriptionPurchaseV2>({
      url: `${API_BASE}/${encodeURIComponent(cfg.packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,
      method: "GET",
    });
    return { purchase: res.data, fetchedAt };
  } catch (err) {
    const status = statusOf(err);
    if (status === 400 || status === 404 || status === 410) return null;
    console.error("[billing.google] subscription lookup failed", status ?? "no response");
    throw new WebhookRetryError("Google Play couldn't be reached just now.");
  }
}

/** Acknowledge a purchase so Google doesn't refund it. Best effort: failures are logged, and the next notification tries again. */
export async function acknowledge(purchaseToken: string, productId: string, config: GoogleConfig | null = readGoogleConfig()): Promise<boolean> {
  const cfg = requireConfig(config);
  try {
    const client = await publisher(cfg);
    await client.request({
      url: `${API_BASE}/${encodeURIComponent(cfg.packageName)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
      method: "POST",
      data: {},
    });
    return true;
  } catch (err) {
    console.error("[billing.google] acknowledge failed", statusOf(err) ?? "no response");
    return false;
  }
}

// ─── Mapping ────────────────────────────────────────────────────────────────

/** Subscription notification types, from Google's reference. */
export const GOOGLE_NOTIFICATION_NAMES: Record<number, string> = {
  1: "SUBSCRIPTION_RECOVERED",
  2: "SUBSCRIPTION_RENEWED",
  3: "SUBSCRIPTION_CANCELED",
  4: "SUBSCRIPTION_PURCHASED",
  5: "SUBSCRIPTION_ON_HOLD",
  6: "SUBSCRIPTION_IN_GRACE_PERIOD",
  7: "SUBSCRIPTION_RESTARTED",
  8: "SUBSCRIPTION_PRICE_CHANGE_CONFIRMED",
  9: "SUBSCRIPTION_DEFERRED",
  10: "SUBSCRIPTION_PAUSED",
  11: "SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED",
  12: "SUBSCRIPTION_REVOKED",
  13: "SUBSCRIPTION_EXPIRED",
  17: "SUBSCRIPTION_ITEMS_CHANGED",
  18: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
  19: "SUBSCRIPTION_PRICE_CHANGE_UPDATED",
  20: "SUBSCRIPTION_PENDING_PURCHASE_CANCELED",
  22: "SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED",
};

const NOTIFICATION_PURCHASED = 4;
const NOTIFICATION_REVOKED = 12;

const parseTime = (value: string | undefined): Date | null => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export interface MappedGooglePurchase {
  plan: PaidPlanId;
  period: BillingPeriod;
  productId: string;
  expiry: Date | null;
  /** What the subscription is doing, or null when it gives no entitlement and nothing needs recording (pending, unknown). */
  status: SnapshotEvent["status"] | null;
  autoRenew: boolean;
  graceEndsAt: Date | null | undefined;
  pending: { plan: PaidPlanId; period: BillingPeriod } | null;
  /** Gives access now, so it should be acknowledged once linked. */
  entitled: boolean;
  needsAcknowledgement: boolean;
}

/** Understand a `SubscriptionPurchaseV2`. Null when it isn't one of Plenty's products. Pure. */
export function mapGooglePurchase(purchase: GoogleSubscriptionPurchaseV2, products: ProductMap): MappedGooglePurchase | null {
  const items = purchase.lineItems ?? [];
  const candidates = items.map((item) => ({ item, ref: planForProductId(products, item.productId, item.offerDetails?.basePlanId) }));
  const known = candidates.find((c) => c.ref);
  const productId = known?.item.productId;
  if (!known?.ref || !productId) return null;
  const { item, ref } = known;
  const expiry = parseTime(item.expiryTime);
  const autoRenew = item.autoRenewingPlan?.autoRenewEnabled === true;

  let status: MappedGooglePurchase["status"] = null;
  let graceEndsAt: Date | null | undefined;
  switch (purchase.subscriptionState) {
    case "SUBSCRIPTION_STATE_ACTIVE":
      status = "active";
      break;
    case "SUBSCRIPTION_STATE_CANCELED":
      status = "canceled";
      break;
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
      // While in grace, the expiry time is when the grace period ends.
      status = "past_due";
      graceEndsAt = expiry;
      break;
    case "SUBSCRIPTION_STATE_ON_HOLD":
      status = "past_due";
      graceEndsAt = null;
      break;
    case "SUBSCRIPTION_STATE_PAUSED":
      status = "paused";
      break;
    case "SUBSCRIPTION_STATE_EXPIRED":
      status = "expired";
      break;
    default:
      status = null; // pending purchase, pending-cancelled purchase, or a state we don't know: nothing is granted
  }

  const deferred = planForProductId(products, item.deferredItemReplacement?.productId);
  const entitled = status === "active" || status === "canceled" || (status === "past_due" && graceEndsAt != null);
  return {
    plan: ref.plan,
    period: ref.period,
    productId,
    expiry,
    status,
    autoRenew: status === "canceled" || status === "expired" ? false : autoRenew,
    graceEndsAt,
    pending: deferred && (deferred.plan !== ref.plan || deferred.period !== ref.period) ? deferred : null,
    entitled,
    needsAcknowledgement: entitled && purchase.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING",
  };
}

function purchaseLink(token: string, purchase: GoogleSubscriptionPurchaseV2, mapped: MappedGooglePurchase | null, secret: string | null): BillingLink {
  return {
    providerSubscriptionId: token,
    providerProductId: mapped?.productId ?? null,
    householdId: householdFromAccountToken(purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId, secret),
    replacesProviderSubscriptionId: purchase.linkedPurchaseToken ?? null,
    currentPeriodStart: parseTime(purchase.startTime),
  };
}

export interface GoogleNormalized extends NormalizedBillingEvent {
  /** Acknowledge the purchase once the event has been applied to a household. */
  acknowledge: { purchaseToken: string; productId: string } | null;
}

/** A subscription notification, with the state fetched from Google at `fetchedAt`. Pure. */
export function normalizeGoogleSubscription(args: {
  messageId: string;
  notificationType: number;
  purchaseToken: string;
  purchase: GoogleSubscriptionPurchaseV2;
  fetchedAt: Date;
  config: Pick<GoogleConfig, "products" | "accountSecret">;
}): GoogleNormalized {
  const { purchase, purchaseToken, fetchedAt } = args;
  const mapped = mapGooglePurchase(purchase, args.config.products);
  const base = {
    provider: "google" as const,
    eventId: args.messageId,
    providerType: GOOGLE_NOTIFICATION_NAMES[args.notificationType] ?? `SUBSCRIPTION_TYPE_${args.notificationType}`,
    link: purchaseLink(purchaseToken, purchase, mapped, args.config.accountSecret),
  };
  const ignore = (note: string): GoogleNormalized => ({ ...base, event: null, note, acknowledge: null });

  if (!mapped) return ignore("product isn't mapped to a plan");

  let event: BillingEvent;
  if (args.notificationType === NOTIFICATION_REVOKED) {
    // The purchase token identifies the whole subscription, so there's no older period to tell apart from.
    event = { type: "revoked", occurredAt: fetchedAt, periodEnd: null };
  } else if (mapped.status === null) {
    return ignore(`subscription state ${String(purchase.subscriptionState ?? "unknown").replace(/^SUBSCRIPTION_STATE_/, "").slice(0, 30)} grants nothing`);
  } else if (args.notificationType === NOTIFICATION_PURCHASED && mapped.status === "active") {
    event = {
      type: "started",
      occurredAt: fetchedAt,
      provider: "google",
      plan: mapped.plan,
      period: mapped.period,
      currentPeriodEnd: mapped.expiry,
      autoRenew: mapped.autoRenew,
    };
  } else {
    event = {
      type: "snapshot",
      occurredAt: fetchedAt,
      provider: "google",
      plan: mapped.plan,
      period: mapped.period,
      status: mapped.status,
      autoRenew: mapped.autoRenew,
      // In grace the expiry is the grace end, not the end of the paid period.
      currentPeriodEnd: mapped.status === "past_due" ? undefined : mapped.expiry,
      graceEndsAt: mapped.graceEndsAt,
      pendingPlan: mapped.pending?.plan ?? null,
      pendingPeriod: mapped.pending?.period ?? null,
    };
  }
  return { ...base, event, acknowledge: mapped.needsAcknowledgement ? { purchaseToken, productId: mapped.productId } : null };
}

/** A refund or chargeback of a subscription order. Only a full refund of the latest order ends access. Pure. */
export function normalizeGoogleVoided(args: {
  messageId: string;
  voided: NonNullable<DeveloperNotification["voidedPurchaseNotification"]>;
  /** The subscription as Google reports it now, to tell whether the voided order is the latest one. */
  purchase: GoogleSubscriptionPurchaseV2 | null;
  fetchedAt: Date;
}): NormalizedBillingEvent {
  const { voided, purchase } = args;
  const base = {
    provider: "google" as const,
    eventId: args.messageId,
    providerType: "VOIDED_PURCHASE",
    link: { providerSubscriptionId: voided.purchaseToken } satisfies BillingLink,
  };
  const ignore = (note: string): NormalizedBillingEvent => ({ ...base, event: null, note });
  if (voided.productType !== 1) return ignore("voided purchase isn't a subscription");
  if (voided.refundType === 2) return ignore("partial refund: access is unchanged");
  const latest = new Set([purchase?.latestOrderId, ...(purchase?.lineItems ?? []).map((l) => l.latestSuccessfulOrderId)].filter(Boolean));
  if (voided.orderId && latest.size > 0 && !latest.has(voided.orderId)) {
    return ignore("refund of an earlier renewal, not the current period");
  }
  return { ...base, event: { type: "refunded", occurredAt: args.fetchedAt, periodEnd: null } };
}

// ─── Restore ────────────────────────────────────────────────────────────────

/** Verify a purchase token with Google and describe what it gives access to right now. */
export async function verifyPurchaseToken(purchaseToken: string, now: Date, config: GoogleConfig | null = readGoogleConfig()): Promise<StoreRestoreResult> {
  const cfg = requireConfig(config);
  const fetched = await fetchSubscription(purchaseToken, cfg);
  return describeGooglePurchase(purchaseToken, fetched?.purchase ?? null, fetched?.fetchedAt ?? now, cfg);
}

export function describeGooglePurchase(
  purchaseToken: string,
  purchase: GoogleSubscriptionPurchaseV2 | null,
  fetchedAt: Date,
  config: Pick<GoogleConfig, "products" | "accountSecret">,
): StoreRestoreResult {
  const unsupported = (reason: string): StoreRestoreResult => ({
    provider: "google",
    providerSubscriptionId: purchaseToken,
    providerProductId: "",
    plan: "plus",
    period: "monthly",
    environment: "unknown",
    householdHint: null,
    state: "unsupported",
    reason,
    event: null,
    link: { providerSubscriptionId: purchaseToken },
  });
  if (!purchase) return unsupported("Google Play doesn't recognise that purchase. Check you're signed in to the Google account that bought it.");
  const mapped = mapGooglePurchase(purchase, config.products);
  if (!mapped) return unsupported("That purchase isn't one of Plenty's subscriptions.");

  const link = purchaseLink(purchaseToken, purchase, mapped, config.accountSecret);
  const result = (state: StoreRestoreResult["state"], reason: string | null, event: StoreRestoreResult["event"]): StoreRestoreResult => ({
    provider: "google",
    providerSubscriptionId: purchaseToken,
    providerProductId: mapped.productId,
    plan: mapped.plan,
    period: mapped.period,
    environment: purchase.testPurchase ? "test" : "production",
    householdHint: link.householdId ?? null,
    state,
    reason,
    event,
    link,
  });

  if (mapped.status === null) return result("unsupported", "That purchase is still being processed by Google Play. Try again once it has completed.", null);
  if (mapped.status === "expired") return result("ended", "That subscription has ended, so there's nothing to restore. You can subscribe again whenever you like.", null);
  return {
    ...result("live", null, {
      type: "snapshot",
      occurredAt: fetchedAt,
      provider: "google",
      plan: mapped.plan,
      period: mapped.period,
      status: mapped.status,
      autoRenew: mapped.autoRenew,
      currentPeriodEnd: mapped.status === "past_due" ? undefined : mapped.expiry,
      graceEndsAt: mapped.graceEndsAt,
      pendingPlan: mapped.pending?.plan ?? null,
      pendingPeriod: mapped.pending?.period ?? null,
    }),
    needsAcknowledgement: mapped.needsAcknowledgement,
  };
}
