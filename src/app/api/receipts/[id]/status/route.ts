import { NextResponse, after } from "next/server";
import { jsonError, routeContext } from "@/server/http";
import { getReceiptStatus, processReceipt } from "@/server/services/receipts";

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

/** Kick processing for a receipt stuck in "processing". Idempotent. */
export async function POST(_request: Request, { params }: RouteContext<"/api/receipts/[id]/status">) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const status = await getReceiptStatus(ctx, id);
  if (status?.status === "processing") after(() => processReceipt(ctx.user.id, ctx.household, id));
  return NextResponse.json({ ok: true });
}
