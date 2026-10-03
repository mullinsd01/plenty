import { NextResponse } from "next/server";
import { requireEntitlement } from "@/server/billing/limits";
import { AppError } from "@/server/errors";
import { jsonError, routeContext } from "@/server/http";
import { MAX_PHOTO_BYTES } from "@/server/photos/grocery-image";
import { recognizeGroceryPhoto } from "@/server/services/photo-recognition";

// A vision call can take a while on a slow connection.
export const maxDuration = 90;

const UNREADABLE = "We couldn't read that upload. Please try again.";

/**
 * Recognise groceries in one photo (multipart field "file"). Returns a proposal to review;
 * nothing is added. The photo is processed in memory and is not stored.
 */
export async function POST(request: Request) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    // Refuse early, before reading a body that can't be used.
    requireEntitlement(ctx, "photo_recognition", "Photo recognition");
    // Refuse oversized or unbounded bodies before reading anything into memory.
    const length = Number(request.headers.get("content-length") ?? NaN);
    if (!Number.isFinite(length)) throw new AppError("validation", UNREADABLE);
    if (length > MAX_PHOTO_BYTES + 64 * 1024) {
      return NextResponse.json({ error: "That photo is too big. Please take a smaller one.", code: "validation" }, { status: 413 });
    }
    const form = await request.formData().catch(() => {
      throw new AppError("validation", UNREADABLE);
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("validation", "Choose a photo of your groceries first.");
    if (file.size > MAX_PHOTO_BYTES) {
      return NextResponse.json({ error: "That photo is too big. Please take a smaller one.", code: "validation" }, { status: 413 });
    }
    const proposal = await recognizeGroceryPhoto(ctx, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json(proposal, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return jsonError(err, "photo.recognize");
  }
}
