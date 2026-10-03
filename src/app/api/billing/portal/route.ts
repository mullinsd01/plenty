import { NextResponse } from "next/server";
import { detectPlatform } from "@/lib/billing/platform";
import { assertSameOrigin, billingError } from "@/server/billing/http";
import { createPortalSession } from "@/server/billing/service";
import { routeContext } from "@/server/http";

/** Open the billing portal for the household's web subscription (owner only). Returns `{ url }`. */
export async function POST(request: Request) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    assertSameOrigin(request);
    const { url } = await createPortalSession(ctx, { platform: detectPlatform(request.headers) });
    return NextResponse.json({ url }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return billingError(err, "billing.portal");
  }
}
