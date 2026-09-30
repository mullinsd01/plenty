import "server-only";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getHouseholdContext, type HouseholdContext } from "@/server/auth/context";
import { env } from "@/server/env";
import { toUserError } from "@/server/errors";

const STATUS: Record<string, number> = {
  validation: 400,
  receipt_invalid: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  ai_unavailable: 503,
};

export function jsonError(err: unknown, context: string): NextResponse {
  const res = toUserError(err, context);
  return NextResponse.json({ error: res.error, code: res.code }, { status: STATUS[res.code ?? ""] ?? 500 });
}

/** Resolve the signed-in household for a route handler, or a 401 response. */
export async function routeContext(): Promise<HouseholdContext | NextResponse> {
  const ctx = await getHouseholdContext();
  if (!ctx) return NextResponse.json({ error: "Your session has expired. Please sign in again.", code: "unauthenticated" }, { status: 401 });
  return ctx;
}

/**
 * The caller's IP for rate limiting. X-Forwarded-For is read from the right,
 * skipping only the hops our own proxies added — the leftmost entries are
 * whatever the client chose to send and can't be trusted.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const hops = env().TRUSTED_PROXY_HOPS;
  const forwarded = (h.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const ip = hops > 0 && forwarded.length > 0 ? forwarded[Math.max(0, forwarded.length - hops)] : forwarded.at(-1);
  return (ip || h.get("x-real-ip") || "local").slice(0, 64);
}

/**
 * Only allow redirects to a path on this site. Values are resolved against a
 * placeholder origin so tricks like "/\t/evil.com" or "/%5Cevil.com" that a
 * browser would treat as another host are rejected.
 */
export function safeRedirectPath(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || /[\x00-\x1f\\]/.test(value)) return fallback;
  try {
    const url = new URL(value, "http://plenty.invalid");
    if (url.origin !== "http://plenty.invalid") return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
