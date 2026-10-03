import { NextResponse } from "next/server";
import { assertSameOrigin, billingError, readJsonBody } from "@/server/billing/http";
import { confirmWebCheckout } from "@/server/billing/service";
import { routeContext } from "@/server/http";

/** Confirm a web purchase when returning from checkout, without waiting for the webhook. Body: `{ sessionId }`. */
export async function POST(request: Request) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const result = await confirmWebCheckout(ctx, body.sessionId);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return billingError(err, "billing.confirm");
  }
}
