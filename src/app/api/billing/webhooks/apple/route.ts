import { NextResponse } from "next/server";
import { z } from "zod";
import { applyNormalizedEvent } from "@/server/billing/apply-event";
import { BillingUnavailableError, WebhookAuthError, WebhookRetryError } from "@/server/billing/errors";
import { badRequest, logWebhook, PayloadTooLargeError, readRawBody, temporaryFailure, tooLarge, unconfigured, webhookResult } from "@/server/billing/http";
import * as apple from "@/server/billing/providers/apple";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({ signedPayload: z.string().min(20).max(200_000) });

/**
 * App Store Server Notifications V2. The body is `{ "signedPayload": "<JWS>" }`;
 * authenticity is Apple's signature on the payload (verified against the root
 * certificates you configure), not a cookie. 400 for anything that doesn't
 * verify, 503 when Apple isn't set up or can't be checked right now (Apple
 * retries), 2xx once handled.
 */
export async function POST(request: Request) {
  const config = apple.readAppleConfig();
  if (!config) return unconfigured("The App Store");

  let raw: string;
  try {
    raw = await readRawBody(request);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return tooLarge();
    throw err;
  }
  let signedPayload: string;
  try {
    signedPayload = bodySchema.parse(JSON.parse(raw)).signedPayload;
  } catch {
    return badRequest("That isn't an App Store notification.");
  }

  try {
    const decoded = await apple.verifyNotification(signedPayload, config);
    const normalized = apple.normalizeAppleNotification(decoded, config);
    const result = await applyNormalizedEvent(normalized);
    logWebhook("apple", normalized.providerType, normalized.eventId, result.outcome);
    return webhookResult(result);
  } catch (err) {
    if (err instanceof WebhookAuthError) return badRequest("The notification couldn't be verified.");
    if (err instanceof BillingUnavailableError) return unconfigured("The App Store");
    if (err instanceof WebhookRetryError) return temporaryFailure();
    console.error("[billing.apple] notification failed:", err instanceof Error ? err.name : "error");
    return temporaryFailure();
  }
}

export function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405, headers: { allow: "POST" } });
}
