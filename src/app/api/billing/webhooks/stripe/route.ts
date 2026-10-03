import { NextResponse } from "next/server";
import { applyNormalizedEvent } from "@/server/billing/apply-event";
import { BillingUnavailableError, WebhookAuthError } from "@/server/billing/errors";
import { badRequest, logWebhook, PayloadTooLargeError, readRawBody, temporaryFailure, tooLarge, unconfigured, webhookResult } from "@/server/billing/http";
import * as stripe from "@/server/billing/providers/stripe";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Stripe webhooks. Server to server: authenticated by Stripe's signature over
 * the raw body, never by a cookie. Answers 400 for a bad signature, 503 when
 * Stripe isn't set up, and 2xx once an event has been handled (or safely
 * ignored). Nothing from the payload is logged.
 */
export async function POST(request: Request) {
  const config = stripe.readStripeConfig();
  if (!config) return unconfigured("Stripe");

  let raw: string;
  try {
    raw = await readRawBody(request);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return tooLarge();
    throw err;
  }

  let event: Awaited<ReturnType<typeof stripe.verifyWebhook>>;
  try {
    event = await stripe.verifyWebhook(raw, request.headers.get("stripe-signature"), config);
  } catch (err) {
    if (err instanceof WebhookAuthError) return badRequest("The signature couldn't be verified.");
    if (err instanceof BillingUnavailableError) return unconfigured("Stripe");
    throw err;
  }

  try {
    const normalized = await stripe.normalizeStripeEvent(event as unknown as stripe.StripeEventLike, {
      prices: config.prices,
      resolveCharge: stripe.stripeChargeResolver(config),
    });
    const result = await applyNormalizedEvent(normalized);
    logWebhook("stripe", event.type, event.id, result.outcome);
    return webhookResult(result);
  } catch (err) {
    console.error(`[billing.stripe] ${event.type} ${event.id} failed:`, err instanceof Error ? err.name : "error");
    return temporaryFailure();
  }
}

export function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405, headers: { allow: "POST" } });
}
