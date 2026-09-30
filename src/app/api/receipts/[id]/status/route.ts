import { NextResponse, after } from "next/server";
import { jsonError, routeContext } from "@/server/http";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { getReceiptStatus, processReceipt } from "@/server/services/receipts";

// A nudge may restart reading in after(): allow for the slowest attempt (see PROCESSING_LEASE_SECONDS).
export const maxDuration = 300;

/** Poll a receipt's processing status. Re-queues work that was interrupted (e.g. a server restart). */
export async function GET(_request: Request, { params }: RouteContext<"/api/receipts/[id]/status">) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  try {
    const status = await getReceiptStatus(ctx, id);
    if (!status) return NextResponse.json({ error: "That receipt couldn't be found." }, { status: 404 });
    return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return jsonError(err, "receipts.status");
  }
}

/**
 * Nudge a receipt that's still "processing" (e.g. after a server restart).
 * Safe to call repeatedly: processing only restarts once the previous
 * attempt's lease has lapsed.
 */
export async function POST(_request: Request, { params }: RouteContext<"/api/receipts/[id]/status">) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  try {
    await enforceRateLimit(`receipt-nudge:${ctx.household.id}`, 60, 3600, "that");
    const status = await getReceiptStatus(ctx, id);
    if (status?.status === "processing") after(() => processReceipt(ctx.user.id, ctx.household, id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err, "receipts.nudge");
  }
}
