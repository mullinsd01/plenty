import { NextResponse, after } from "next/server";
import { jsonError, routeContext } from "@/server/http";
import { AppError } from "@/server/errors";
import { createReceiptFromUpload, processReceipt } from "@/server/services/receipts";

export const maxDuration = 120;

/** Upload a receipt photo (multipart field "file"). Reading happens in the background. */
export async function POST(request: Request) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const form = await request.formData().catch(() => {
      throw new AppError("receipt_invalid", "We couldn't read that upload. Please try again.");
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("receipt_invalid", "Choose a photo of your receipt first.");
    const allowDuplicate = form.get("allowDuplicate") === "true";
    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await createReceiptFromUpload(ctx, { bytes, size: file.size }, { allowDuplicate });
    if (!result.duplicateOf) {
      after(() => processReceipt(ctx.user.id, ctx.household, result.receiptId));
    }
    return NextResponse.json(result, { status: result.duplicateOf ? 200 : 201 });
  } catch (err) {
    return jsonError(err, "receipts.upload");
  }
}
