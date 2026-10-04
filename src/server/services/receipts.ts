import "server-only";
import { and, desc, eq, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import sharp from "sharp";
import type { ProductInfo } from "@/lib/catalog/types";
import { formatShortDate, isDateString, toDateString, zonedDateTimeToInstant } from "@/lib/dates";
import { levelPhrase, type Aisle, type StorageLocation } from "@/lib/domain";
import { aliasKey as toAliasKey, cleanReceiptText, normalizeReceiptLine } from "@/lib/normalize";
import { receiptFingerprint } from "@/lib/receipts/fingerprint";
import { READING_SEPARATOR } from "@/lib/receipts/parse";
import { redactReceiptLine, redactReceiptText, redactStoreLabel } from "@/lib/receipts/redact";
import { assessReceiptQuality } from "@/lib/receipts/quality";
import { formatPackQuantity, isContainerUnit, isUnit, unitDimension, type Unit } from "@/lib/units";
import { AIUnavailableError, getLocalProvider, providerFor, RECEIPT_AI_BUDGET_MS, type AIProvider, type ReceiptExtraction } from "@/server/ai";
import type { HouseholdContext, HouseholdInfo } from "@/server/auth/context";
import { systemDb, withUser } from "@/server/db/client";
import {
  householdMembers,
  households,
  notifications,
  preferences,
  receiptItems,
  receipts,
  inventoryItems,
  type DbInventoryItem,
  type DbReceipt,
} from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { deleteFile, readStoredFile, receiptImageKey, saveFile } from "@/server/storage/files";
import { MAX_STORED_EDGE_PX, prepareReceiptImage, ReceiptImageError } from "@/server/receipts/image";
import { scopeOf, type ItemVisibility } from "@/lib/members/scope";
import { addUsage, usagePeriod, USAGE_RECEIPT_SCANS } from "@/server/billing/entitlements";
import { assertReceiptScanAvailable, assertRoomForItemsIn } from "@/server/billing/limits";
import { requireCapability } from "@/server/permissions";
import { addItemsTx, finishItemTx, inferEndTime, resolveOwnership } from "./inventory";
import { computeLiveState, predictionFor, refreshLearning } from "./learning";
import { loadProductIndex, matchOptions, productCandidates, rememberAlias, type ProductIndex } from "./products";
import { deleteExpiredReceiptImages, imageDeleteAfter, isRetentionPolicy, uncheckedImageDeadline } from "./receipt-privacy";
import { markPurchasedFromReceipt, syncShoppingList } from "./shopping";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
/** Time allowed for the on-device reader after the AI reader gives up. */
const LOCAL_READ_ALLOWANCE_MS = 60_000;
/**
 * A processing attempt "owns" a receipt for this long. Another attempt (a
 * retry, or a nudge after a server restart) can only take over once it lapses,
 * so two readers never race to write the same receipt. It outlasts the slowest
 * attempt (the AI budget plus the on-device fallback), so a slow but live
 * attempt is never taken over; the receipt routes' maxDuration (300 s) outlasts it.
 */
const PROCESSING_LEASE_SECONDS = Math.ceil((RECEIPT_AI_BUDGET_MS + LOCAL_READ_ALLOWANCE_MS) / 1000) + 30;
/** Receipts still "processing" this long after upload are given up on (with a retry button), not read again. */
const MAX_PROCESSING_AGE_MS = 3 * 3_600_000;
const MATCH_CONFIDENT = 0.8;
const MATCH_PLAUSIBLE = 0.55;
/** Largest amount and pack count a receipt line can have; readings are clamped to them and confirming checks them. */
export const MAX_RECEIPT_QUANTITY = 100_000;
export const MAX_RECEIPT_PACKS = 1_000;
/** Prices beyond this are misreads (card or barcode digits); they'd also overflow the money columns. */
const MAX_RECEIPT_MONEY = 100_000;
/** A kitchen item ticked off the shopping list this close to the receipt's date is probably the same purchase. */
const LIST_PURCHASE_WINDOW_MS = 3 * 86_400_000;
/** Receipt wording for things sold one at a time. */
const LOOSE_ITEM = /\b(EA|EACH|LOOSE)\b/i;
/** What the AI reader says when part of the receipt isn't in the photo. */
const CUT_OFF_PROBLEM = /\b(cut off|cropped|missing|torn|folded|incomplete|partial|not visible|out of (the )?frame)\b/i;

/** A money amount read from a receipt, or null when it can't be a real price. */
function receiptMoney(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_RECEIPT_MONEY) return null;
  return Math.round(value * 100) / 100;
}

/** Line prices that don't add up to the printed total (or subtotal) mean lines were missed or misread. */
function totalsDisagree(prices: number[], total: number | null, subtotal: number | null): boolean {
  const references = [total, subtotal].filter((r): r is number => r !== null && r > 0);
  if (prices.length === 0 || references.length === 0) return false;
  const sum = prices.reduce((acc, p) => acc + p, 0);
  return references.every((ref) => Math.abs(sum - ref) > Math.max(ref * 0.05, 0.1));
}

/** Kitchen items ticked off the shopping list around the time of this shop — likely this very purchase. */
function listBatchesFor(activeItems: DbInventoryItem[], productId: string, receiptTime: Date): DbInventoryItem[] {
  return activeItems.filter(
    (i) =>
      i.productId === productId &&
      i.source === "shopping_list" &&
      Math.abs(i.purchasedAt.getTime() - receiptTime.getTime()) < LIST_PURCHASE_WINDOW_MS,
  );
}

// ─── Upload ─────────────────────────────────────────────────────────────────

export interface UploadResult {
  receiptId: string;
  /** The same photo was uploaded before; `status` says whether it's already in the kitchen or still waiting. */
  duplicateOf: { id: string; date: string | null; status: DbReceipt["status"] } | null;
}

/**
 * Validate and store a receipt photo, then queue it for reading. The caller
 * schedules `processReceipt` (e.g. with `after()`) so the upload returns fast.
 */
export async function createReceiptFromUpload(
  ctx: HouseholdContext,
  file: { bytes: Buffer; size: number },
  opts: { allowDuplicate?: boolean } = {},
): Promise<UploadResult> {
  requireCapability(ctx, "scan_receipts");
  if (file.size === 0) throw new AppError("receipt_invalid", "That file is empty. Try taking the photo again.");
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError("receipt_invalid", "That photo is too large (15 MB max). Try a smaller one.");

  let prepared;
  try {
    prepared = await prepareReceiptImage(file.bytes);
  } catch (err) {
    if (err instanceof ReceiptImageError) throw new AppError("receipt_invalid", err.message);
    throw err;
  }

  return withUser(ctx.user.id, async (tx) => {
    if (!opts.allowDuplicate) {
      const [dupe] = await tx
        .select({ id: receipts.id, purchasedAt: receipts.purchasedAt, status: receipts.status })
        .from(receipts)
        .where(
          and(
            eq(receipts.householdId, ctx.household.id),
            eq(receipts.imageHash, prepared.sha256),
            notInArray(receipts.status, ["discarded", "failed"]),
            isNull(receipts.deletedAt),
          ),
        )
        .limit(1);
      if (dupe) {
        return {
          receiptId: dupe.id,
          duplicateOf: {
            id: dupe.id,
            date: dupe.purchasedAt ? toDateString(dupe.purchasedAt, ctx.household.timezone) : null,
            status: dupe.status,
          },
        };
      }
    }
    // Past this month's allowance on the plan: say so before anything is stored. Manual entry always works.
    await assertReceiptScanAvailable(ctx);
    const [row] = await tx
      .insert(receipts)
      .values({ householdId: ctx.household.id, uploadedBy: ctx.user.id, status: "processing", imageHash: prepared.sha256 })
      .returning({ id: receipts.id });
    const key = receiptImageKey(ctx.household.id, row.id);
    await saveFile(key, prepared.buffer);
    await tx
      .update(receipts)
      .set({
        imagePath: key,
        // Removed after two weeks if nobody ever checks the receipt; checking it sets the household's own choice.
        imageDeleteAfter: uncheckedImageDeadline(new Date()),
        processingStartedAt: null,
        qualityWarnings: prepared.blurScore < 60 ? ["blurry"] : [],
      })
      .where(eq(receipts.id, row.id));
    return { receiptId: row.id, duplicateOf: null };
  });
}

// ─── Processing ─────────────────────────────────────────────────────────────

const FAILURE_MESSAGES: Record<string, string> = {
  not_a_receipt: "This doesn't look like a receipt. Try a photo of the whole receipt, flat and well lit.",
  unreadable: "We couldn't read this receipt. Try again in better light, holding the phone steady and close enough to fill the frame.",
  empty: "We couldn't find any items on this receipt. Make sure the item lines are in the photo.",
  missing_image: "The photo for this receipt is missing. Please upload it again.",
  ai_failed: "Reading this receipt failed. Please try again in a moment.",
  // The AI reader was unavailable and the on-device reader couldn't manage: the photo is probably fine.
  ai_busy: "Our receipt reader is busy right now, and the backup reader couldn't make this one out. Try reading it again in a few minutes.",
  interrupted: "Reading this receipt was interrupted. Try reading it again.",
};

interface NormalizedReceiptLine {
  lineIndex: number;
  rawText: string;
  name: string;
  product: ProductInfo | null;
  matchConfidence: number;
  quantity: number;
  unit: Unit;
  packCount: number;
  unitPrice: number | null;
  totalPrice: number | null;
  isFood: boolean;
  aliasKey: string;
  ignoredByDefault: boolean;
}

/** Turn extracted lines into reviewable, product-matched lines. Pure apart from the product index. */
export function normalizeExtraction(extraction: ReceiptExtraction, index: ProductIndex): NormalizedReceiptLine[] {
  const opts = matchOptions(index);
  const out: NormalizedReceiptLine[] = [];
  extraction.lines.forEach((line, i) => {
    // What's stored (and matched, and remembered) is the line with any card, phone or email details removed.
    const raw = redactReceiptLine(line.raw.trim()).trim();
    if (!raw) return;
    const fromRaw = normalizeReceiptLine(raw, opts);
    const fromName = line.name ? normalizeReceiptLine(line.name, opts) : null;
    const best =
      fromName && (fromName.match?.score ?? 0) > (fromRaw.match?.score ?? 0) + 0.02 ? { ...fromName, aliasKey: fromRaw.aliasKey } : fromRaw;
    const match = best.match && best.match.score >= MATCH_PLAUSIBLE ? best.match : null;
    const product = match ? index.bySlug.get(match.product.slug) ?? null : null;

    let quantity = best.quantity;
    let unit: Unit = best.unit;
    let packCount = best.packCount;
    const description = raw.split("\n")[0];
    const cleaned = cleanReceiptText(description);
    // Loose produce priced per item ("BANANAS CAVENDISH EA", "7 @ $0.62"): the count is
    // the number of items, not a number of the product's usual bags or bunches.
    const looseLine = product !== null && cleaned.size === null && cleaned.packCount === null && LOOSE_ITEM.test(description);
    const itemsBought = line.quantity && line.quantity > 0 && Number.isInteger(line.quantity) ? line.quantity : 1;
    const hasWeight = Boolean(line.weightKg && line.weightKg > 0);
    if (looseLine && !hasWeight && unitDimension(product.unit) === "count" && !isContainerUnit(product.unit)) {
      quantity = itemsBought;
      unit = product.unit;
      packCount = 1;
    } else if (looseLine && !hasWeight && unitDimension(product.unit) === "mass" && product.eachWeightG) {
      // Weighed produce bought by the piece ("CARROTS EA", 4 @ $0.50): about 400 g, not four 1 kg bags.
      const grams = itemsBought * product.eachWeightG;
      quantity = product.unit === "kg" ? Math.round(grams) / 1000 : Math.round(grams);
      unit = product.unit;
      packCount = 1;
    } else if (line.weightKg && line.weightKg > 0) {
      quantity = Math.round(line.weightKg * 1000) / 1000;
      unit = "kg";
      packCount = 1;
    } else if (line.quantity && line.quantity > 1 && Number.isInteger(line.quantity)) {
      packCount = line.quantity * Math.max(1, packCount);
      quantity = best.quantity * line.quantity;
    }
    // A plausible match shows the product's proper name; the review lists it under
    // "give these a quick look" with alternatives, and the receipt wording stays visible.
    const name = product ? product.name : line.name?.trim() || best.name || raw;
    const nonGrocery = !line.isGrocery || (!best.isFood && !product);
    out.push({
      lineIndex: i,
      rawText: raw.slice(0, 200),
      name: name.slice(0, 120),
      product,
      matchConfidence: match?.score ?? 0,
      quantity: quantity > 0 ? Math.min(quantity, MAX_RECEIPT_QUANTITY) : 1,
      unit: isUnit(unit) ? unit : "each",
      // e.g. "TEA BAGS 200PK" or 5 × "WATER 24PK"; kept within what confirming accepts.
      packCount: Math.min(MAX_RECEIPT_PACKS, Math.max(1, Math.round(packCount) || 1)),
      unitPrice: receiptMoney(line.unitPrice),
      totalPrice: receiptMoney(line.price),
      isFood: !nonGrocery,
      aliasKey: best.aliasKey || toAliasKey(raw),
      ignoredByDefault: nonGrocery,
    });
  });
  return out;
}

async function extractWithFallback(
  householdId: string,
  input: Parameters<AIProvider["extractReceipt"]>[0],
): Promise<{ extraction: ReceiptExtraction; fellBack: boolean }> {
  // The outside AI reader only when the household agreed, its plan includes it and it's set up (see src/server/ai/consent.ts);
  // otherwise the on-device reader, which sends nothing anywhere. Decided now, so a withdrawal applies to the very next read.
  const { provider } = await providerFor(householdId);
  try {
    return { extraction: await provider.extractReceipt(input), fellBack: false };
  } catch (err) {
    if (provider.id === "anthropic" && err instanceof AIUnavailableError) {
      console.warn(`[receipts] ${provider.label} unavailable (${err.reason}); falling back to on-device reading`);
      return { extraction: await getLocalProvider().extractReceipt(input), fellBack: true };
    }
    throw err;
  }
}

/** What reading a receipt needs to know about its household. */
export type ReceiptHousehold = Pick<HouseholdInfo, "id" | "timezone" | "currency">;

/**
 * Read a stored receipt photo, extract its lines and prepare them for review.
 * Never changes the kitchen — that only happens when the user confirms.
 */
/**
 * A poor photo is read several times and merged (the readings arrive separated by a form feed). Only the first full
 * reading is kept as the receipt's stored text: it's what a person would see, it keeps the stored text a sensible size,
 * and it leaves it re-readable as one receipt.
 */
function primaryReading(text: string): string {
  return text.split(READING_SEPARATOR).find((part) => part.trim().length > 0) ?? "";
}

export async function processReceipt(userId: string, household: ReceiptHousehold, receiptId: string): Promise<void> {
  const now = new Date();
  // Claim the receipt: only one attempt at a time, and a stalled attempt can be taken over.
  const claimedAt = await withUser(userId, async (tx) => {
    const [claimed] = await tx
      .update(receipts)
      // Millisecond precision so the claim round-trips exactly through a JS Date.
      .set({ processingStartedAt: sql`date_trunc('milliseconds', now())` })
      .where(
        and(
          eq(receipts.id, receiptId),
          eq(receipts.householdId, household.id),
          eq(receipts.status, "processing"),
          or(
            isNull(receipts.processingStartedAt),
            lt(receipts.processingStartedAt, sql`now() - make_interval(secs => ${PROCESSING_LEASE_SECONDS})`),
          ),
        ),
      )
      .returning({ at: receipts.processingStartedAt });
    return claimed?.at ?? null;
  });
  if (!claimedAt) return;
  /** Still ours: processing, and nobody else has claimed it since. */
  const stillOurs = and(
    eq(receipts.id, receiptId),
    eq(receipts.householdId, household.id),
    eq(receipts.status, "processing"),
    eq(receipts.processingStartedAt, claimedAt),
  );

  const fail = async (code: keyof typeof FAILURE_MESSAGES, raw?: string) => {
    await withUser(userId, async (tx) => {
      await tx
        .update(receipts)
        .set({ status: "failed", errorCode: code, errorMessage: FAILURE_MESSAGES[code], rawText: raw ? redactReceiptText(primaryReading(raw)) : null, processedAt: new Date() })
        .where(stillOurs);
    });
  };

  try {
    const { receipt, stores } = await withUser(userId, async (tx) => {
      const [r] = await tx
        .select()
        .from(receipts)
        .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, household.id)))
        .limit(1);
      const [p] = await tx
        .select({ stores: preferences.preferredStores })
        .from(preferences)
        .where(eq(preferences.householdId, household.id))
        .limit(1);
      return { receipt: r, stores: p?.stores ?? [] };
    });
    if (!receipt || receipt.status !== "processing") return;
    const image = receipt.imagePath ? await readStoredFile(receipt.imagePath) : null;
    if (!image) return fail("missing_image");

    const today = toDateString(now, household.timezone);
    const { extraction, fellBack } = await extractWithFallback(household.id, {
      image,
      mimeType: "image/jpeg",
      today,
      currency: household.currency,
      preferredStores: stores,
    });

    // Only the photo check from upload carries over; everything else is worked out afresh on each read.
    const warnings = new Set<string>(receipt.qualityWarnings.filter((w) => w === "blurry"));
    if (fellBack) warnings.add("ai_fallback");
    const total = receiptMoney(extraction.total);
    const subtotal = receiptMoney(extraction.subtotal);
    if (extraction.provider === "local") {
      // The on-device parser reports codes ("total_mismatch", "no_date", …).
      for (const p of extraction.problems) if (p.length < 60) warnings.add(p);
    } else {
      // The AI reader reports free text ("bottom of receipt cut off"): map it to warnings the review can show.
      for (const p of extraction.problems) warnings.add(CUT_OFF_PROBLEM.test(p) ? "partial" : "unclear");
      if (!extraction.legible) warnings.add("unclear");
      const prices = extraction.lines.map((l) => receiptMoney(l.price)).filter((p): p is number => p !== null);
      if (total === null && subtotal === null) warnings.add("partial");
      else if (totalsDisagree(prices, total, subtotal)) warnings.add("total_mismatch");
    }
    // When the AI reader was unavailable, a failed on-device read says nothing about the photo.
    if (!extraction.isReceipt) {
      if (fellBack) return fail("ai_busy", extraction.rawText);
      return fail(extraction.lines.length === 0 && (extraction.rawText?.length ?? 0) < 20 ? "not_a_receipt" : "unreadable", extraction.rawText);
    }
    if (extraction.provider === "local") {
      const size = await sharp(image)
        .metadata()
        .catch(() => null);
      const quality = assessReceiptQuality({
        ocrConfidence: extraction.ocrConfidence,
        text: extraction.rawText,
        // The upload already flagged blur from the full photo.
        blurScore: null,
        // The stored copy keeps the original size up to MAX_STORED_EDGE_PX; unknown sizes aren't flagged.
        width: size?.width || MAX_STORED_EDGE_PX,
        height: size?.height || MAX_STORED_EDGE_PX,
        parsed: {
          store: extraction.store,
          purchasedOn: extraction.purchasedOn,
          total: extraction.total,
          subtotal: extraction.subtotal,
          lines: extraction.lines.map((l) => ({
            raw: l.raw,
            description: l.raw,
            quantity: l.quantity,
            weightKg: l.weightKg,
            unitPrice: l.unitPrice,
            price: l.price,
            discount: null,
          })),
          warnings: extraction.problems,
        },
      });
      for (const w of quality.warnings) warnings.add(w);
      if (!quality.ok && extraction.lines.length === 0) {
        if (fellBack) return fail("ai_busy", extraction.rawText);
        return fail(quality.warnings.includes("not_a_receipt") ? "not_a_receipt" : "unreadable", extraction.rawText);
      }
    }
    if (extraction.lines.length === 0) return fail(fellBack ? "ai_busy" : "empty", extraction.rawText);

    // A scan counts towards the month's allowance once it has been read, never for one that failed.
    let read = false;
    await withUser(userId, async (tx) => {
      // Re-check ownership under a row lock before replacing anything.
      const [owned] = await tx.select({ id: receipts.id }).from(receipts).where(stillOurs).for("update");
      if (!owned) return;
      const index = await loadProductIndex(tx, household.id);
      const lines = normalizeExtraction(extraction, index);
      if (lines.length === 0) {
        const code = fellBack ? "ai_busy" : "empty";
        await tx
          .update(receipts)
          .set({ status: "failed", errorCode: code, errorMessage: FAILURE_MESSAGES[code], processedAt: new Date() })
          .where(eq(receipts.id, receiptId));
        return;
      }
      const purchasedOn = extraction.purchasedOn && isDateString(extraction.purchasedOn) && extraction.purchasedOn <= today ? extraction.purchasedOn : null;
      if (!purchasedOn) warnings.add("no_date");
      const fingerprint = receiptFingerprint({
        store: extraction.store,
        purchasedOn,
        total,
        linePrices: lines.map((l) => l.totalPrice).filter((p): p is number => typeof p === "number"),
      });
      let duplicateOfId: string | null = null;
      if (fingerprint) {
        const [dupe] = await tx
          .select({ id: receipts.id })
          .from(receipts)
          .where(
            and(
              eq(receipts.householdId, household.id),
              eq(receipts.contentFingerprint, fingerprint),
              ne(receipts.id, receiptId),
              notInArray(receipts.status, ["discarded", "failed"]),
            ),
          )
          .limit(1);
        if (dupe) {
          duplicateOfId = dupe.id;
          warnings.add("duplicate");
        }
      }

      await tx.delete(receiptItems).where(eq(receiptItems.receiptId, receiptId));
      await tx.insert(receiptItems).values(
        lines.map((l) => ({
          receiptId,
          householdId: household.id,
          lineIndex: l.lineIndex,
          rawText: l.rawText,
          name: l.name,
          productId: l.product?.id ?? null,
          aisle: (l.product?.aisle ?? "other") as Aisle,
          location: (l.product?.location ?? "pantry") as StorageLocation,
          quantity: l.quantity,
          unit: l.unit,
          packCount: l.packCount,
          unitPrice: l.unitPrice,
          totalPrice: l.totalPrice,
          matchConfidence: Math.max(0, Math.min(1, l.matchConfidence)),
          isFood: l.isFood,
          status: l.ignoredByDefault ? ("ignored" as const) : ("pending" as const),
        })),
      );
      await tx
        .update(receipts)
        .set({
          status: "needs_review",
          storeName: redactStoreLabel(extraction.store)?.slice(0, 80) ?? null,
          purchasedAt: purchasedOn ? zonedDateTimeToInstant(purchasedOn, 12, household.timezone) : null,
          subtotal,
          total,
          currency: extraction.currency ?? household.currency,
          // Card, loyalty and phone numbers, emails, street addresses and names are removed before anything is stored.
          rawText: redactReceiptText(primaryReading(extraction.rawText)).slice(0, 20000),
          provider: extraction.provider,
          contentFingerprint: fingerprint,
          duplicateOfId,
          qualityWarnings: Array.from(warnings),
          errorCode: null,
          errorMessage: null,
          processedAt: new Date(),
        })
        .where(eq(receipts.id, receiptId));
      await tx
        .insert(notifications)
        .values({
          householdId: household.id,
          // The person who uploaded it was promised this, even when someone else's nudge or retry did the reading.
          userId: receipt.uploadedBy ?? userId,
          type: "receipt_ready",
          title: "Your receipt is ready to check",
          body: `${lines.filter((l) => !l.ignoredByDefault).length} items found${redactStoreLabel(extraction.store) ? ` from ${redactStoreLabel(extraction.store)}` : ""}. Give them a quick look before they go in your kitchen.`,
          link: `/receipts/${receiptId}`,
          dedupeKey: `receipt_ready:${receiptId}`,
        })
        .onConflictDoNothing();
      read = true;
    });
    if (read) await addUsage(household.id, USAGE_RECEIPT_SCANS, usagePeriod(household.timezone, now), 1);
  } catch (err) {
    console.error("[receipts] processing failed:", err);
    await fail("ai_failed").catch(() => undefined);
  }
}

export async function retryReceipt(ctx: HouseholdContext, receiptId: string): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    // Locked so a confirm by another member can't slip in between the check and the update.
    const [r] = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, ctx.household.id), isNull(receipts.deletedAt)))
      .for("update")
      .limit(1);
    if (!r) throw notFound("That receipt");
    if (r.status === "confirmed") throw new AppError("conflict", "This receipt has already been added to your kitchen.");
    if (r.status === "discarded") throw notFound("That receipt");
    if (r.status === "processing") return; // Already being read; the claim in processReceipt decides who runs.
    await tx
      .update(receipts)
      .set({ status: "processing", errorCode: null, errorMessage: null, processingStartedAt: null })
      .where(eq(receipts.id, receiptId));
  });
}

// ─── Review ─────────────────────────────────────────────────────────────────

export interface ReceiptReviewItem {
  id: string;
  rawText: string;
  name: string;
  productId: string | null;
  productName: string | null;
  matchConfidence: number;
  certainty: "confident" | "check" | "unknown";
  candidates: Array<{ productId: string; name: string }>;
  quantity: number;
  unit: Unit;
  packCount: number;
  quantityLabel: string;
  location: StorageLocation;
  aisle: Aisle;
  totalPrice: number | null;
  isFood: boolean;
  status: "pending" | "accepted" | "ignored";
  /** Active stock of the same product already in the kitchen. */
  existing: {
    itemIds: string[];
    summary: string;
    suggestion: "replace" | "keep" | "merge";
  } | null;
}

export interface ReceiptReview {
  id: string;
  status: DbReceipt["status"];
  storeName: string | null;
  purchasedOn: string | null;
  total: number | null;
  currency: string | null;
  provider: string | null;
  warnings: string[];
  errorMessage: string | null;
  /** Another receipt with the same contents that's still around (not discarded or failed). */
  duplicateOf: { id: string; date: string | null; status: DbReceipt["status"] } | null;
  items: ReceiptReviewItem[];
  createdAt: string;
  confirmedAt: string | null;
  hasImage: boolean;
  /** The photo was removed under the household's retention choice ("Photo deleted"). */
  imageDeleted: boolean;
  /** When the stored photo will be removed, if that's scheduled. */
  imageDeleteAfter: string | null;
}

function certaintyOf(score: number, hasProduct: boolean): ReceiptReviewItem["certainty"] {
  if (!hasProduct) return "unknown";
  return score >= MATCH_CONFIDENT ? "confident" : "check";
}

export async function getReceiptReview(ctx: HouseholdContext, receiptId: string, now = new Date()): Promise<ReceiptReview | null> {
  return withUser(ctx.user.id, async (tx) => {
    const [r] = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, ctx.household.id), isNull(receipts.deletedAt)))
      .limit(1);
    if (!r) return null;
    const rows = await tx.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId)).orderBy(receiptItems.lineIndex);
    const index = await loadProductIndex(tx, ctx.household.id);
    const live = r.status === "needs_review" ? await computeLiveState(tx, ctx.household, now) : null;
    const purchasedOn = r.purchasedAt ? toDateString(r.purchasedAt, ctx.household.timezone) : null;
    const receiptTime = r.purchasedAt ?? r.createdAt;

    // Worked out now rather than at reading time: the other copy may since have been discarded or confirmed.
    let duplicateOf: ReceiptReview["duplicateOf"] = null;
    if (r.duplicateOfId) {
      const [d] = await tx
        .select({ id: receipts.id, purchasedAt: receipts.purchasedAt, status: receipts.status })
        .from(receipts)
        .where(and(eq(receipts.id, r.duplicateOfId), isNull(receipts.deletedAt), notInArray(receipts.status, ["discarded", "failed"])))
        .limit(1);
      if (d) duplicateOf = { id: d.id, date: d.purchasedAt ? toDateString(d.purchasedAt, ctx.household.timezone) : null, status: d.status };
    }
    const warnings = r.qualityWarnings.filter((w) => w !== "duplicate");
    if (duplicateOf) warnings.unshift(duplicateOf.status === "confirmed" ? "duplicate" : "duplicate_pending");

    const items: ReceiptReviewItem[] = rows.map((row) => {
      const product = row.productId ? index.byId.get(row.productId) ?? null : null;
      const certainty = certaintyOf(row.matchConfidence, Boolean(product));
      const candidates =
        certainty === "confident"
          ? []
          : productCandidates(index, row.rawText, 4)
              .filter((c) => c.product.id !== row.productId)
              .map((c) => ({ productId: c.product.id, name: c.product.name }));

      let existing: ReceiptReviewItem["existing"] = null;
      if (live && row.productId) {
        const batches = live.activeItems.filter((i) => i.productId === row.productId && i.purchasedAt < receiptTime);
        const fromList = listBatchesFor(live.activeItems, row.productId, receiptTime);
        if (fromList.length > 0) {
          existing = {
            itemIds: fromList.map((i) => i.id),
            summary: `Already added from your shopping list`,
            suggestion: "merge",
          };
        } else if (batches.length > 1 && new Set(batches.map((b) => scopeOf(b))).size > 1) {
          // Dad's and Mum's are separate: Plenty won't guess which one this purchase replaces.
          existing = {
            itemIds: batches.map((b) => b.id),
            summary: `You already have ${product?.name.toLowerCase() ?? row.name.toLowerCase()} belonging to more than one person`,
            suggestion: "keep",
          };
        } else if (batches.length > 0) {
          const fractions = batches.map((b) => live.itemFractions.get(b.id) ?? b.remainingFraction);
          const left = Math.max(...fractions);
          const oldest = batches[0];
          const since = formatShortDate(toDateString(oldest.purchasedAt, ctx.household.timezone));
          existing = {
            itemIds: batches.map((b) => b.id),
            summary: `You still have ${product?.name.toLowerCase() ?? row.name.toLowerCase()} from ${since} — probably ${levelPhrase(left)}`,
            suggestion: left <= 0.35 ? "replace" : "keep",
          };
        }
      }
      return {
        id: row.id,
        rawText: row.rawText,
        name: row.name,
        productId: row.productId,
        productName: product?.name ?? null,
        matchConfidence: row.matchConfidence,
        certainty,
        candidates,
        quantity: row.quantity,
        unit: row.unit as Unit,
        packCount: row.packCount,
        quantityLabel: formatPackQuantity(row.quantity, row.unit as Unit, row.packCount),
        location: row.location as StorageLocation,
        aisle: row.aisle as Aisle,
        totalPrice: row.totalPrice,
        isFood: row.isFood,
        status: row.status,
        existing,
      };
    });

    return {
      id: r.id,
      status: r.status,
      storeName: r.storeName,
      purchasedOn,
      total: r.total,
      currency: r.currency,
      provider: r.provider,
      warnings,
      errorMessage: r.errorMessage,
      duplicateOf,
      items,
      createdAt: r.createdAt.toISOString(),
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      hasImage: Boolean(r.imagePath),
      imageDeleted: Boolean(r.imageDeletedAt) || (!r.imagePath && r.status !== "uploaded" && r.status !== "processing"),
      imageDeleteAfter: r.imagePath ? r.imageDeleteAfter?.toISOString() ?? null : null,
    };
  });
}

// ─── Confirm ────────────────────────────────────────────────────────────────

export interface ConfirmItemInput {
  id: string;
  include: boolean;
  name: string;
  productId: string | null;
  quantity: number;
  unit: Unit;
  packCount: number;
  location: StorageLocation;
  existingDecision: "replace" | "keep" | "merge" | null;
  /** Whose it is: a member's id, null for the household, or absent to leave it as the household's. */
  ownerMemberId?: string | null;
  /** `private` keeps it to its owner (a Family-plan feature). */
  visibility?: ItemVisibility;
}

export interface ConfirmReceiptInput {
  storeName: string | null;
  purchasedOn: string | null;
  items: ConfirmItemInput[];
}

/**
 * Put a reviewed receipt into the kitchen. This is where Plenty learns:
 * confirmed names become household aliases, bought-again items close off the
 * previous batch (a consumption observation), and the list is ticked off.
 */
export async function confirmReceipt(
  ctx: HouseholdContext,
  receiptId: string,
  input: ConfirmReceiptInput,
): Promise<{ added: number; tickedOff: number }> {
  const now = new Date();
  const today = toDateString(now, ctx.household.timezone);
  if (input.purchasedOn && (!isDateString(input.purchasedOn) || input.purchasedOn > today)) {
    throw new AppError("validation", "The purchase date can't be in the future.");
  }
  const outcome = await withUser(ctx.user.id, async (tx) => {
    const [r] = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, ctx.household.id), isNull(receipts.deletedAt)))
      .for("update")
      .limit(1);
    if (!r) throw notFound("That receipt");
    if (r.status === "confirmed") throw new AppError("conflict", "This receipt is already in your kitchen.");
    if (r.status !== "needs_review") throw new AppError("conflict", "This receipt isn't ready to confirm yet.");

    const [policyRow] = await tx.select({ retention: preferences.receiptImageRetention }).from(preferences).where(eq(preferences.householdId, ctx.household.id)).limit(1);
    const retention = isRetentionPolicy(policyRow?.retention) ? policyRow.retention : "after_review";
    const rows = await tx.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const index = await loadProductIndex(tx, ctx.household.id);
    const purchasedAt = input.purchasedOn
      ? zonedDateTimeToInstant(input.purchasedOn, 12, ctx.household.timezone)
      : r.purchasedAt ?? now;
    const effectivePurchase = purchasedAt > now ? now : purchasedAt;

    const live = await computeLiveState(tx, ctx.household, now);
    const reviewTime = r.purchasedAt ?? r.createdAt;
    const accepted = input.items.filter((i) => i.include && byId.has(i.id));
    // The kitchen's size on the plan counts here too: a receipt is the quickest way to add a lot at once.
    // Lines that fold into a batch already there, or replace one that's finished, don't make it bigger.
    const adding = accepted.filter((i) => i.existingDecision !== "merge" && i.existingDecision !== "replace").length;
    if (adding > 0) await assertRoomForItemsIn(tx, ctx, adding);
    const touchedProducts: Array<string | null> = [];
    // The receipt is the household's, and other adults can open it. A line someone filed as private keeps only its
    // place on the receipt: no name, product, price or link to the item it became.
    const privateLine = {
      status: "accepted" as const,
      name: PRIVATE_LINE_LABEL,
      rawText: PRIVATE_LINE_LABEL,
      productId: null,
      inventoryItemId: null,
      unitPrice: null,
      totalPrice: null,
      aisle: "other" as const,
      location: "pantry" as const,
      isFood: true,
      matchConfidence: 0,
    };
    /** What actually went into the kitchen, with the products it resolved to — ticked off the list afterwards. */
    const bought: Array<{ productId: string | null; name: string; ownerMemberId?: string | null; private?: boolean }> = [];
    /** Shopping-list batches already taken over by an earlier line of this receipt. */
    const merged = new Set<string>();
    let added = 0;

    for (const decision of input.items) {
      const row = byId.get(decision.id);
      if (!row) continue;
      if (!decision.include) {
        await tx.update(receiptItems).set({ status: "ignored" }).where(eq(receiptItems.id, row.id));
      }
    }

    for (const item of accepted) {
      const row = byId.get(item.id)!;
      if (!(item.quantity > 0) || !isUnit(item.unit)) {
        throw new AppError("validation", `Check the amount for ${item.name}.`);
      }
      const productId = item.productId && index.byId.has(item.productId) ? item.productId : null;
      const owned = resolveOwnership(ctx, item);

      // Merge into a batch already added from the shopping list, instead of duplicating it — only one
      // the review offered for this line (same product, same shop), and each batch only once: a second
      // line of the same product is a second one bought.
      if (item.existingDecision === "merge" && productId && productId === row.productId) {
        const target = listBatchesFor(live.activeItems, productId, reviewTime).find((i) => !merged.has(i.id));
        if (target) {
          merged.add(target.id);
          await tx
            .update(inventoryItems)
            .set({
              quantity: item.quantity,
              unit: item.unit,
              packCount: Math.max(1, item.packCount),
              price: row.totalPrice,
              receiptItemId: row.id,
              source: "receipt",
              confidence: "high",
              purchasedAt: effectivePurchase,
            })
            .where(eq(inventoryItems.id, target.id));
          await tx
            .update(receiptItems)
            .set(target.visibility === "private" ? privateLine : { status: "accepted", productId, inventoryItemId: target.id, name: item.name })
            .where(eq(receiptItems.id, row.id));
          touchedProducts.push(productId);
          bought.push({ productId, name: item.name, ownerMemberId: item.ownerMemberId === undefined ? null : target.ownerMemberId });
          continue;
        }
      }

      // The household told us the previous one is finished. `live` was taken before this
      // confirm started, so it only holds what was in the kitchen at review time.
      // The batches in question are the ones the review showed: the line's original match,
      // bought before this receipt — even if the household then corrected the product.
      const shownProductId = row.productId ?? productId;
      if (item.existingDecision === "replace" && shownProductId) {
        let previous = live.activeItems.filter((i) => i.productId === shownProductId && i.purchasedAt < reviewTime);
        // Assigned to Dad, it replaces Dad's; with no one chosen it only replaces when they all belong together.
        previous =
          item.ownerMemberId === undefined
            ? new Set(previous.map((i) => scopeOf(i))).size > 1
              ? []
              : previous
            : previous.filter((i) => i.ownerMemberId === owned.ownerMemberId);
        const emptyAt = previous[0] ? predictionFor(live, previous[0])?.emptyAt ?? null : null;
        for (const old of previous) {
          const upper = effectivePurchase > old.purchasedAt ? effectivePurchase : now;
          await finishItemTx(tx, ctx.household, ctx.user.id, old, "consumed", {
            endedAt: inferEndTime(old, emptyAt, upper),
            estimatedFraction: live.itemFractions.get(old.id) ?? old.remainingFraction,
            actor: "receipt",
          });
        }
      }

      const [created] = await addItemsTx(
        tx,
        ctx.household,
        ctx.user.id,
        [
          {
            name: item.name,
            productId,
            location: item.location,
            quantity: item.quantity,
            unit: item.unit,
            packCount: item.packCount,
            purchasedAt: effectivePurchase,
            price: row.totalPrice,
            receiptItemId: row.id,
            confidence: row.matchConfidence >= MATCH_CONFIDENT || productId !== row.productId ? "high" : "medium",
            ownerMemberId: owned.ownerMemberId,
            visibility: owned.visibility,
          },
        ],
        "receipt",
        now,
      );
      added += 1;
      touchedProducts.push(created.productId);
      bought.push({
        productId: created.productId,
        name: item.name,
        ownerMemberId: item.ownerMemberId === undefined ? null : owned.ownerMemberId,
        private: owned.visibility === "private",
      });
      await tx
        .update(receiptItems)
        .set(
          owned.visibility === "private"
            ? privateLine
            : {
                status: "accepted",
                productId: created.productId,
                inventoryItemId: created.id,
                name: item.name,
                quantity: item.quantity,
                unit: item.unit,
                location: item.location,
              },
        )
        .where(eq(receiptItems.id, row.id));

      // Learn this household's receipt vocabulary from what a person actually told us: a different
      // product, or a name they typed for the line. An unsure guess left as it was isn't remembered
      // (it would come back as "certain", with no alternatives offered); a confident match is.
      const corrected = productId !== row.productId || item.name.trim().toLowerCase() !== row.name.trim().toLowerCase();
      // A private line leaves nothing behind for the household to learn from or read.
      if (owned.visibility !== "private" && created.productId && (corrected || row.matchConfidence >= MATCH_CONFIDENT)) {
        await rememberAlias(tx, ctx.household.id, toAliasKey(row.rawText), created.productId);
      }
    }

    await tx
      .update(receipts)
      .set({
        status: "confirmed",
        confirmedAt: now,
        confirmedBy: ctx.user.id,
        storeName: redactStoreLabel(input.storeName?.trim())?.slice(0, 80) || r.storeName,
        purchasedAt: effectivePurchase,
        // The household's choice about the photo starts now: removed at once, after 30 days, or kept.
        imageDeleteAfter: r.imagePath ? imageDeleteAfter(retention, now) : r.imageDeleteAfter,
      })
      .where(eq(receipts.id, receiptId));

    // Only list items added by the day of this shop: a later "Bread" is for the next shop.
    const tickedOff = await markPurchasedFromReceipt(tx, ctx.household.id, bought, { purchasedAt: effectivePurchase });
    await refreshLearning(tx, ctx.household, touchedProducts, now);
    await syncShoppingList(tx, ctx.household, now);
    return { added, tickedOff, removePhotoNow: Boolean(r.imagePath) && retention === "after_review" };
  });
  // "Delete once checked": take the photo off the disk now rather than waiting for the scheduled sweep (which would also catch it).
  if (outcome.removePhotoNow) {
    await deleteExpiredReceiptImages(now, { receiptId }).catch((err) => console.error("[receipts] photo removal failed; the scheduled sweep will retry:", err));
  }
  return { added: outcome.added, tickedOff: outcome.tickedOff };
}

const PRIVATE_LINE_LABEL = "Private item";

export async function discardReceipt(ctx: HouseholdContext, receiptId: string): Promise<void> {
  const key = await withUser(ctx.user.id, async (tx) => {
    // Locked so a confirm by another member can't slip in between the check and the update.
    const [r] = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, ctx.household.id)))
      .for("update")
      .limit(1);
    if (!r) throw notFound("That receipt");
    if (r.status === "confirmed") {
      throw new AppError("conflict", "This receipt is already in your kitchen. Remove individual items from your kitchen instead.");
    }
    // A receipt thrown away has no use for its photo, whatever the retention choice: it goes now.
    const now = new Date();
    await tx
      .update(receipts)
      .set({ status: "discarded", deletedAt: now, imagePath: null, imageDeleteAfter: r.imagePath ? now : r.imageDeleteAfter, imageDeletedAt: r.imagePath ? now : r.imageDeletedAt })
      .where(eq(receipts.id, receiptId));
    return r.imagePath;
  });
  if (key) await deleteFile(key);
}

// ─── Listing & files ────────────────────────────────────────────────────────

export interface ReceiptSummary {
  id: string;
  status: DbReceipt["status"];
  storeName: string | null;
  purchasedOn: string | null;
  total: number | null;
  currency: string | null;
  itemCount: number;
  createdAt: string;
  errorMessage: string | null;
}

export async function listReceipts(ctx: HouseholdContext, limit = 50): Promise<ReceiptSummary[]> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        id: receipts.id,
        status: receipts.status,
        storeName: receipts.storeName,
        purchasedAt: receipts.purchasedAt,
        total: receipts.total,
        currency: receipts.currency,
        createdAt: receipts.createdAt,
        errorMessage: receipts.errorMessage,
        itemCount: sql<number>`(select count(*) from ${receiptItems} ri where ri.receipt_id = ${receipts.id} and ri.status <> 'ignored')`,
      })
      .from(receipts)
      .where(and(eq(receipts.householdId, ctx.household.id), isNull(receipts.deletedAt), ne(receipts.status, "discarded")))
      .orderBy(desc(receipts.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      storeName: r.storeName,
      purchasedOn: r.purchasedAt ? toDateString(r.purchasedAt, ctx.household.timezone) : null,
      total: r.total,
      currency: r.currency,
      itemCount: Number(r.itemCount),
      createdAt: r.createdAt.toISOString(),
      errorMessage: r.errorMessage,
    }));
  });
}

export async function getReceiptStatus(ctx: HouseholdContext, receiptId: string) {
  return withUser(ctx.user.id, async (tx) => {
    const [r] = await tx
      .select({ status: receipts.status, errorMessage: receipts.errorMessage })
      .from(receipts)
      .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, ctx.household.id)))
      .limit(1);
    return r ?? null;
  });
}

/** Receipt photo bytes, only for members of the household that owns it. */
export async function getReceiptImage(ctx: HouseholdContext, receiptId: string): Promise<Buffer | null> {
  const key = await withUser(ctx.user.id, async (tx) => {
    const [r] = await tx
      .select({ imagePath: receipts.imagePath })
      .from(receipts)
      .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, ctx.household.id)))
      .limit(1);
    return r?.imagePath ?? null;
  });
  return key ? readStoredFile(key) : null;
}

/** A "processing" receipt whose reading attempt has lapsed (or never started) by `lapsed`. */
function stalledBy(lapsed: Date) {
  return or(
    and(isNull(receipts.processingStartedAt), lt(receipts.updatedAt, lapsed)),
    lt(receipts.processingStartedAt, lapsed),
  );
}

/**
 * Scheduled job: pick up receipts whose reading was interrupted (e.g. a server
 * restart or redeploy while `after()` was reading) and that nobody reopened.
 * Recent ones are read again — the claim in `processReceipt` stops double runs —
 * and old ones are marked failed, so the household gets "Try reading it again"
 * instead of "Reading…" forever. Finds them across households with the system
 * connection; each receipt is then handled as a member of its own household.
 */
export async function resumeStalledReceipts(now = new Date(), limit = 5): Promise<{ restarted: number; failed: number }> {
  const lapsed = new Date(now.getTime() - PROCESSING_LEASE_SECONDS * 1000);
  const tooOld = new Date(now.getTime() - MAX_PROCESSING_AGE_MS);
  const stalled = await systemDb
    .select({
      id: receipts.id,
      createdAt: receipts.createdAt,
      household: {
        id: households.id,
        name: households.name,
        adults: households.adults,
        children: households.children,
        currency: households.currency,
        timezone: households.timezone,
        onboardedAt: households.onboardedAt,
        isDemo: households.isDemo,
      },
      // The uploader while they're still a member, otherwise the longest-standing member.
      memberId: sql<string | null>`(
        select ${householdMembers.userId} from ${householdMembers}
        where ${householdMembers.householdId} = ${receipts.householdId}
        order by (${householdMembers.userId} = ${receipts.uploadedBy}) desc nulls last, ${householdMembers.joinedAt}
        limit 1
      )`,
    })
    .from(receipts)
    .innerJoin(households, eq(households.id, receipts.householdId))
    .where(and(eq(receipts.status, "processing"), isNull(receipts.deletedAt), isNull(households.deletedAt), stalledBy(lapsed)))
    .orderBy(receipts.createdAt)
    .limit(limit);

  let failed = 0;
  const restarts: Array<Promise<void>> = [];
  for (const r of stalled) {
    if (!r.memberId) continue;
    if (r.createdAt < tooOld) {
      const gaveUp = await withUser(r.memberId, (tx) =>
        tx
          .update(receipts)
          .set({ status: "failed", errorCode: "interrupted", errorMessage: FAILURE_MESSAGES.interrupted, processedAt: now })
          .where(and(eq(receipts.id, r.id), eq(receipts.status, "processing"), stalledBy(lapsed)))
          .returning({ id: receipts.id }),
      );
      failed += gaveUp.length;
    } else {
      restarts.push(processReceipt(r.memberId, r.household, r.id));
    }
  }
  const results = await Promise.allSettled(restarts);
  for (const r of results) if (r.status === "rejected") console.error("[receipts] restarting a stalled receipt failed:", r.reason);
  return { restarted: results.filter((r) => r.status === "fulfilled").length, failed };
}

/** How far back the free plan shows receipts. The receipts themselves are kept. */
export const FREE_HISTORY_DAYS = 30;

/**
 * What the Receipts list shows: all of it on plans with purchase history, otherwise the last month plus anything
 * still being read or checked. Nothing is deleted or hidden from the household; older receipts simply aren't listed.
 */
export function visibleReceiptHistory(ctx: HouseholdContext, all: ReceiptSummary[], now = new Date()): ReceiptSummary[] {
  if (ctx.plan.entitlements.purchase_history) return all;
  const cutoff = now.getTime() - FREE_HISTORY_DAYS * 24 * 3600_000;
  return all.filter((r) => new Date(r.createdAt).getTime() >= cutoff || r.status === "needs_review" || r.status === "processing" || r.status === "uploaded");
}
