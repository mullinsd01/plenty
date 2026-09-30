import "server-only";
import { and, desc, eq, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { ProductInfo } from "@/lib/catalog/types";
import { formatShortDate, isDateString, toDateString, zonedDateTimeToInstant } from "@/lib/dates";
import { levelPhrase, type Aisle, type StorageLocation } from "@/lib/domain";
import { aliasKey as toAliasKey, normalizeReceiptLine } from "@/lib/normalize";
import { receiptFingerprint } from "@/lib/receipts/fingerprint";
import { assessReceiptQuality } from "@/lib/receipts/quality";
import { formatQuantity, isUnit, type Unit } from "@/lib/units";
import { AIUnavailableError, getLocalProvider, getProvider, type ReceiptExtraction } from "@/server/ai";
import type { HouseholdContext, HouseholdInfo } from "@/server/auth/context";
import { withUser, type Tx } from "@/server/db/client";
import { notifications, preferences, receiptItems, receipts, inventoryItems, type DbReceipt } from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { deleteFile, readStoredFile, receiptImageKey, saveFile } from "@/server/storage/files";
import { prepareReceiptImage, ReceiptImageError } from "@/server/receipts/image";
import { addItemsTx, finishItemTx, inferEndTime } from "./inventory";
import { computeLiveState, refreshLearning } from "./learning";
import { loadProductIndex, matchOptions, productCandidates, rememberAlias, type ProductIndex } from "./products";
import { markPurchasedFromReceipt, syncShoppingList } from "./shopping";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
/**
 * A processing attempt "owns" a receipt for this long. Another attempt (a
 * retry, or a nudge after a server restart) can only take over once it lapses,
 * so two readers never race to write the same receipt.
 */
const PROCESSING_LEASE_SECONDS = 150;
const MATCH_CONFIDENT = 0.8;
const MATCH_PLAUSIBLE = 0.55;

// ─── Upload ─────────────────────────────────────────────────────────────────

export interface UploadResult {
  receiptId: string;
  duplicateOf: { id: string; date: string | null } | null;
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
        .select({ id: receipts.id, purchasedAt: receipts.purchasedAt })
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
          duplicateOf: { id: dupe.id, date: dupe.purchasedAt ? toDateString(dupe.purchasedAt, ctx.household.timezone) : null },
        };
      }
    }
    const [row] = await tx
      .insert(receipts)
      .values({ householdId: ctx.household.id, uploadedBy: ctx.user.id, status: "processing", imageHash: prepared.sha256 })
      .returning({ id: receipts.id });
    const key = receiptImageKey(ctx.household.id, row.id);
    await saveFile(key, prepared.buffer);
    await tx
      .update(receipts)
      .set({ imagePath: key, processingStartedAt: null, qualityWarnings: prepared.blurScore < 60 ? ["blurry"] : [] })
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
    const raw = line.raw.trim();
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
    if (line.weightKg && line.weightKg > 0) {
      quantity = Math.round(line.weightKg * 1000) / 1000;
      unit = "kg";
      packCount = 1;
    } else if (line.quantity && line.quantity > 1 && Number.isInteger(line.quantity)) {
      packCount = line.quantity * Math.max(1, packCount);
      quantity = best.quantity * line.quantity;
    }
    const name =
      product && (match?.score ?? 0) >= 0.75 ? product.name : line.name?.trim() || best.name || raw;
    const nonGrocery = !line.isGrocery || (!best.isFood && !product);
    out.push({
      lineIndex: i,
      rawText: raw.slice(0, 200),
      name: name.slice(0, 120),
      product,
      matchConfidence: match?.score ?? 0,
      quantity: quantity > 0 ? quantity : 1,
      unit: isUnit(unit) ? unit : "each",
      packCount: Math.max(1, packCount),
      unitPrice: line.unitPrice,
      totalPrice: line.price,
      isFood: !nonGrocery,
      aliasKey: best.aliasKey || toAliasKey(raw),
      ignoredByDefault: nonGrocery,
    });
  });
  return out;
}

async function extractWithFallback(
  allowAi: boolean,
  input: Parameters<ReturnType<typeof getProvider>["extractReceipt"]>[0],
): Promise<{ extraction: ReceiptExtraction; fellBack: boolean }> {
  const provider = getProvider(allowAi);
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

/**
 * Read a stored receipt photo, extract its lines and prepare them for review.
 * Never changes the kitchen — that only happens when the user confirms.
 */
export async function processReceipt(userId: string, household: HouseholdInfo, receiptId: string): Promise<void> {
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
        .set({ status: "failed", errorCode: code, errorMessage: FAILURE_MESSAGES[code], rawText: raw ?? null, processedAt: new Date() })
        .where(stillOurs);
    });
  };

  try {
    const { receipt, allowAi, stores } = await withUser(userId, async (tx) => {
      const [r] = await tx
        .select()
        .from(receipts)
        .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, household.id)))
        .limit(1);
      const [p] = await tx
        .select({ allowAi: preferences.allowAiProcessing, stores: preferences.preferredStores })
        .from(preferences)
        .where(eq(preferences.householdId, household.id))
        .limit(1);
      return { receipt: r, allowAi: p?.allowAi ?? true, stores: p?.stores ?? [] };
    });
    if (!receipt || receipt.status !== "processing") return;
    const image = receipt.imagePath ? await readStoredFile(receipt.imagePath) : null;
    if (!image) return fail("missing_image");

    const today = toDateString(now, household.timezone);
    const { extraction, fellBack } = await extractWithFallback(allowAi, {
      image,
      mimeType: "image/jpeg",
      today,
      currency: household.currency,
      preferredStores: stores,
    });

    const warnings = new Set<string>(receipt.qualityWarnings);
    if (fellBack) warnings.add("ai_fallback");
    for (const p of extraction.problems) if (p.length < 60) warnings.add(p);
    if (!extraction.isReceipt) return fail(extraction.lines.length === 0 && (extraction.rawText?.length ?? 0) < 20 ? "not_a_receipt" : "unreadable", extraction.rawText);
    if (extraction.provider === "local") {
      const quality = assessReceiptQuality({
        ocrConfidence: extraction.ocrConfidence,
        text: extraction.rawText,
        blurScore: null,
        width: 1000,
        height: 1000,
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
        return fail(quality.warnings.includes("not_a_receipt") ? "not_a_receipt" : "unreadable", extraction.rawText);
      }
    }
    if (extraction.lines.length === 0) return fail("empty", extraction.rawText);

    await withUser(userId, async (tx) => {
      // Re-check ownership under a row lock before replacing anything.
      const [owned] = await tx.select({ id: receipts.id }).from(receipts).where(stillOurs).for("update");
      if (!owned) return;
      const index = await loadProductIndex(tx, household.id);
      const lines = normalizeExtraction(extraction, index);
      if (lines.length === 0) {
        await tx
          .update(receipts)
          .set({ status: "failed", errorCode: "empty", errorMessage: FAILURE_MESSAGES.empty, processedAt: new Date() })
          .where(eq(receipts.id, receiptId));
        return;
      }
      const purchasedOn = extraction.purchasedOn && isDateString(extraction.purchasedOn) && extraction.purchasedOn <= today ? extraction.purchasedOn : null;
      if (!purchasedOn) warnings.add("no_date");
      const fingerprint = receiptFingerprint({
        store: extraction.store,
        purchasedOn,
        total: extraction.total,
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
          storeName: extraction.store?.slice(0, 80) ?? null,
          purchasedAt: purchasedOn ? zonedDateTimeToInstant(purchasedOn, 12, household.timezone) : null,
          subtotal: extraction.subtotal,
          total: extraction.total,
          currency: extraction.currency ?? household.currency,
          rawText: extraction.rawText.slice(0, 20000),
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
          userId,
          type: "receipt_ready",
          title: "Your receipt is ready to check",
          body: `${lines.filter((l) => !l.ignoredByDefault).length} items found${extraction.store ? ` from ${extraction.store}` : ""}. Give them a quick look before they go in your kitchen.`,
          link: `/receipts/${receiptId}`,
          dedupeKey: `receipt_ready:${receiptId}`,
        })
        .onConflictDoNothing();
    });
  } catch (err) {
    console.error("[receipts] processing failed:", err);
    await fail("ai_failed").catch(() => undefined);
  }
}

export async function retryReceipt(ctx: HouseholdContext, receiptId: string): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    const [r] = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, ctx.household.id)))
      .limit(1);
    if (!r) throw notFound("That receipt");
    if (r.status === "confirmed") throw new AppError("conflict", "This receipt has already been added to your kitchen.");
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
  duplicateOf: { id: string; date: string | null } | null;
  items: ReceiptReviewItem[];
  createdAt: string;
  confirmedAt: string | null;
  hasImage: boolean;
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

    let duplicateOf: ReceiptReview["duplicateOf"] = null;
    if (r.duplicateOfId) {
      const [d] = await tx.select({ id: receipts.id, purchasedAt: receipts.purchasedAt }).from(receipts).where(eq(receipts.id, r.duplicateOfId)).limit(1);
      if (d) duplicateOf = { id: d.id, date: d.purchasedAt ? toDateString(d.purchasedAt, ctx.household.timezone) : null };
    }

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
        const fromList = live.activeItems.filter(
          (i) =>
            i.productId === row.productId &&
            i.source === "shopping_list" &&
            Math.abs(i.purchasedAt.getTime() - receiptTime.getTime()) < 3 * 86_400_000,
        );
        if (fromList.length > 0) {
          existing = {
            itemIds: fromList.map((i) => i.id),
            summary: `Already added from your shopping list`,
            suggestion: "merge",
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
        quantityLabel:
          row.packCount > 1
            ? `${row.packCount} × ${formatQuantity(row.quantity / row.packCount, row.unit as Unit)}`
            : formatQuantity(row.quantity, row.unit as Unit),
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
      warnings: r.qualityWarnings,
      errorMessage: r.errorMessage,
      duplicateOf,
      items,
      createdAt: r.createdAt.toISOString(),
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      hasImage: Boolean(r.imagePath),
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
  return withUser(ctx.user.id, async (tx) => {
    const [r] = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, ctx.household.id), isNull(receipts.deletedAt)))
      .for("update")
      .limit(1);
    if (!r) throw notFound("That receipt");
    if (r.status === "confirmed") throw new AppError("conflict", "This receipt is already in your kitchen.");
    if (r.status !== "needs_review") throw new AppError("conflict", "This receipt isn't ready to confirm yet.");

    const rows = await tx.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const index = await loadProductIndex(tx, ctx.household.id);
    const purchasedAt = input.purchasedOn
      ? zonedDateTimeToInstant(input.purchasedOn, 12, ctx.household.timezone)
      : r.purchasedAt ?? now;
    const effectivePurchase = purchasedAt > now ? now : purchasedAt;

    const live = await computeLiveState(tx, ctx.household, now);
    const accepted = input.items.filter((i) => i.include && byId.has(i.id));
    const touchedProducts: Array<string | null> = [];
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

      // Merge into a batch already added from the shopping list, instead of duplicating it.
      if (item.existingDecision === "merge" && productId) {
        const target = live.activeItems.find((i) => i.productId === productId && i.source === "shopping_list");
        if (target) {
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
          await tx.update(receiptItems).set({ status: "accepted", productId, inventoryItemId: target.id, name: item.name }).where(eq(receiptItems.id, row.id));
          touchedProducts.push(productId);
          continue;
        }
      }

      // Bought it again: the previous batch was most likely finished.
      if (item.existingDecision === "replace" && productId) {
        const previous = live.activeItems.filter((i) => i.productId === productId && i.purchasedAt < effectivePurchase);
        const prediction = live.predictions.get(productId)?.prediction ?? null;
        for (const old of previous) {
          await finishItemTx(tx, ctx.household, ctx.user.id, old, "consumed", {
            endedAt: inferEndTime(old, prediction?.runOutAt ?? null, effectivePurchase),
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
          },
        ],
        "receipt",
        now,
      );
      added += 1;
      touchedProducts.push(created.productId);
      await tx
        .update(receiptItems)
        .set({
          status: "accepted",
          productId: created.productId,
          inventoryItemId: created.id,
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
          location: item.location,
        })
        .where(eq(receiptItems.id, row.id));

      // Learn this household's receipt vocabulary when a person confirmed or corrected the match.
      const corrected = productId !== row.productId;
      if (created.productId && (corrected || row.matchConfidence >= MATCH_PLAUSIBLE)) {
        await rememberAlias(tx, ctx.household.id, toAliasKey(row.rawText), created.productId);
      }
    }

    await tx
      .update(receipts)
      .set({
        status: "confirmed",
        confirmedAt: now,
        confirmedBy: ctx.user.id,
        storeName: input.storeName?.trim().slice(0, 80) || r.storeName,
        purchasedAt: effectivePurchase,
      })
      .where(eq(receipts.id, receiptId));

    const tickedOff = await markPurchasedFromReceipt(
      tx,
      ctx.household.id,
      accepted.map((a) => ({ productId: a.productId, name: a.name })),
    );
    await refreshLearning(tx, ctx.household, touchedProducts, now);
    await syncShoppingList(tx, ctx.household, now);
    return { added, tickedOff };
  });
}

export async function discardReceipt(ctx: HouseholdContext, receiptId: string): Promise<void> {
  const key = await withUser(ctx.user.id, async (tx) => {
    const [r] = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, ctx.household.id)))
      .limit(1);
    if (!r) throw notFound("That receipt");
    if (r.status === "confirmed") {
      throw new AppError("conflict", "This receipt is already in your kitchen. Remove individual items from your kitchen instead.");
    }
    await tx.update(receipts).set({ status: "discarded", deletedAt: new Date(), imagePath: null }).where(eq(receipts.id, receiptId));
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

/** Receipts still waiting in "processing" (e.g. after a server restart) — requeue them. */
export async function pendingReceiptIds(tx: Tx, householdId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.householdId, householdId), inArray(receipts.status, ["processing", "uploaded"])));
  return rows.map((r) => r.id);
}
