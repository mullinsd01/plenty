import type { StorageLocation } from "@/lib/domain";
import type { Unit } from "@/lib/units";

/**
 * What the scanning screens send and receive. Plain data, safe for the browser.
 * A proposal is only ever a suggestion: nothing reaches the kitchen until the
 * person confirms it.
 */

// ─── Barcodes ───────────────────────────────────────────────────────────────

export interface BarcodeProposal {
  /** The normalised barcode number (see `parseBarcode`). */
  barcode: string;
  /** The number with spaces, for reading back to the person. */
  barcodeDisplay: string;
  /** A case or multipack code rather than a single item. */
  packaging: boolean;
  /**
   * - remembered: this household has told Plenty what it is before
   * - found: a public product database knows it (a suggestion, not a fact)
   * - unknown: nobody Plenty can ask knows it yet
   * - unavailable: the lookup couldn't be done right now (offline, blocked, or switched off)
   */
  status: "remembered" | "found" | "unknown" | "unavailable";
  /** Where the suggested name came from, shown so it is never mistaken for something Plenty knows itself. */
  source: "household" | "openfoodfacts" | null;
  /** The suggested name. Empty when Plenty has nothing to suggest. */
  name: string;
  brand: string | null;
  /** The pack size as printed ("500 g"). */
  sizeText: string | null;
  /** The catalogue (or the household's own) product this matched, when it did. */
  productId: string | null;
  productName: string | null;
  /** How sure the match to the catalogue is. `none`: the name will become a new product. */
  match: "confident" | "likely" | "none";
  /** The amount printed on the pack as a number and unit, when it is a plain weight or volume. Used for products not in the catalogue. */
  size: { quantity: number; unit: Unit } | null;
  /** "Usual pack: 2 L" when the product is in the catalogue. */
  packLabel: string | null;
  /** Where Plenty would put it, as a default to change. */
  location: StorageLocation;
  /** An explanation when there's no name to suggest. */
  notice: string | null;
}

/** What the person confirmed for a scanned barcode. */
export interface ScannedItemInput {
  barcode: string;
  name: string;
  /** Kept only when the name wasn't changed from the suggestion. */
  productId: string | null;
  packCount: number;
  location: StorageLocation;
  brand?: string | null;
  sizeText?: string | null;
  /** The amount printed on the pack, for an item that isn't in the catalogue. */
  quantity?: number | null;
  unit?: Unit | null;
  ownerMemberId?: string | null;
  visibility?: "household" | "private";
  /** Remember this barcode for the household (the default). */
  remember?: boolean;
}

export interface ScannedItemResult {
  itemId: string;
  /** The barcode was saved, so the next scan is instant. False for people who can't save for the household. */
  remembered: boolean;
}

// ─── Photos ─────────────────────────────────────────────────────────────────

export type GuessConfidence = "high" | "medium" | "low";

export interface PhotoGuess {
  /** Stable within one result, for the review list. */
  id: string;
  /** What Plenty thinks it can see, cleaned up. */
  name: string;
  /** A rough count of what's visible. Never a weight. */
  quantity: number;
  /** False when Plenty couldn't tell how many (it shows 1). */
  quantityKnown: boolean;
  confidence: GuessConfidence;
  productId: string | null;
  productName: string | null;
  packLabel: string | null;
  location: StorageLocation;
}

export interface PhotoProposal {
  guesses: PhotoGuess[];
  /**
   * A made-up list from the offline stand-in reader, used when no AI service is set up (development
   * only). It is never what's in the photo, and the screen says so.
   */
  sample: boolean;
  /** Short plain notes from the reader ("some items are hidden behind others"). */
  notes: string[];
  /** How many guesses were discarded as not usable. */
  discarded: number;
}

export interface ConfirmedPhotoItem {
  name: string;
  productId: string | null;
  quantity: number;
  location: StorageLocation;
  confidence: GuessConfidence;
  ownerMemberId?: string | null;
  visibility?: "household" | "private";
}

export type PhotoAvailability =
  | { state: "ready"; sample: boolean; providerName: string | null }
  | { state: "needs_plan" }
  | { state: "needs_consent"; providerName: string | null }
  | { state: "needs_provider" };

/** What the add-food screens may offer this household. Decided on the server, from the plan and settings. */
export interface ScanAccess {
  /** `publicLookup`: an unknown barcode number may be looked up in Open Food Facts (see BARCODE_LOOKUP). */
  barcode: { allowed: boolean; publicLookup: boolean };
  photo: PhotoAvailability;
}
