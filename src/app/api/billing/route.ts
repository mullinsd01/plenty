import { NextResponse } from "next/server";
import { detectPlatform } from "@/lib/billing/platform";
import { billingError } from "@/server/billing/http";
import { getBillingOverview } from "@/server/billing/service";
import { routeContext } from "@/server/http";

/** The household's plan, usage against its limits, and which ways of paying are on offer. */
export async function GET(request: Request) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const overview = await getBillingOverview(ctx, { platform: detectPlatform(request.headers) });
    return NextResponse.json(overview, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return billingError(err, "billing.overview");
  }
}
