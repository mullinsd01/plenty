import "server-only";
import { NextResponse } from "next/server";
import { getHouseholdContext, type HouseholdContext } from "@/server/auth/context";
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
