import "server-only";
import type Stripe from "stripe";
import type { BillingLink, BillingEvent, NormalizedBillingEvent, PaidPlanId } from "@/lib/billing/events";
import { formatPlanPrice, PLANS, TRIAL_DAYS, type BillingPeriod } from "@/lib/billing/plans";
import { planForProductId, productIdFor, resolveProducts, type ProductMap } from "@/lib/billing/product-ids";
import { env, type Env } from "@/server/env";
import { BillingUnavailableError, WebhookAuthError } from "../errors";

/**
 * Web subscriptions through Stripe Checkout and the Stripe billing portal.
 *
 * Plenty never sees card details: Checkout and the portal are hosted by
 * Stripe. This module creates those sessions, verifies webhooks, and turns
 * Stripe's events into Plenty's normalised billing events. Everything that
 * reads Stripe objects does so through small structural types (below), so it
 * works with whichever API version the webhook endpoint is set to: a period's
 * end is read from the subscription item (newer API versions) or the
 * subscription itself (older ones).
 *
 * Subscriptions are created by *us* with the household id in the
 * subscription's metadata, so every `customer.subscription.*` event says
 * which household it is for, and that metadata can't be edited by the
 * customer.
 */

/** How long access continues after a renewal payment fails while Stripe retries it. */
export const STRIPE_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

// ─── Configuration ──────────────────────────────────────────────────────────

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** Stripe price id per plan and period. */
  prices: ProductMap;
}

type StripeEnv = Pick<Env, "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET" | "STRIPE_PRICES">;

/** The Stripe settings, or null when Stripe isn't set up (a key, a webhook secret and at least one price are all needed). */
export function readStripeConfig(source: StripeEnv = env()): StripeConfig | null {
  if (!source.STRIPE_SECRET_KEY || !source.STRIPE_WEBHOOK_SECRET) return null;
  const prices = resolveProducts("web", source.STRIPE_PRICES);
  if (Object.keys(prices).length === 0) return null;
  return { secretKey: source.STRIPE_SECRET_KEY, webhookSecret: source.STRIPE_WEBHOOK_SECRET, prices };
}

export function isConfigured(config: StripeConfig | null = readStripeConfig()): boolean {
  return config !== null;
}

/** Whether a particular plan and period can be bought on the web. */
export function canSell(plan: PaidPlanId, period: BillingPeriod, config: StripeConfig | null = readStripeConfig()): boolean {
  return config !== null && productIdFor(config.prices, plan, period) !== null;
}

function requireConfig(config: StripeConfig | null): StripeConfig {
  if (!config) throw new BillingUnavailableError("Paying on the web isn't available right now. Everything on your current plan keeps working.");
  return config;
}

let cached: { key: string; client: Stripe } | null = null;

async function client(config: StripeConfig): Promise<Stripe> {
  if (cached?.key === config.secretKey) return cached.client;
  const { default: StripeSdk } = await import("stripe");
  const created = new StripeSdk(config.secretKey, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: "Plenty" } });
  cached = { key: config.secretKey, client: created };
  return created;
}

// ─── Checkout and portal ────────────────────────────────────────────────────

export interface CheckoutInput {
  householdId: string;
  /** The owner starting the purchase. Recorded on the subscription so a restore or support request can find who bought it. */
  userId: string;
  plan: PaidPlanId;
  period: BillingPeriod;
  /** Reuse the household's existing Stripe customer, so receipts and payment methods stay in one place. */
  customerId?: string | null;
  /** Pre-fills Checkout's email field. Optional: Stripe asks for it otherwise. */
  email?: string | null;
  successUrl: string;
  cancelUrl: string;
}

/** What the customer reads next to the pay button: price, period, renewal and how to cancel. */
export function checkoutDisclosure(plan: PaidPlanId, period: BillingPeriod): string {
  const name = PLANS[plan].name;
  const price = formatPlanPrice(plan, period);
  const trial = TRIAL_DAYS > 0 ? ` Your first ${TRIAL_DAYS} days are free, then ${price}.` : "";
  return `${name}: ${price}.${trial} It renews automatically each ${period === "monthly" ? "month" : "year"} until you cancel. You can cancel any time from Settings, then Plan, and you keep ${name} until the period you've paid for ends.`;
}

/** Create a hosted Checkout page for a new subscription. Returns the URL to send the person to. */
export async function createCheckoutSession(input: CheckoutInput, config: StripeConfig | null = readStripeConfig()): Promise<{ url: string; sessionId: string }> {
  const cfg = requireConfig(config);
  const price = productIdFor(cfg.prices, input.plan, input.period);
  if (!price) throw new BillingUnavailableError("That plan isn't available on the web right now. Everything on your current plan keeps working.");
  const stripe = await client(cfg);
  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      client_reference_id: input.householdId,
      metadata: { household_id: input.householdId },
      subscription_data: {
        metadata: { household_id: input.householdId, purchaser_user_id: input.userId, plan: input.plan, period: input.period },
        ...(TRIAL_DAYS > 0 ? { trial_period_days: TRIAL_DAYS } : {}),
      },
      ...(input.customerId ? { customer: input.customerId } : input.email ? { customer_email: input.email } : {}),
      allow_promotion_codes: false,
      custom_text: { submit: { message: checkoutDisclosure(input.plan, input.period) } },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    },
    // A double click within the minute gets the same session instead of two.
    { idempotencyKey: `checkout:${input.householdId}:${input.plan}:${input.period}:${input.customerId ?? "new"}:${Math.floor(Date.now() / 60_000)}` },
  );
  if (!session.url) throw new BillingUnavailableError("We couldn't start checkout. Please try again in a moment.");
  return { url: session.url, sessionId: session.id };
}

/** A Stripe-hosted page where the household updates its card, switches plan, views invoices and cancels. */
export async function createPortalSession(customerId: string, returnUrl: string, config: StripeConfig | null = readStripeConfig()): Promise<{ url: string }> {
  const cfg = requireConfig(config);
  const stripe = await client(cfg);
  const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  return { url: session.url };
}

/** A completed Checkout Session with its subscription, for confirming a purchase when the person returns before the webhook has landed. */
export async function retrieveCheckoutSession(sessionId: string, config: StripeConfig | null = readStripeConfig()) {
  const cfg = requireConfig(config);
  const stripe = await client(cfg);
  return stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
}

/** Cancel a household's subscription right away (used when the household is deleted, so it isn't billed for something that no longer exists). */
export async function cancelSubscriptionNow(subscriptionId: string, config: StripeConfig | null = readStripeConfig()): Promise<void> {
  const cfg = requireConfig(config);
  const stripe = await client(cfg);
  await stripe.subscriptions.cancel(subscriptionId, { cancellation_details: { comment: "household deleted" } });
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

/**
 * Check a webhook's `Stripe-Signature` against the exact bytes received and
 * return the event. The body must be the raw text of the request: any
 * re-serialisation changes the bytes and the check fails.
 */
export async function verifyWebhook(rawBody: string, signatureHeader: string | null, config: StripeConfig | null = readStripeConfig()): Promise<Stripe.Event> {
  const cfg = requireConfig(config);
  if (!signatureHeader) throw new WebhookAuthError("Missing Stripe-Signature header.");
  const { default: StripeSdk } = await import("stripe");
  try {
    return StripeSdk.webhooks.constructEvent(rawBody, signatureHeader, cfg.webhookSecret);
  } catch {
    throw new WebhookAuthError("Stripe signature verification failed.");
  }
}

// ─── Normalisation ──────────────────────────────────────────────────────────

export interface StripeEventLike {
  id: string;
  type: string;
  /** Seconds since the epoch. */
  created: number;
  data: { object: unknown };
}

interface PriceLike {
  id?: string | null;
}
interface SubscriptionItemLike {
  price?: PriceLike | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
}
export interface StripeSubscriptionLike {
  id: string;
  status: string;
  customer?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
  items?: { data?: SubscriptionItemLike[] } | null;
  cancel_at_period_end?: boolean | null;
  cancel_at?: number | null;
  ended_at?: number | null;
  trial_end?: number | null;
  /** Older API versions put the period on the subscription. */
  current_period_start?: number | null;
  current_period_end?: number | null;
  cancellation_details?: { reason?: string | null } | null;
}
interface InvoiceLineLike {
  period?: { start?: number | null; end?: number | null } | null;
  pricing?: { price_details?: { price?: string | null } | null } | null;
  price?: PriceLike | null;
}
export interface StripeInvoiceLike {
  id: string;
  billing_reason?: string | null;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  parent?: { subscription_details?: { subscription?: string | { id: string } | null; metadata?: Record<string, string> | null } | null } | null;
  lines?: { data?: InvoiceLineLike[] } | null;
}
export interface StripeChargeLike {
  id: string;
  customer?: string | { id: string } | null;
  refunded?: boolean | null;
  amount?: number | null;
  amount_refunded?: number | null;
  payment_intent?: string | { id: string } | null;
}
interface SchedulePhaseLike {
  start_date?: number | null;
  end_date?: number | null;
  items?: Array<{ price?: string | PriceLike | null }> | null;
}
export interface StripeScheduleLike {
  id: string;
  status?: string | null;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  phases?: SchedulePhaseLike[] | null;
}
interface CheckoutSessionLike {
  id: string;
  mode?: string | null;
  client_reference_id?: string | null;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
}

export interface StripeNormalizeDeps {
  prices: ProductMap;
  /**
   * Find what a fully refunded charge paid for. `null` means it wasn't a
   * subscription payment (nothing to do). Left out, the refund is assumed to be
   * for the latest period.
   */
  resolveCharge?: (charge: StripeChargeLike) => Promise<{ subscriptionId: string | null; periodEnd: Date | null } | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idOf = (value: string | { id: string } | null | undefined): string | null => (typeof value === "string" ? value : (value?.id ?? null));
const toDate = (seconds: number | null | undefined): Date | null => (typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000) : null);
const uuidOrNull = (value: string | null | undefined): string | null => (value && UUID.test(value) ? value.toLowerCase() : null);

function planOfItems(items: SubscriptionItemLike[] | undefined, prices: ProductMap) {
  for (const item of items ?? []) {
    const ref = planForProductId(prices, item.price?.id);
    if (ref) return { ref, item };
  }
  return null;
}

function subscriptionLink(sub: StripeSubscriptionLike, priceId: string | null, item?: SubscriptionItemLike): BillingLink {
  return {
    providerSubscriptionId: sub.id,
    providerCustomerId: idOf(sub.customer),
    providerProductId: priceId,
    householdId: uuidOrNull(sub.metadata?.household_id),
    purchaserUserId: uuidOrNull(sub.metadata?.purchaser_user_id),
    currentPeriodStart: toDate(item?.current_period_start ?? sub.current_period_start),
  };
}

function ignored(event: StripeEventLike, link: BillingLink, note: string): NormalizedBillingEvent {
  return { provider: "web", eventId: event.id, providerType: event.type, link, event: null, note };
}

/** Whether Stripe ended the subscription because its time was up (as opposed to someone ending it early). */
function endedNaturally(sub: StripeSubscriptionLike, periodEnd: Date | null): boolean {
  if (sub.cancellation_details?.reason === "payment_failed" || sub.cancel_at_period_end) return true;
  const endedAt = toDate(sub.ended_at);
  return !endedAt || !periodEnd || endedAt.getTime() >= periodEnd.getTime() - 60_000;
}

/** Translate a Stripe event. Pure apart from the optional `resolveCharge` lookup. */
export async function normalizeStripeEvent(event: StripeEventLike, deps: StripeNormalizeDeps): Promise<NormalizedBillingEvent> {
  const at = toDate(event.created) ?? new Date();
  const base = { provider: "web" as const, eventId: event.id, providerType: event.type };

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as StripeSubscriptionLike;
      const found = planOfItems(sub.items?.data, deps.prices);
      const link = subscriptionLink(sub, found?.item.price?.id ?? null, found?.item);
      if (!found) return ignored(event, link, "subscription uses a price that isn't mapped to a plan");
      const { ref, item } = found;
      const periodEnd = toDate(item.current_period_end ?? sub.current_period_end);
      const trialEndsAt = toDate(sub.trial_end);
      const cancelAt = toDate(sub.cancel_at);
      const autoRenew = !(sub.cancel_at_period_end || cancelAt);
      const end = cancelAt && periodEnd && cancelAt.getTime() < periodEnd.getTime() ? cancelAt : periodEnd;

      if (event.type === "customer.subscription.deleted" || sub.status === "canceled") {
        const ended: BillingEvent = endedNaturally(sub, periodEnd) ? { type: "expired", occurredAt: at, periodEnd } : { type: "cancelled_now", occurredAt: at, periodEnd };
        return { ...base, link, event: ended };
      }

      if (sub.status === "incomplete" || sub.status === "incomplete_expired") {
        return ignored(event, link, "the first payment hasn't completed, so nothing is granted yet");
      }

      if (event.type === "customer.subscription.created" && (sub.status === "active" || sub.status === "trialing")) {
        return {
          ...base,
          link,
          event: {
            type: "started",
            occurredAt: at,
            provider: "web",
            plan: ref.plan,
            period: ref.period,
            currentPeriodEnd: end,
            trialEndsAt: sub.status === "trialing" ? trialEndsAt : null,
            autoRenew,
          },
        };
      }

      const status = sub.status === "unpaid" ? "past_due" : sub.status;
      if (status !== "active" && status !== "trialing" && status !== "past_due" && status !== "paused") {
        return ignored(event, link, `subscription status "${String(sub.status).slice(0, 30)}" isn't one Plenty acts on`);
      }
      return {
        ...base,
        link,
        event: {
          type: "snapshot",
          occurredAt: at,
          provider: "web",
          plan: ref.plan,
          period: ref.period,
          status,
          autoRenew,
          currentPeriodEnd: end,
          trialEndsAt: status === "trialing" ? trialEndsAt : null,
          // Retries of the same failure never extend this (see the state machine); "unpaid" means Stripe has given up collecting, so no grace.
          graceEndsAt: status === "past_due" ? (sub.status === "unpaid" ? null : new Date(at.getTime() + STRIPE_GRACE_DAYS * DAY_MS)) : undefined,
        },
      };
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as StripeInvoiceLike;
      const link = invoiceLink(invoice);
      // A failed first payment never granted anything. Failures of other charges (a proration, a manual invoice) don't end a paid period.
      if (invoice.billing_reason !== "subscription_cycle") return ignored(event, link, `payment failure on a "${String(invoice.billing_reason).slice(0, 30)}" invoice isn't a renewal`);
      const line = invoice.lines?.data?.[0];
      return {
        ...base,
        link,
        event: {
          type: "payment_failed",
          occurredAt: at,
          graceEndsAt: new Date(at.getTime() + STRIPE_GRACE_DAYS * DAY_MS),
          // On a renewal invoice the line's period starts where the paid period ended.
          periodEnd: toDate(line?.period?.start),
        },
      };
    }

    case "invoice.paid":
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as StripeInvoiceLike;
      const link = invoiceLink(invoice);
      if (invoice.billing_reason !== "subscription_cycle") return ignored(event, link, `payment for a "${String(invoice.billing_reason).slice(0, 30)}" invoice isn't a renewal`);
      const line = invoice.lines?.data?.[0];
      const end = toDate(line?.period?.end);
      if (!end) return ignored(event, link, "the paid invoice doesn't say what period it covers");
      const priceId = line?.pricing?.price_details?.price ?? line?.price?.id ?? null;
      const ref = planForProductId(deps.prices, priceId);
      return {
        ...base,
        link: { ...link, providerProductId: priceId },
        event: { type: "renewed", occurredAt: at, currentPeriodEnd: end, ...(ref ? { plan: ref.plan, period: ref.period } : {}) },
      };
    }

    case "charge.refunded": {
      const charge = event.data.object as StripeChargeLike;
      const customerId = idOf(charge.customer);
      const link: BillingLink = { providerCustomerId: customerId };
      if (!charge.refunded) return ignored(event, link, "partial refund: access is unchanged");
      let periodEnd: Date | null = null;
      if (deps.resolveCharge) {
        const resolved = await deps.resolveCharge(charge);
        if (!resolved) return ignored(event, link, "refund of a payment that isn't a subscription");
        link.providerSubscriptionId = resolved.subscriptionId;
        periodEnd = resolved.periodEnd;
      }
      return { ...base, link, event: { type: "refunded", occurredAt: at, periodEnd } };
    }

    case "checkout.session.completed": {
      const session = event.data.object as CheckoutSessionLike;
      const link: BillingLink = {
        providerSubscriptionId: idOf(session.subscription),
        providerCustomerId: idOf(session.customer),
        householdId: uuidOrNull(session.client_reference_id),
      };
      return ignored(event, link, "checkout completed; the subscription itself arrives as its own event");
    }

    case "subscription_schedule.created":
    case "subscription_schedule.updated":
    case "subscription_schedule.released":
    case "subscription_schedule.canceled": {
      const schedule = event.data.object as StripeScheduleLike;
      const link: BillingLink = { providerSubscriptionId: idOf(schedule.subscription), providerCustomerId: idOf(schedule.customer) };
      const phases = schedule.phases ?? [];
      const nowSec = event.created;
      const current = phases.findIndex((p) => (p.start_date ?? 0) <= nowSec && (p.end_date == null || nowSec < p.end_date));
      if (current === -1) return ignored(event, link, "schedule has no phase in force");
      const priceOf = (phase: SchedulePhaseLike | undefined) => {
        const price = phase?.items?.[0]?.price;
        return typeof price === "string" ? price : (price?.id ?? null);
      };
      // A schedule that is still running with a later phase is a change booked for the next renewal;
      // one that ended or has nothing later means any booked change is gone.
      const running = schedule.status === "active" || schedule.status === "not_started";
      const next = running ? phases[current + 1] : undefined;
      const target = planForProductId(deps.prices, priceOf(next ?? phases[current]));
      if (!target) return ignored(event, link, "schedule uses a price that isn't mapped to a plan");
      return {
        ...base,
        link,
        event: { type: "plan_changed", occurredAt: at, plan: target.plan, period: target.period, timing: "next_renewal" },
      };
    }

    default:
      return ignored(event, {}, "not an event Plenty acts on");
  }
}

function invoiceLink(invoice: StripeInvoiceLike): BillingLink {
  const details = invoice.parent?.subscription_details;
  return {
    providerSubscriptionId: idOf(details?.subscription ?? invoice.subscription),
    providerCustomerId: idOf(invoice.customer),
    householdId: uuidOrNull(details?.metadata?.household_id),
  };
}

/** The Stripe-backed lookup for `charge.refunded`: which subscription invoice a charge paid, and the period it covered. */
export function stripeChargeResolver(config: StripeConfig): NonNullable<StripeNormalizeDeps["resolveCharge"]> {
  return async (charge) => {
    const paymentIntent = idOf(charge.payment_intent);
    if (!paymentIntent) return null;
    const stripe = await client(config);
    const payments = await stripe.invoicePayments.list({
      payment: { type: "payment_intent", payment_intent: paymentIntent },
      expand: ["data.invoice"],
      limit: 1,
    });
    const invoice = payments.data[0]?.invoice;
    if (!invoice || typeof invoice === "string" || invoice.deleted) return null;
    const like = invoice as unknown as StripeInvoiceLike;
    const details = like.parent?.subscription_details;
    const subscriptionId = idOf(details?.subscription ?? like.subscription);
    if (!subscriptionId) return null;
    return { subscriptionId, periodEnd: toDate(like.lines?.data?.[0]?.period?.end) };
  };
}

/**
 * A subscription object (from the API rather than a webhook) as a normalised
 * event, for confirming a purchase when the person returns from Checkout
 * before the webhook has been delivered.
 */
export function normalizeSubscriptionSync(subscription: StripeSubscriptionLike, eventId: string, now: Date, prices: ProductMap): Promise<NormalizedBillingEvent> {
  return normalizeStripeEvent(
    { id: eventId, type: "customer.subscription.created", created: Math.floor(now.getTime() / 1000), data: { object: subscription } },
    { prices },
  );
}
