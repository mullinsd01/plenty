import { NextResponse } from "next/server";
import { applyNormalizedEvent, type ApplyResult } from "@/server/billing/apply-event";
import { BillingUnavailableError, WebhookAuthError, WebhookRetryError } from "@/server/billing/errors";
import { badRequest, logWebhook, PayloadTooLargeError, readRawBody, temporaryFailure, tooLarge, unconfigured, webhookResult } from "@/server/billing/http";
import * as google from "@/server/billing/providers/google";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Google Play real-time developer notifications, delivered by a Pub/Sub push
 * subscription. Authenticated by the OIDC bearer token Pub/Sub attaches (its
 * signature, our URL as audience, our configured service account as sender).
 * A notification only says something changed: the state applied is fetched
 * from the Play Developer API. 400 for an unauthenticated or malformed push,
 * 503 when Google isn't set up or Google couldn't be reached (Pub/Sub
 * redelivers), 2xx once handled.
 */
export async function POST(request: Request) {
  const config = google.readGoogleConfig();
  if (!config) return unconfigured("Google Play");

  try {
    await google.verifyPush(request.headers.get("authorization"), config);

    let raw: string;
    try {
      raw = await readRawBody(request);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return tooLarge();
      throw err;
    }
    const { messageId, notification } = google.parsePush(raw);

    // Pub/Sub is configured per project: a notification for another app isn't ours to act on, and retrying it would never help.
    if (notification.packageName !== config.packageName) {
      logWebhook("google", "OTHER_PACKAGE", messageId, "ignored");
      return NextResponse.json({ received: true, outcome: "ignored" });
    }
    if (notification.testNotification) {
      logWebhook("google", "TEST", messageId, "ignored");
      return NextResponse.json({ received: true, outcome: "test" });
    }

    let result: ApplyResult | null = null;
    if (notification.subscriptionNotification) {
      const { purchaseToken, notificationType } = notification.subscriptionNotification;
      const fetched = await google.fetchSubscription(purchaseToken, config);
      if (!fetched) {
        logWebhook("google", "SUBSCRIPTION", messageId, "unknown purchase token");
        return NextResponse.json({ received: true, outcome: "ignored" });
      }
      const normalized = google.normalizeGoogleSubscription({ messageId, notificationType, purchaseToken, purchase: fetched.purchase, fetchedAt: fetched.fetchedAt, config });
      result = await applyNormalizedEvent(normalized);
      logWebhook("google", normalized.providerType, messageId, result.outcome);
      // Acknowledge only what reached a household. An unacknowledged purchase is refunded by Google after three days,
      // which is the right outcome for one that was never applied (a duplicate, or one with no household).
      if (normalized.acknowledge && (result.outcome === "applied" || result.outcome === "unchanged")) {
        await google.acknowledge(normalized.acknowledge.purchaseToken, normalized.acknowledge.productId, config);
      }
    } else if (notification.voidedPurchaseNotification) {
      const voided = notification.voidedPurchaseNotification;
      const fetched = voided.productType === 1 ? await google.fetchSubscription(voided.purchaseToken, config) : null;
      const normalized = google.normalizeGoogleVoided({ messageId, voided, purchase: fetched?.purchase ?? null, fetchedAt: fetched?.fetchedAt ?? new Date() });
      result = await applyNormalizedEvent(normalized);
      logWebhook("google", "VOIDED_PURCHASE", messageId, result.outcome);
    } else {
      logWebhook("google", "OTHER", messageId, "ignored");
      return NextResponse.json({ received: true, outcome: "ignored" });
    }
    return webhookResult(result);
  } catch (err) {
    if (err instanceof WebhookAuthError) return badRequest("The notification couldn't be verified.");
    if (err instanceof BillingUnavailableError) return unconfigured("Google Play");
    if (err instanceof WebhookRetryError) return temporaryFailure();
    console.error("[billing.google] notification failed:", err instanceof Error ? err.name : "error");
    return temporaryFailure();
  }
}

export function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405, headers: { allow: "POST" } });
}
