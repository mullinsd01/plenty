import { NextResponse } from "next/server";
import { billingError } from "@/server/billing/http";
import { getStoreAccountToken } from "@/server/billing/service";
import { routeContext } from "@/server/http";

/**
 * The opaque token the native app attaches to a store purchase (`appAccountToken`
 * on iOS, `obfuscatedAccountId` on Android), so the store's notifications find
 * this household. Owner only.
 */
export async function GET() {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    return NextResponse.json(getStoreAccountToken(ctx), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return billingError(err, "billing.account-token");
  }
}
