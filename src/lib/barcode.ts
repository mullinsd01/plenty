/**
 * Barcode numbers: read, validate and normalise.
 *
 * Product barcodes are GS1 numbers (GTINs) of 8, 12, 13 or 14 digits whose last
 * digit is a check digit. Everything that reads a barcode (the camera, a photo,
 * typed numbers) goes through `parseBarcode`, so a misread is caught by the
 * check digit before anything is looked up, and the same product always gets
 * the same key:
 *
 *   - UPC-A (12 digits) becomes a GTIN-13 with a leading 0, so it matches the
 *     same item scanned as EAN-13.
 *   - UPC-E (8 digits, compressed) is expanded to UPC-A first.
 *   - ITF-14 (14 digits) with indicator 0 is the same item as its GTIN-13. Any
 *     other indicator marks a case or multipack: it is kept as 14 digits and
 *     flagged, because it is a different thing from the single item.
 *   - EAN-8 stays 8 digits.
 *
 * Codes that are valid but don't identify a product (weighed or packed in the
 * shop, coupons, books) are refused with a plain explanation.
 *
 * Pure and dependency-free, so it runs in the browser and on the server.
 */

export type BarcodeKind = "ean8" | "ean13" | "upca" | "upce" | "itf14" | "gtin14";

export type BarcodeRejection =
  | "empty"
  | "not_digits"
  | "bad_length"
  | "bad_checksum"
  | "all_zero"
  | "in_store"
  | "coupon"
  | "publication";

export interface Barcode {
  /** The canonical key: 8, 13 or 14 digits. This is what is stored and looked up. */
  gtin: string;
  /** What kind of code it was read as. */
  kind: BarcodeKind;
  /** A case or multipack code (ITF-14 with an indicator other than 0), not a single item. */
  packaging: boolean;
  /** The canonical number with spaces, easier to read back to a person. */
  display: string;
}

export type BarcodeResult = { ok: true; barcode: Barcode } | { ok: false; reason: BarcodeRejection; message: string };

/** What a scanner says it saw, in the names the browser's BarcodeDetector uses. */
export type BarcodeFormatHint = "ean_13" | "ean_8" | "upc_a" | "upc_e" | "itf";

/** The symbologies Plenty reads: the ones printed on food and household products. */
export const SCANNABLE_FORMATS: readonly BarcodeFormatHint[] = ["ean_13", "ean_8", "upc_a", "upc_e", "itf"];

/** Typed input longer than this is never a barcode; it is refused before any parsing. */
export const MAX_BARCODE_INPUT_LENGTH = 64;

const MESSAGES: Record<BarcodeRejection, string> = {
  empty: "Type the numbers printed under the barcode.",
  not_digits: "Barcodes are made of digits only. Check the numbers under the barcode.",
  bad_length: "Product barcodes have 8, 12, 13 or 14 digits. Check you've typed them all.",
  bad_checksum: "Those numbers don't add up, so one may be mistyped or misread. Check them against the barcode.",
  all_zero: "That isn't a real barcode.",
  in_store: "That's a shop's own label, used for things weighed or packed in the shop, so it only means something in that shop. Name it instead.",
  coupon: "That looks like a coupon or voucher code, not a product barcode.",
  publication: "That looks like a book or magazine barcode, not a food or household product.",
};

export function barcodeMessage(reason: BarcodeRejection): string {
  return MESSAGES[reason];
}

/** The GS1 check digit for a number without its last digit: weights 3, 1, 3, 1… from the right. */
export function gs1CheckDigit(body: string): number {
  let sum = 0;
  let weight = 3;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += (body.charCodeAt(i) - 48) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10;
}

/** Whether the last digit is the right check digit for the rest. Digits only. */
export function hasValidCheckDigit(code: string): boolean {
  return /^[0-9]{2,}$/.test(code) && gs1CheckDigit(code.slice(0, -1)) === code.charCodeAt(code.length - 1) - 48;
}

/**
 * Expand an 8-digit UPC-E (number system 0 or 1, six digits, check digit) to its
 * 12-digit UPC-A. Null when the digits don't form a valid UPC-E.
 */
export function expandUpcE(code: string): string | null {
  if (!/^[01][0-9]{7}$/.test(code)) return null;
  const ns = code[0];
  const [x1, x2, x3, x4, x5, x6] = code.slice(1, 7);
  const check = code[7];
  let body: string;
  if (x6 === "0" || x6 === "1" || x6 === "2") body = `${ns}${x1}${x2}${x6}0000${x3}${x4}${x5}`;
  else if (x6 === "3") body = `${ns}${x1}${x2}${x3}00000${x4}${x5}`;
  else if (x6 === "4") body = `${ns}${x1}${x2}${x3}${x4}00000${x5}`;
  else body = `${ns}${x1}${x2}${x3}${x4}${x5}0000${x6}`;
  const upcA = `${body}${check}`;
  return hasValidCheckDigit(upcA) ? upcA : null;
}

function group(gtin: string): string {
  if (gtin.length === 13) return `${gtin[0]} ${gtin.slice(1, 7)} ${gtin.slice(7)}`;
  if (gtin.length === 8) return `${gtin.slice(0, 4)} ${gtin.slice(4)}`;
  return gtin;
}

/** Number ranges that are valid GTINs but not a product anyone can look up. */
function nonProductReason(gtin13: string): BarcodeRejection | null {
  if (/^(2|02|04)/.test(gtin13)) return "in_store";
  if (/^(05|98[1-4]|99)/.test(gtin13)) return "coupon";
  if (/^97[789]/.test(gtin13)) return "publication";
  return null;
}

/** Normalise a hint from any scanner ("EAN-13", "ean_13", "UPC-A") to the BarcodeDetector names. */
export function formatHintFrom(format: unknown): BarcodeFormatHint | undefined {
  if (typeof format !== "string") return undefined;
  const key = format.trim().toLowerCase().replace(/[-\s]/g, "_");
  if (key === "ean13") return "ean_13";
  if (key === "ean8") return "ean_8";
  if (key === "upca") return "upc_a";
  if (key === "upce") return "upc_e";
  if (key === "itf14") return "itf";
  return (SCANNABLE_FORMATS as readonly string[]).includes(key) ? (key as BarcodeFormatHint) : undefined;
}

const reject = (reason: BarcodeRejection): BarcodeResult => ({ ok: false, reason, message: MESSAGES[reason] });

function accept(gtin: string, kind: BarcodeKind, packaging = false): BarcodeResult {
  if (gtin.length === 13) {
    const reason = nonProductReason(gtin);
    if (reason) return reject(reason);
  }
  return { ok: true, barcode: { gtin, kind, packaging, display: group(gtin) } };
}

/**
 * Read a barcode number from anything a person or scanner might produce.
 * Accepts digits, optionally written in groups separated by single spaces or
 * hyphens ("9 300633 603341"). Anything else — letters, signs, other scripts'
 * digits, stray characters — is refused. `hint` is the format a scanner
 * reported; it only settles the one real ambiguity (an 8-digit EAN-8 versus a
 * UPC-E) and never overrides the check digit.
 */
export function parseBarcode(input: unknown, hint?: BarcodeFormatHint): BarcodeResult {
  if (typeof input !== "string") return reject("empty");
  if (input.length > MAX_BARCODE_INPUT_LENGTH) return reject("not_digits");
  const text = input.trim();
  if (!text) return reject("empty");
  if (!/^[0-9]+(?:[ -][0-9]+)*$/.test(text)) return reject("not_digits");
  const digits = text.replace(/[ -]/g, "");
  if (/^0+$/.test(digits)) return reject("all_zero");

  switch (digits.length) {
    case 8: {
      const asEan8 = hasValidCheckDigit(digits);
      const upcA = expandUpcE(digits);
      if (hint === "upc_e") {
        if (upcA) return accept(`0${upcA}`, "upce");
        return reject("bad_checksum");
      }
      if (asEan8 && hint !== undefined && hint !== "ean_8") return reject("bad_checksum");
      if (asEan8) return accept(digits, "ean8");
      if (upcA && hint !== "ean_8") return accept(`0${upcA}`, "upce");
      return reject("bad_checksum");
    }
    case 12:
      return hasValidCheckDigit(digits) ? accept(`0${digits}`, "upca") : reject("bad_checksum");
    case 13:
      return hasValidCheckDigit(digits) ? accept(digits, "ean13") : reject("bad_checksum");
    case 14: {
      if (!hasValidCheckDigit(digits)) return reject("bad_checksum");
      if (digits[0] === "0") return accept(digits.slice(1), "itf14");
      // Indicator 9 marks variable-measure trade items: weighed or cut to order.
      if (digits[0] === "9") return reject("in_store");
      return accept(digits, "gtin14", true);
    }
    default:
      return reject("bad_length");
  }
}
