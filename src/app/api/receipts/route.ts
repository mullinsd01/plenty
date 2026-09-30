import { NextResponse, after } from "next/server";
import { jsonError, routeContext } from "@/server/http";
import { AppError } from "@/server/errors";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { MAX_UPLOAD_BYTES, createReceiptFromUpload, processReceipt } from "@/server/services/receipts";

// Reading runs in after() on this request: allow for the slowest attempt (see PROCESSING_LEASE_SECONDS).
export const maxDuration = 300;

/** Upload a receipt photo (multipart field "file"). Reading happens in the background. */
export async function POST(request: Request) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    // Refuse oversized or unbounded bodies before reading anything into memory.
    const length = Number(request.headers.get("content-length") ?? NaN);
    if (!Number.isFinite(length)) throw new AppError("receipt_invalid", "We couldn't read that upload. Please try again.");
    if (length > MAX_UPLOAD_BYTES + 64 * 1024) {
      return NextResponse.json({ error: "That photo is too large (15 MB max). Try a smaller one.", code: "receipt_invalid" }, { status: 413 });
    }
    await enforceRateLimit(`receipt-upload:${ctx.household.id}`, 30, 3600, "uploading receipts");
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
