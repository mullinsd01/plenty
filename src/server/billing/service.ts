import "server-only";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  annualSavings,
  formatPlanPrice,
  isBillingPeriod,
  isPlanId,
  PLANS,
  PURCHASABLE_PLANS,
  TRIAL_DAYS,
  type BillingPeriod,
  type PlanId,
} from "@/lib/billing/plans";
import {
  APPLE_MANAGE_URL,
  BILLING_PATH,
  formatBillingDate,
  googleManageUrl,
  managementKind,
  PROVIDER_LABELS,
  whereToManage,
  type ManagementKind,
} from "@/lib/billing/management";
import { overLimitReport, type OverLimitReport } from "@/lib/billing/over-limit";
import { isNativePlatform, storeFor, type ClientPlatform } from "@/lib/billing/platform";
import { productIdFor } from "@/lib/billing/product-ids";
import { describeEffectivePlan, resolveEffectivePlan, type BillingProviderId, type EffectiveReason, type SubscriptionState } from "@/lib/billing/subscription";
import { isTerminalStatus } from "@/lib/billing/events";
import { can } from "@/lib/members/permissions";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import type { HouseholdContext } from "@/server/auth/context";
import { systemDb } from "@/server/db/client";
import { households, subscriptions } from "@/server/db/schema";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { requireCapability } from "@/server/permissions";
import { householdAccountToken } from "./account-token";
import { applyNormalizedEvent } from "./apply-event";
import { countActiveItems, countMembers, loadSubscription, resolveHouseholdPlan, toSubscriptionState } from "./entitlements";
import { BillingUnavailableError, WebhookAuthError, WebhookRetryError } from "./errors";
import { receiptScanAllowance, type ReceiptScanAllowance } from "./limits";
import * as apple from "./providers/apple";
import * as google from "./providers/google";
import { availableProviders, webOffers } from "./providers";
import * as stripe from "./providers/stripe";
import type { StoreRestoreResult } from "./providers/types";

export { overLimitReport };
export type { OverLimitReport };

/**
 * What the plan page and the paywall need, and the three things an owner can
 * do: start a web subscription, open the billing portal, and restore a store
 * purchase.
 *
 * Rules that hold throughout:
 *   - Only an owner changes the plan (`manage_billing`).
 *   - The subscription belongs to the household. A store subscription is only
 *     ever linked to the household whose owner proves it with the store, and a
 *     subscription that already belongs to another household is never moved.
 *   - Pro can't be bought. Nothing here offers it.
 *   - Nothing basic is blocked to push a purchase: failing to pay or being over
 *     a limit only ever stops *adding more*.
 */

// ─── Overview ───────────────────────────────────────────────────────────────

export interface PurchaseOption {
  plan: PlanId;
  planName: string;
  period: BillingPeriod;
  /** "$4.99 a month", as listed. The checkout or store shows the price for the person's region. */
  priceText: string;
  /** Can be bought on the web on this server. */
  web: boolean;
}

export interface BillingOverview {
  /** The plan whose limits apply right now. */
  plan: PlanId;
  planName: string;
  /** The plan on the subscription even when it isn't in force (refunded, lapsed). */
  subscribedPlan: PlanId | null;
  reason: EffectiveReason;
  /** One honest sentence about the plan. */
  summary: string;
  /** This server grants a plan to everyone (PLAN_OVERRIDE) rather than the household having bought it. */
  overridden: boolean;
  provider: BillingProviderId | null;
  period: BillingPeriod | null;
  willRenew: boolean;
  /** When the plan renews or ends. */
  until: Date | null;
  /** What the household pays, as listed, when it has a paid subscription. */
  priceText: string | null;
  needsPaymentAttention: boolean;
  pendingChange: { plan: PlanId; planName: string; period: BillingPeriod | null; takesEffectOn: Date | null; description: string } | null;
  usage: {
    members: { used: number; limit: number | null };
    items: { used: number; limit: number | null };
    receiptScans: ReceiptScanAllowance;
  };
  /** What exceeds the plan after a downgrade. Nothing is removed; adding more waits. */
  overLimit: OverLimitReport;
  /** Where the subscription is managed. Null when there isn't one. */
  management: {
    kind: ManagementKind;
    /** This person is an owner and can act. Others see the same text, without the button. */
    canManage: boolean;
    /** The web billing portal can be opened. */
    portal: boolean;
    /** A link to the store's own subscription settings, for store subscriptions. */
    url: string | null;
    label: string;
    text: string;
  } | null;
  purchase: {
    /** Which client is asking. Inside the iOS and Android shells there is never a web checkout or portal link. */
    platform: ClientPlatform;
    /** An owner can start a web subscription now (web client only). */
    canStartCheckout: boolean;
    /** Why not, in plain words, when someone could otherwise expect to. */
    blockedReason: string | null;
    options: PurchaseOption[];
    providers: { web: boolean; apple: boolean; google: boolean };
    /**
     * Buying through the platform's store, for the native shells. The shell starts the store's own purchase
     * sheet with `products[].productId` and tags the purchase with `accountToken` (GET /api/billing/account-token);
     * the server then learns about it from the store's notifications, and "Restore purchases" links one on demand.
     */
    store: {
      provider: "apple" | "google" | null;
      /** This server can verify purchases from that store and link them to a household. */
      available: boolean;
      products: Array<{ plan: PlanId; period: BillingPeriod; productId: string; priceText: string }>;
    };
    trialDays: number;
  };
}

function managementText(provider: BillingProviderId): { label: string; text: string } {
  switch (provider) {
    case "web":
      return { label: "Manage billing", text: "Change your plan, update your payment method, see invoices or cancel in the billing portal." };
    case "apple":
      return { label: "Manage in Apple ID settings", text: "This subscription is billed by the App Store. Change or cancel it in your Apple ID subscription settings." };
    case "google":
      return { label: "Manage in Google Play", text: "This subscription is billed by Google Play. Change or cancel it in Google Play under Payments & subscriptions." };
    case "manual":
      return { label: "Plan details", text: "This plan was arranged directly with Plenty, so there's nothing to manage here." };
  }
}

/** Whether the stored subscription still counts as the household's: alive, or in trouble in a way the owner should fix rather than buy again. */
export function holdsLiveSubscription(state: SubscriptionState | null, effectivePlan: PlanId): boolean {
  if (!state || isTerminalStatus(state.status)) return false;
  return effectivePlan !== "free" || state.status === "past_due" || state.status === "paused";
}

export async function getBillingOverview(ctx: HouseholdContext, opts: { now?: Date; platform?: ClientPlatform } = {}): Promise<BillingOverview> {
  const now = opts.now ?? new Date();
  const platform = opts.platform ?? "web";
  const native = isNativePlatform(platform);
  // Prices and plan management aren't shown to restricted accounts (children).
  requireCapability(ctx, "view_receipts_and_prices");
  const householdId = ctx.household.id;
  const [row, fresh, members, items] = await Promise.all([
    loadSubscription(householdId),
    resolveHouseholdPlan(householdId, now),
    countMembers(householdId),
    countActiveItems(householdId),
  ]);
  const state = row ? toSubscriptionState(row) : null;
  const { effective } = fresh;
  const freshCtx: HouseholdContext = { ...ctx, plan: fresh };
  const receiptScans = await receiptScanAllowance(freshCtx, now);

  const shownPlan = effective.subscribedPlan ?? fresh.plan;
  const summary = fresh.overridden
    ? `This server is set up to give every household ${PLANS[fresh.plan].name}.`
    : describeEffectivePlan(effective, PLANS[shownPlan].name, formatBillingDate);

  const pending = effective.pendingChange;
  const pendingChange = pending
    ? {
        plan: pending.plan,
        planName: PLANS[pending.plan].name,
        period: pending.period,
        takesEffectOn: row?.currentPeriodEnd ?? null,
        description: `Changes to ${PLANS[pending.plan].name}${pending.period ? ` (${pending.period})` : ""}${row?.currentPeriodEnd ? ` on ${formatBillingDate(row.currentPeriodEnd)}` : " at the next renewal"}. You keep ${PLANS[shownPlan].name} until then.`,
      }
    : null;

  const provider = row ? row.provider : null;
  const isOwner = can(ctx.role, "manage_billing");
  const providers = availableProviders();
  let management: BillingOverview["management"] = null;
  if (row && state && !isTerminalStatus(state.status)) {
    const kind = managementKind(row.provider);
    const { label, text } = managementText(row.provider);
    const webOnNative = native && row.provider === "web";
    management = {
      kind,
      canManage: isOwner,
      // The app stores don't allow steering people out of the app to web billing: say where it's managed, without a link.
      portal: !webOnNative && row.provider === "web" && providers.web && !!row.providerCustomerId,
      url:
        row.provider === "apple"
          ? APPLE_MANAGE_URL
          : row.provider === "google"
            ? googleManageUrl(row.providerProductId, google.readGoogleConfig()?.packageName)
            : null,
      label: webOnNative ? "Managed on the web" : label,
      text: webOnNative ? "This subscription was started on the web, so it's managed there. Sign in from a web browser and open Settings, then Plan." : text,
    };
  }

  const offers = native ? [] : webOffers();
  const options: PurchaseOption[] = PURCHASABLE_PLANS.flatMap((plan) =>
    plan === "free" || plan === "pro"
      ? []
      : (["monthly", "annual"] as const).map((period) => ({
          plan,
          planName: PLANS[plan].name,
          period,
          priceText: formatPlanPrice(plan, period),
          web: offers.some((o) => o.plan === plan && o.period === period),
        })),
  );

  // When the web path isn't offered at all there's nothing to explain.
  let blockedReason: string | null = null;
  if (!isOwner) {
    blockedReason = "Only a household owner can change the plan.";
  } else if ((native || providers.web) && row && holdsLiveSubscription(state, effective.plan)) {
    blockedReason =
      row.provider === "web"
        ? "You already have a subscription. Use Manage billing to change plan or fix a payment."
        : `Your household already has a subscription through ${PROVIDER_LABELS[row.provider]}. Manage it ${whereToManage(row.provider)}.`;
  }

  const priceText =
    row && state && !isTerminalStatus(state.status) && state.plan !== "free" && state.period && row.provider !== "manual"
      ? formatPlanPrice(state.plan, state.period)
      : null;

  return {
    plan: fresh.plan,
    planName: PLANS[fresh.plan].name,
    subscribedPlan: effective.subscribedPlan,
    reason: effective.reason,
    summary,
    overridden: fresh.overridden,
    provider,
    period: state?.period ?? null,
    willRenew: effective.willRenew,
    until: effective.until,
    priceText,
    needsPaymentAttention: effective.needsPaymentAttention,
    pendingChange,
    usage: {
      members: { used: members, limit: fresh.entitlements.max_household_members },
      items: { used: items, limit: fresh.entitlements.max_inventory_items },
      receiptScans,
    },
    overLimit: overLimitReport(fresh.entitlements, { members, items }),
    management,
    purchase: {
      platform,
      canStartCheckout: !native && isOwner && providers.web && offers.length > 0 && blockedReason === null,
      blockedReason,
      options,
      providers,
      store: storeOffer(platform),
      trialDays: TRIAL_DAYS,
    },
  };
}

/** The platform store's products, when this server can verify and link that store's purchases. Empty on the web. */
function storeOffer(platform: ClientPlatform): BillingOverview["purchase"]["store"] {
  const provider = storeFor(platform);
  if (!provider) return { provider: null, available: false, products: [] };
  const config = provider === "apple" ? apple.readAppleConfig() : google.readGoogleConfig();
  // Purchases are tied to a household by the account token, so without BILLING_ACCOUNT_SECRET none can be offered.
  if (!config || !env().BILLING_ACCOUNT_SECRET) return { provider, available: false, products: [] };
  const products: BillingOverview["purchase"]["store"]["products"] = [];
  for (const plan of PURCHASABLE_PLANS) {
    if (plan === "free" || plan === "pro") continue;
    for (const period of ["monthly", "annual"] as const) {
      const productId = productIdFor(config.products, plan, period);
      if (productId) products.push({ plan, period, productId, priceText: formatPlanPrice(plan, period) });
    }
  }
  return { provider, available: products.length > 0, products };
}

// ─── Web checkout and portal ────────────────────────────────────────────────

function checkoutUrls() {
  const base = env().APP_URL.replace(/\/$/, "");
  return {
    // The placeholder is Stripe's; it must stay unencoded.
    successUrl: `${base}${BILLING_PATH}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}${BILLING_PATH}?checkout=cancelled`,
  };
}

/** Turn a provider failure into something plain, and log the kind of failure (never the payload). */
function providerFailure(err: unknown, context: string): never {
  if (err instanceof AppError) throw err;
  console.error(`[billing.${context}]`, err instanceof Error ? `${err.name}: ${err.message.split("\n")[0].slice(0, 160)}` : "error");
  throw new AppError("internal", "We couldn't reach our payment provider just now. Nothing has been charged. Please try again in a moment.");
}

/** Inside the iOS and Android shells, subscriptions are bought and managed through the store, never a web page. */
function refuseOnNative(platform: ClientPlatform | undefined): void {
  if (platform && isNativePlatform(platform)) {
    throw new AppError("forbidden", "In the app, subscriptions are bought and managed through the App Store or Google Play.");
  }
}

/**
 * Start a web subscription. Returns the hosted checkout page to send the
 * owner to. Refuses Pro, plans that can't be bought here, and a household
 * that already has a subscription (that is changed in the portal, so it can
 * never be charged twice).
 */
export async function startWebCheckout(ctx: HouseholdContext, planInput: unknown, periodInput: unknown, opts: { platform?: ClientPlatform } = {}): Promise<{ url: string }> {
  requireCapability(ctx, "manage_billing");
  refuseOnNative(opts.platform);
  if (!isPlanId(planInput) || !isBillingPeriod(periodInput)) throw new AppError("validation", "Choose a plan and whether to pay monthly or yearly.");
  const plan = planInput;
  const period = periodInput;
  if (plan === "free") throw new AppError("validation", "The free plan doesn't need a subscription.");
  if (plan === "pro" || !PLANS[plan].available || !PURCHASABLE_PLANS.includes(plan)) throw new AppError("validation", "That plan isn't available yet.");

  const config = stripe.readStripeConfig();
  if (!config || !stripe.canSell(plan, period, config)) {
    throw new BillingUnavailableError("Paying on the web isn't available right now. Everything on your current plan keeps working.");
  }

  const now = new Date();
  const [row, fresh] = await Promise.all([loadSubscription(ctx.household.id), resolveHouseholdPlan(ctx.household.id, now)]);
  const state = row ? toSubscriptionState(row) : null;
  if (row && state && holdsLiveSubscription(state, fresh.effective.plan)) {
    if (row.provider !== "web") {
      throw new AppError("conflict", `Your household already has ${PLANS[state.plan].name} through ${PROVIDER_LABELS[row.provider]}. Manage or change it ${whereToManage(row.provider)}.`);
    }
    if (state.plan === plan && state.period === period) throw new AppError("conflict", `Your household is already on ${PLANS[plan].name}, paid ${period === "monthly" ? "monthly" : "yearly"}.`);
    if (state.status === "past_due" || state.status === "paused") {
      throw new AppError("conflict", "There's a problem with your current subscription. Open Manage billing to fix it rather than starting a new one.");
    }
    throw new AppError("conflict", "You already have a subscription. To switch plan or how often you pay, open Manage billing.");
  }

  await enforceRateLimit(`billing-checkout:${ctx.household.id}`, 10, 3600, "starting checkout");
  try {
    const { url } = await stripe.createCheckoutSession(
      {
        householdId: ctx.household.id,
        userId: ctx.user.id,
        plan,
        period,
        customerId: row?.provider === "web" ? row.providerCustomerId : null,
        email: ctx.user.email,
        ...checkoutUrls(),
      },
      config,
    );
    return { url };
  } catch (err) {
    return providerFailure(err, "checkout");
  }
}

/** The Stripe billing portal for the household's web subscription: payment method, plan changes, invoices, cancelling. */
export async function createPortalSession(ctx: HouseholdContext, opts: { platform?: ClientPlatform } = {}): Promise<{ url: string }> {
  requireCapability(ctx, "manage_billing");
  refuseOnNative(opts.platform);
  const config = stripe.readStripeConfig();
  if (!config) throw new BillingUnavailableError("The billing portal isn't available right now. Everything on your current plan keeps working.");
  const row = await loadSubscription(ctx.household.id);
  if (!row || row.provider !== "web" || !row.providerCustomerId) {
    throw new AppError("not_found", "There's no web subscription to manage for this household. If you subscribed through the App Store or Google Play, manage it there.");
  }
  await enforceRateLimit(`billing-portal:${ctx.household.id}`, 20, 3600, "opening billing");
  try {
    return await stripe.createPortalSession(row.providerCustomerId, `${env().APP_URL.replace(/\/$/, "")}${BILLING_PATH}`, config);
  } catch (err) {
    return providerFailure(err, "portal");
  }
}

/**
 * Confirm a purchase when the owner returns from Checkout, without waiting for
 * the webhook. The session must be this household's own; what is applied is
 * what Stripe says the subscription is, through the same state machine and
 * idempotency as a webhook, so doing both is harmless.
 */
export async function confirmWebCheckout(ctx: HouseholdContext, sessionId: unknown): Promise<{ confirmed: boolean }> {
  requireCapability(ctx, "manage_billing");
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]{8,200}$/.test(sessionId)) throw new AppError("validation", "That checkout link isn't valid.");
  const config = stripe.readStripeConfig();
  if (!config) throw new BillingUnavailableError();
  await enforceRateLimit(`billing-confirm:${ctx.household.id}`, 30, 3600, "confirming checkout");
  try {
    const session = await stripe.retrieveCheckoutSession(sessionId, config);
    if (session.client_reference_id !== ctx.household.id) throw new AppError("forbidden", "That checkout wasn't started by this household.");
    const subscription = session.subscription;
    if (session.mode !== "subscription" || !subscription || typeof subscription === "string") return { confirmed: false };
    const normalized = await stripe.normalizeSubscriptionSync(subscription as unknown as stripe.StripeSubscriptionLike, `checkout-sync:${session.id}`, new Date(), config.prices);
    normalized.link.householdId = ctx.household.id;
    normalized.link.householdVerified = true;
    const result = await applyNormalizedEvent(normalized);
    return { confirmed: result.outcome === "applied" || result.outcome === "unchanged" || result.outcome === "duplicate" };
  } catch (err) {
    return providerFailure(err, "confirm");
  }
}

// ─── Restore purchases ──────────────────────────────────────────────────────

export type RestoreProvider = "apple" | "google";

export interface RestoreResult {
  outcome: "linked" | "already_linked" | "nothing_to_restore";
  message: string;
}

const LINKED_ELSEWHERE =
  "That subscription already belongs to another household. A subscription belongs to one household and Plenty never moves it without that household's owner. If you think this is a mistake, contact support and we'll sort it out.";

/**
 * Link a store subscription to this household, after the store has vouched
 * for it. Verified with Apple or Google, not trusted from the device. It is
 * linked only if it isn't already linked to another household, and this
 * household doesn't already have a different subscription giving access. The
 * refusal explains why instead of moving anything.
 */
export async function restorePurchases(ctx: HouseholdContext, providerInput: unknown, proof: unknown): Promise<RestoreResult> {
  requireCapability(ctx, "manage_billing");
  if (providerInput !== "apple" && providerInput !== "google") throw new AppError("validation", "Choose the App Store or Google Play.");
  const provider: RestoreProvider = providerInput;
  const storeName = PROVIDER_LABELS[provider];
  const body = (typeof proof === "object" && proof !== null ? proof : {}) as Record<string, unknown>;

  const appleConfig = provider === "apple" ? apple.readAppleConfig() : null;
  const googleConfig = provider === "google" ? google.readGoogleConfig() : null;
  if (!appleConfig && !googleConfig) {
    throw new BillingUnavailableError(`Restoring ${storeName} purchases isn't available on this server. Everything on your current plan keeps working.`);
  }

  const now = new Date();
  await enforceRateLimit(`billing-restore:${ctx.household.id}`, 10, 3600, "restoring purchases");

  let verified: StoreRestoreResult;
  try {
    if (provider === "apple") {
      const signedTransaction = body.signedTransaction;
      const signedRenewalInfo = body.signedRenewalInfo;
      if (typeof signedTransaction !== "string" || signedTransaction.length < 20 || signedTransaction.length > 20_000) {
        throw new AppError("validation", "We need the purchase from your device to restore it. Please try again from the app.");
      }
      if (signedRenewalInfo != null && (typeof signedRenewalInfo !== "string" || signedRenewalInfo.length > 20_000)) {
        throw new AppError("validation", "We couldn't read that purchase. Please try again from the app.");
      }
      verified = await apple.verifyRestoreProof({ signedTransaction, signedRenewalInfo: (signedRenewalInfo as string | null | undefined) ?? null }, now, appleConfig);
    } else {
      const purchaseToken = body.purchaseToken;
      if (typeof purchaseToken !== "string" || purchaseToken.length < 10 || purchaseToken.length > 4096) {
        throw new AppError("validation", "We need the purchase from your device to restore it. Please try again from the app.");
      }
      verified = await google.verifyPurchaseToken(purchaseToken, now, googleConfig);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof WebhookAuthError) throw new AppError("validation", `${storeName} wouldn't confirm that purchase, so it can't be restored. Check you're signed in with the account that bought it.`);
    if (err instanceof WebhookRetryError) throw new AppError("internal", `We couldn't reach ${storeName} just now. Nothing has changed. Please try again in a moment.`);
    return providerFailure(err, `restore.${provider}`);
  }

  if (verified.state !== "live" || !verified.event) {
    return { outcome: "nothing_to_restore", message: verified.reason ?? "There's no active subscription to restore." };
  }

  // The purchase's own token says which household it was made for. If that household still exists and isn't this one, don't move it.
  if (verified.householdHint && verified.householdHint !== ctx.household.id) {
    const [hinted] = await systemDb.select({ id: households.id, deletedAt: households.deletedAt }).from(households).where(eq(households.id, verified.householdHint)).limit(1);
    if (hinted && !hinted.deletedAt) throw new AppError("conflict", LINKED_ELSEWHERE);
  }

  const [linked] = await systemDb
    .select({ householdId: subscriptions.householdId })
    .from(subscriptions)
    .where(and(eq(subscriptions.provider, provider), eq(subscriptions.providerSubscriptionId, verified.providerSubscriptionId)))
    .limit(1);
  if (linked && linked.householdId !== ctx.household.id) throw new AppError("conflict", LINKED_ELSEWHERE);

  const row = await loadSubscription(ctx.household.id);
  const state = row ? toSubscriptionState(row) : null;
  const sameSubscription = row?.provider === provider && row.providerSubscriptionId === verified.providerSubscriptionId;
  if (row && state && !sameSubscription) {
    const fresh = await resolveHouseholdPlan(ctx.household.id, now);
    if (holdsLiveSubscription(state, fresh.effective.plan)) {
      throw new AppError(
        "conflict",
        `Your household already has ${PLANS[state.plan].name} through ${PROVIDER_LABELS[row.provider]}. Only one subscription can be used, so that one stays. To use this one instead, cancel the other first ${whereToManage(row.provider)}.`,
      );
    }
  }

  const eventId = `restore:${createHash("sha256").update(`${provider}:${verified.providerSubscriptionId}`).digest("hex").slice(0, 24)}:${verified.event.occurredAt.getTime()}`;
  const result = await applyNormalizedEvent(
    {
      provider,
      eventId,
      providerType: "RESTORE",
      link: { ...verified.link, householdId: ctx.household.id, householdVerified: true, purchaserUserId: ctx.user.id },
      event: verified.event,
      note: `restore (${verified.environment})`,
    },
    { now },
  );

  if (result.outcome === "linked_elsewhere") throw new AppError("conflict", LINKED_ELSEWHERE);
  if (result.outcome === "conflict") {
    throw new AppError("conflict", "Your household already has a different subscription giving access, so this one wasn't applied.");
  }
  if (result.outcome === "retry" || result.outcome === "unlinked") {
    throw new AppError("internal", "We couldn't finish restoring that purchase. Nothing has changed. Please try again.");
  }

  if (provider === "google" && verified.needsAcknowledgement) {
    await google.acknowledge(verified.providerSubscriptionId, verified.providerProductId, googleConfig);
  }

  // Restoring what the household already has in force is a no-op for the person, even if the store's data refreshed it.
  const already = sameSubscription && state !== null && resolveEffectivePlan(state, now).plan !== "free";
  return {
    outcome: already ? "already_linked" : "linked",
    message: already
      ? `That ${PLANS[verified.plan].name} subscription is already part of your household.`
      : `${PLANS[verified.plan].name} is now part of your household. It's billed by ${storeName}, so you manage it there.`,
  };
}

// ─── Store purchase token ───────────────────────────────────────────────────

/**
 * The opaque token the native app attaches to a purchase (`appAccountToken`
 * on iOS, `obfuscatedAccountId` on Android), so the store's notifications can
 * be tied to this household. Owner only; unavailable until BILLING_ACCOUNT_SECRET is set.
 */
export function getStoreAccountToken(ctx: HouseholdContext): { token: string } {
  requireCapability(ctx, "manage_billing");
  const token = householdAccountToken(ctx.household.id);
  if (!token) throw new BillingUnavailableError("Buying through the app stores isn't available on this server yet.");
  return { token };
}

// ─── Household deletion ─────────────────────────────────────────────────────

export interface DeletionBilling {
  /** A web subscription was cancelled so the household isn't billed for something that no longer exists. */
  webCancelled: boolean;
  /** A store subscription can only be cancelled by its buyer in the store: tell the owner. */
  storeManaged: "apple" | "google" | null;
  /** A plain sentence for the confirmation, or null when billing has nothing to say. */
  message: string | null;
}

/**
 * Call before deleting a household. Cancels a web subscription immediately
 * (otherwise it would keep billing a household that no longer exists) and
 * reports a store subscription that the owner has to cancel in the store.
 * Throws if a live web subscription can't be cancelled, so deletion doesn't
 * go ahead and leave the owner paying.
 */
export async function prepareHouseholdDeletion(householdId: string): Promise<DeletionBilling> {
  const row = await loadSubscription(householdId);
  const state = row ? toSubscriptionState(row) : null;
  if (!row || !state || isTerminalStatus(state.status)) return { webCancelled: false, storeManaged: null, message: null };
  if (row.provider === "web" && row.providerSubscriptionId) {
    try {
      await stripe.cancelSubscriptionNow(row.providerSubscriptionId);
    } catch (err) {
      return providerFailure(err, "delete");
    }
    return { webCancelled: true, storeManaged: null, message: "Your subscription has been cancelled, so you won't be charged again." };
  }
  if (row.provider === "apple" || row.provider === "google") {
    return {
      webCancelled: false,
      storeManaged: row.provider,
      message: `Your subscription is billed by ${PROVIDER_LABELS[row.provider]}, so deleting the household doesn't cancel it. To stop being charged, cancel it ${whereToManage(row.provider)}.`,
    };
  }
  return { webCancelled: false, storeManaged: null, message: null };
}

export { annualSavings };
