import { NextResponse } from "next/server";
import { jsonError, routeContext } from "@/server/http";
import { getReceiptImage } from "@/server/services/receipts";

/** Serve a receipt photo to members of the household that owns it. */
export async function GET(_request: Request, { params }: RouteContext<"/api/receipts/[id]/image">) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  try {
    const image = await getReceiptImage(ctx, id);
    if (!image) return NextResponse.json({ error: "Photo not found." }, { status: 404 });
    return new NextResponse(new Uint8Array(image), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    return jsonError(err, "receipts.image");
  }
}
