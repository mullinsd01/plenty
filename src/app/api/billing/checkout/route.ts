import { NextResponse } from "next/server";
import { detectPlatform } from "@/lib/billing/platform";
import { assertSameOrigin, billingError, readJsonBody } from "@/server/billing/http";
import { startWebCheckout } from "@/server/billing/service";
import { routeContext } from "@/server/http";

/** Start a web subscription (owner only). Body: `{ plan, period }`. Returns `{ url }` for the hosted checkout page. */
export async function POST(request: Request) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const { url } = await startWebCheckout(ctx, body.plan, body.period, { platform: detectPlatform(request.headers) });
    return NextResponse.json({ url }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return billingError(err, "billing.checkout");
  }
}
