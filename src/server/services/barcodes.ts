import "server-only";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { barcodeMessage, parseBarcode, type Barcode, type BarcodeFormatHint } from "@/lib/barcode";
import type { ProductInfo } from "@/lib/catalog/types";
import { sentenceCase } from "@/lib/normalize";
import type { BarcodeProposal, ScannedItemInput, ScannedItemResult } from "@/lib/scan/types";
import { formatQuantity } from "@/lib/units";
import type { HouseholdContext } from "@/server/auth/context";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { requireEntitlement } from "@/server/billing/limits";
import { systemDb, withUser } from "@/server/db/client";
import { inventoryItems, productBarcodes } from "@/server/db/schema";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { fetchOffProduct, parseSizeText, type OffFetchOptions, type OffLookup, type OffProduct } from "@/server/barcodes/open-food-facts";
import { addItems } from "./inventory";
import { loadProductIndex, resolveProduct, type ProductIndex } from "./products";

/**
 * Barcode scanning, server side.
 *
 * Looking a barcode up only ever produces a *proposal*. Nothing is written to
 * the kitchen until the person confirms the name, amount, place and whose it
 * is (`addScannedItem`), and only then is the barcode remembered for the
 * household so the next scan is instant.
 *
 * Where a barcode's name comes from, in order:
 *   1. this household's own memory of it (what someone confirmed or corrected),
 *   2. Plenty's shared cache of earlier public lookups (public data only),
 *   3. Open Food Facts, if `BARCODE_LOOKUP` allows — only the barcode digits go,
 *   4. nothing: the person names it.
 */

const FEATURE = "Barcode scanning";
/** How long a public lookup is trusted before it's asked again. */
export const POSITIVE_CACHE_DAYS = 30;
export const NEGATIVE_CACHE_DAYS = 3;
const CACHE_SOURCE = "openfoodfacts";
const CACHE_MISS_SOURCE = "openfoodfacts:none";
const HOUSEHOLD_SOURCE = "household";
/** At most this many barcode lookups per person in ten minutes. */
export const LOOKUPS_PER_WINDOW = 120;
const LOOKUP_WINDOW_SECONDS = 600;

export type BarcodeLookupMode = "off" | "openfoodfacts";

export function barcodeLookupMode(): BarcodeLookupMode {
  const e = env();
  return e.BARCODE_LOOKUP ?? (e.NODE_ENV === "test" ? "off" : "openfoodfacts");
}

/** Test seams: the network, the clock and the setting. */
export interface BarcodeDeps {
  fetch?: OffFetchOptions["fetch"];
  now?: Date;
  mode?: BarcodeLookupMode;
}

const UNAVAILABLE_NOTICE = "Couldn't look that up right now. Name it and Plenty will remember it.";
const UNKNOWN_NOTICE = "Plenty doesn't know this one yet. Name it and Plenty will remember it.";

/** Confidence in a match to the catalogue. Below `LIKELY` the name becomes a new product instead. */
const CONFIDENT = 0.88;
const LIKELY = 0.75;

function packLabel(product: ProductInfo | null): string | null {
  return product ? `Usual pack: ${formatQuantity(product.packageQuantity, product.unit)}` : null;
}

interface Suggested {
  name: string;
  brand: string | null;
  sizeText: string | null;
}

/** The catalogue (or household) product a public name most likely means, with how sure that is. */
function matchCatalogue(index: ProductIndex, suggested: Suggested): { product: ProductInfo; match: "confident" | "likely" } | null {
  for (const text of [suggested.name, suggested.brand ? `${suggested.brand} ${suggested.name}` : null]) {
    if (!text) continue;
    const found = resolveProduct(index, text, LIKELY);
    if (found) return { product: found.product, match: found.score >= CONFIDENT ? "confident" : "likely" };
  }
  return null;
}

/** A name for something that isn't in the catalogue: the brand, unless the name already has it. */
function displayName(p: OffProduct): string {
  const brand = p.brand;
  const withBrand = brand && !p.name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${p.name}` : p.name;
  // Keep brand capitalisation ("Pauls"); only tame labels shouted in capitals.
  const tidy = withBrand === withBrand.toUpperCase() ? sentenceCase(withBrand) : withBrand;
  return tidy.slice(0, 80);
}

function baseProposal(barcode: Barcode): BarcodeProposal {
  return {
    barcode: barcode.gtin,
    barcodeDisplay: barcode.display,
    packaging: barcode.packaging,
    status: "unknown",
    source: null,
    name: "",
    brand: null,
    sizeText: null,
    size: null,
    productId: null,
    productName: null,
    match: "none",
    packLabel: null,
    location: "pantry",
    notice: null,
  };
}

function withMatch(base: BarcodeProposal, suggested: Suggested, index: ProductIndex): BarcodeProposal {
  const matched = matchCatalogue(index, suggested);
  const size = parseSizeText(suggested.sizeText);
  if (!matched) return { ...base, ...suggested, size, match: "none" };
  return {
    ...base,
    ...suggested,
    size,
    productId: matched.product.id,
    productName: matched.product.name,
    match: matched.match,
    packLabel: packLabel(matched.product),
    location: matched.product.location,
  };
}

const fresh = (at: Date, days: number, now: Date) => now.getTime() - at.getTime() < days * 86_400_000;

/** What Plenty already knows about this barcode, for this household (RLS shows only its own rows and the shared cache). */
async function knownRows(ctx: HouseholdContext, gtin: string) {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select()
      .from(productBarcodes)
      .where(and(eq(productBarcodes.barcode, gtin), or(eq(productBarcodes.householdId, ctx.household.id), isNull(productBarcodes.householdId))));
    return { rows, index: await loadProductIndex(tx, ctx.household.id) };
  });
}

async function saveSharedLookup(gtin: string, lookup: OffLookup, now: Date): Promise<void> {
  if (lookup.kind === "unavailable") return;
  const found = lookup.kind === "found" ? lookup.product : null;
  const values = {
    barcode: gtin,
    householdId: null,
    productId: null,
    name: found?.name ?? "",
    brand: found?.brand ?? null,
    sizeText: found?.sizeText ?? null,
    source: found ? CACHE_SOURCE : CACHE_MISS_SOURCE,
    fetchedAt: now,
  };
  try {
    // The shared cache holds public product data only, never anything about a household.
    await systemDb
      .insert(productBarcodes)
      .values(values)
      .onConflictDoUpdate({
        target: productBarcodes.barcode,
        targetWhere: sql`${productBarcodes.householdId} is null`,
        set: { name: values.name, brand: values.brand, sizeText: values.sizeText, source: values.source, fetchedAt: now },
      });
  } catch (err) {
    console.warn("[barcodes] couldn't cache a lookup:", err instanceof Error ? err.message : err);
  }
}

/**
 * Work out what a (valid) barcode probably is. Never changes the kitchen.
 * Callers have already checked the plan; see `lookupBarcode`.
 */
export async function proposeForBarcode(ctx: HouseholdContext, barcode: Barcode, deps: BarcodeDeps = {}): Promise<BarcodeProposal> {
  const now = deps.now ?? new Date();
  const base = baseProposal(barcode);
  const { rows, index } = await knownRows(ctx, barcode.gtin);

  const mine = rows.find((r) => r.householdId === ctx.household.id);
  if (mine) {
    const suggested = { name: mine.name, brand: mine.brand, sizeText: mine.sizeText };
    const product = mine.productId ? (index.byId.get(mine.productId) ?? null) : null;
    if (product) {
      return {
        ...base,
        ...suggested,
        status: "remembered",
        source: "household",
        productId: product.id,
        productName: product.name,
        match: "confident",
        packLabel: packLabel(product),
        location: product.location,
      };
    }
    // The product it pointed at is gone: keep the name, find the product again from it.
    return { ...withMatch(base, suggested, index), status: "remembered", source: "household" };
  }

  const cached = rows.find((r) => r.householdId === null);
  if (cached && fresh(cached.fetchedAt, cached.source === CACHE_SOURCE ? POSITIVE_CACHE_DAYS : NEGATIVE_CACHE_DAYS, now)) {
    if (cached.source === CACHE_SOURCE && cached.name) {
      return { ...withMatch(base, { name: cached.name, brand: cached.brand, sizeText: cached.sizeText }, index), status: "found", source: "openfoodfacts" };
    }
    return { ...base, status: "unknown", notice: UNKNOWN_NOTICE };
  }

  if ((deps.mode ?? barcodeLookupMode()) === "off") return { ...base, status: "unavailable", notice: UNAVAILABLE_NOTICE };

  const lookup = await fetchOffProduct(barcode.gtin, { fetch: deps.fetch });
  await saveSharedLookup(barcode.gtin, lookup, now);
  if (lookup.kind === "unavailable") return { ...base, status: "unavailable", notice: UNAVAILABLE_NOTICE };
  if (lookup.kind === "not_found") return { ...base, status: "unknown", notice: UNKNOWN_NOTICE };
  const product = lookup.product;
  const suggested = { name: product.name, brand: product.brand, sizeText: product.sizeText };
  const proposal = withMatch(base, suggested, index);
  // Not in the catalogue: offer the public name, with the brand, as a new product.
  return { ...proposal, name: proposal.match === "none" ? displayName(product) : proposal.name, status: "found", source: "openfoodfacts" };
}

/**
 * The scan screen's lookup: checks the plan, validates the number, limits how
 * often one person can ask, then proposes. `format` is what the scanner said
 * it saw, if anything.
 */
export async function lookupBarcode(ctx: HouseholdContext, raw: unknown, format?: BarcodeFormatHint, deps: BarcodeDeps = {}): Promise<BarcodeProposal> {
  requireEntitlement(ctx, "barcode_scanning", FEATURE);
  const parsed = parseBarcode(raw, format);
  if (!parsed.ok) throw new AppError("validation", parsed.message);
  await enforceRateLimit(`barcode-lookup:${ctx.user.id}`, LOOKUPS_PER_WINDOW, LOOKUP_WINDOW_SECONDS, "scanning barcodes");
  return proposeForBarcode(ctx, parsed.barcode, deps);
}

/** Remember (or replace) what this barcode is for the household. A correction overwrites the earlier answer. */
async function rememberBarcode(
  ctx: HouseholdContext,
  input: { gtin: string; name: string; productId: string | null; brand: string | null; sizeText: string | null },
): Promise<boolean> {
  try {
    await withUser(ctx.user.id, async (tx) => {
      await tx
        .insert(productBarcodes)
        .values({
          barcode: input.gtin,
          householdId: ctx.household.id,
          productId: input.productId,
          name: input.name,
          brand: input.brand,
          sizeText: input.sizeText,
          source: HOUSEHOLD_SOURCE,
        })
        .onConflictDoUpdate({
          target: [productBarcodes.householdId, productBarcodes.barcode],
          targetWhere: sql`${productBarcodes.householdId} is not null`,
          set: { productId: input.productId, name: input.name, brand: input.brand, sizeText: input.sizeText, source: HOUSEHOLD_SOURCE, fetchedAt: sql`now()` },
        });
    });
    return true;
  } catch (err) {
    console.warn("[barcodes] couldn't remember a barcode:", err instanceof Error ? err.message : err);
    return false;
  }
}

const clean = (text: string | null | undefined, max: number) => text?.replace(/[\p{Cc}\p{Cf}<>]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max) || null;

/**
 * Add what the person confirmed after scanning, then remember the barcode.
 * Everything is checked again here: the plan, the number, the room left in the
 * kitchen and whose it may be (a child can only add their own).
 */
export async function addScannedItem(ctx: HouseholdContext, input: ScannedItemInput): Promise<ScannedItemResult> {
  requireEntitlement(ctx, "barcode_scanning", FEATURE);
  const parsed = parseBarcode(input.barcode);
  if (!parsed.ok) throw new AppError("validation", barcodeMessage(parsed.reason));
  const name = clean(input.name, 120);
  if (!name) throw new AppError("validation", "What is it? Give it a name first.");
  const packs = Math.min(100, Math.max(1, Math.round(input.packCount || 1)));
  const sizeKnown = input.quantity && input.unit && !input.productId ? input.quantity * packs : null;

  const [itemId] = await addItems(
    ctx,
    [
      {
        name,
        productId: input.productId,
        location: input.location,
        packCount: packs,
        ...(sizeKnown ? { quantity: sizeKnown, unit: input.unit } : {}),
        ownerMemberId: input.ownerMemberId ?? null,
        visibility: input.visibility,
        confidence: "high",
      },
    ],
    "barcode",
  );

  // Children can add their own things but not change what the household knows (the database agrees).
  let remembered = false;
  if (input.remember !== false && ctx.role !== "child") {
    const productId = await withUser(ctx.user.id, async (tx) => {
      const [row] = await tx.select({ productId: inventoryItems.productId }).from(inventoryItems).where(eq(inventoryItems.id, itemId)).limit(1);
      return row?.productId ?? null;
    });
    remembered = await rememberBarcode(ctx, {
      gtin: parsed.barcode.gtin,
      name,
      productId,
      brand: clean(input.brand, 40),
      sizeText: clean(input.sizeText, 30),
    });
  }
  return { itemId, remembered };
}
