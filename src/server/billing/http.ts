import "server-only";
import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { jsonError } from "@/server/http";
import type { ApplyResult } from "./apply-event";
import { BillingUnavailableError } from "./errors";

/** Provider notifications are small. Anything bigger isn't one, and isn't read. */
export const MAX_WEBHOOK_BYTES = 1_000_000;
const MAX_JSON_BYTES = 64 * 1024;

export class PayloadTooLargeError extends Error {
  constructor() {
    super("The request body is too large.");
    this.name = "PayloadTooLargeError";
  }
}

/**
 * The request body exactly as received. Webhook signatures are computed over
 * these bytes, so they must never be parsed and re-serialised first. Reading
 * stops at `limit` bytes.
 */
export async function readRawBody(request: Request, limit = MAX_WEBHOOK_BYTES): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function unconfigured(provider: string): NextResponse {
  return NextResponse.json({ error: `${provider} isn't set up on this server.`, code: "not_configured" }, { status: 503 });
}

export const badRequest = (message: string) => NextResponse.json({ error: message, code: "invalid" }, { status: 400 });

export const tooLarge = () => NextResponse.json({ error: "That request is too large.", code: "too_large" }, { status: 413 });

/**
 * The answer to a provider once its notification has been handled. 2xx tells
 * the provider to stop sending it; an event that arrived before its
 * subscription gets a 503 so the provider delivers it again.
 */
export function webhookResult(result: Pick<ApplyResult, "outcome">): NextResponse {
  if (result.outcome === "retry") return NextResponse.json({ received: false, retry: true }, { status: 503 });
  return NextResponse.json({ received: true, outcome: result.outcome }, { status: 200 });
}

/** A transient failure after the notification was authenticated: the provider will retry. */
export const temporaryFailure = () => NextResponse.json({ received: false, retry: true }, { status: 503 });

/** Log what happened to a notification without anything from its body. */
export function logWebhook(provider: string, type: string, id: string, outcome: string): void {
  console.info(`[billing.${provider}] ${type.slice(0, 60)} ${id.slice(0, 80)} -> ${outcome}`);
}

/** Read a small JSON body from a signed-in request. Requires `application/json`, which a cross-site form can't send. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new AppError("validation", "That request wasn't in the expected format.");
  }
  let text: string;
  try {
    text = await readRawBody(request, MAX_JSON_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) throw new AppError("validation", "That request is too large.");
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AppError("validation", "That request wasn't in the expected format.");
}

/**
 * Browsers send an Origin on every POST. If one is present it must be this
 * site (the session cookie is already SameSite=Lax; this is a second lock).
 * Native apps send none.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let expected: string;
  try {
    expected = new URL(env().APP_URL).origin;
  } catch {
    return;
  }
  if (origin !== expected) throw new AppError("forbidden", "That request didn't come from Plenty.");
}

/** Errors from the signed-in billing routes: an unavailable provider is a 503, everything else as usual. */
export function billingError(err: unknown, context: string): NextResponse {
  if (err instanceof BillingUnavailableError) return NextResponse.json({ error: err.message, code: "not_configured" }, { status: 503 });
  return jsonError(err, context);
}
