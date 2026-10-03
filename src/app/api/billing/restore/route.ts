import { NextResponse } from "next/server";
import { assertSameOrigin, billingError, readJsonBody } from "@/server/billing/http";
import { restorePurchases } from "@/server/billing/service";
import { routeContext } from "@/server/http";

/**
 * Restore a store purchase for this household (owner only).
 * Body: `{ provider: "apple", signedTransaction, signedRenewalInfo? }` or
 * `{ provider: "google", purchaseToken }`. The purchase is verified with the
 * store, and refused if it already belongs to another household.
 */
export async function POST(request: Request) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const result = await restorePurchases(ctx, body.provider, body);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return billingError(err, "billing.restore");
  }
}
