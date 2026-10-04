/**
 * Receipt photo quality assessment.
 *
 * Combines image measurements (sharpness, size), OCR confidence and what the
 * parser managed to extract into a short list of problems plus one friendly,
 * actionable message. Pure and deterministic.
 *
 * Thresholds were calibrated on the sample receipts in tests/fixtures/receipts
 * with increasing Gaussian blur: OCR reads every line up to σ≈4 (blur score
 * ≥ ~20, confidence ≥ 86) and collapses by σ≈5 (blur score ≤ ~35,
 * confidence ≤ 64). Clean photos score in the thousands.
 */

import type { ParsedReceipt } from "@/lib/receipts/parse";

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Blur scores (variance of Laplacian, see `prepareReceiptImage`) below this are blurry. */
export const BLURRY_BELOW = 40;
/** Mean OCR word confidence (0–100) below this suggests a blurry or badly lit photo. */
export const LOW_OCR_CONFIDENCE = 65;
/** Photos whose long edge is shorter than this are too small to read reliably. */
export const MIN_LONG_EDGE_PX = 900;
/** …or with fewer pixels than this. */
export const MIN_PIXELS = 500_000;
/** Fewer word-like tokens (3+ letters/digits) than this means OCR found no real text. */
const MIN_READABLE_WORDS = 3;
/** Receipt evidence needed (see `receiptSignals`) before text counts as a receipt. */
const MIN_RECEIPT_SIGNALS = 2;
/** Price-like tokens ("3.50") in the text that count as one piece of receipt evidence. */
const MIN_PRICE_TOKENS = 3;

// ─── Types ──────────────────────────────────────────────────────────────────

export const RECEIPT_QUALITY_WARNINGS = ["empty", "not_a_receipt", "blurry", "low_resolution", "partial", "unclear"] as const;
export type ReceiptQualityWarning = (typeof RECEIPT_QUALITY_WARNINGS)[number];

export interface ReceiptQualityInput {
  /** Mean OCR confidence 0–100, or null when the text didn't come from OCR. */
  ocrConfidence: number | null;
  /** Raw text read from the photo. */
  text: string;
  /** From `prepareReceiptImage`; null when unknown. */
  blurScore: number | null;
  width: number;
  height: number;
  parsed: ParsedReceipt;
}

export interface ReceiptQualityAssessment {
  /** False when the photo should be retaken rather than reviewed. */
  ok: boolean;
  /** Most important first. */
  warnings: ReceiptQualityWarning[];
  /** One friendly sentence for the most important warning, or null. */
  message: string | null;
}

export const RECEIPT_QUALITY_MESSAGES: Record<ReceiptQualityWarning, string> = {
  empty: "We couldn't find any writing in this photo. Make sure the whole receipt is in frame, flat and well lit, then try again.",
  not_a_receipt: "This doesn't look like a shopping receipt. Try a photo of a supermarket receipt, laid flat with the whole thing in frame.",
  blurry: "This photo looks a bit blurry — try again in better light, holding the phone steady.",
  low_resolution: "This photo is quite small, so some prices may be misread. Move closer so the receipt fills the frame.",
  partial: "Part of this receipt might be missing — make sure the whole receipt, including the total, is in the photo.",
  unclear: "Parts of this receipt were hard to read, so double-check the items below. The total couldn't be made out.",
};

// ─── Signals ────────────────────────────────────────────────────────────────

const RECEIPT_KEYWORDS =
  /\b(?:TOTAL|SUB\s*-?TOTAL|GST|VAT|TAX|EFTPOS|VISA|MASTERCARD|AMEX|CASH|CHANGE|RECEIPT|INVOICE|ITEMS?|BALANCE|DUE|PAID|CARD|SAVINGS?)\b/gi;
const PRICE_TOKEN = /\d+[.,]\d{2}\b/g;
const WORD_TOKEN = /[A-Za-z0-9]{3,}/g;

function readableWords(text: string): number {
  return (text.match(WORD_TOKEN) ?? []).filter((w) => /[A-Za-z]/.test(w)).length;
}

/** Independent pieces of evidence that the text is a shopping receipt. */
function receiptSignals(text: string, parsed: ParsedReceipt): number {
  let signals = 0;
  if (parsed.lines.length > 0) signals += 2;
  if (parsed.total !== null) signals += 1;
  if (parsed.store !== null) signals += 1;
  if (parsed.purchasedOn !== null) signals += 1;
  if ((text.match(PRICE_TOKEN) ?? []).length >= MIN_PRICE_TOKENS) signals += 1;
  if (new Set((text.match(RECEIPT_KEYWORDS) ?? []).map((k) => k.toUpperCase())).size >= 2) signals += 1;
  return signals;
}

/** Items were found and they add up to a printed total. */
function parseIsConsistent(parsed: ParsedReceipt): boolean {
  return parsed.lines.length > 0 && parsed.total !== null && !parsed.warnings.includes("total_mismatch");
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Judge whether a receipt photo is good enough to review or should be retaken.
 *
 * - "empty": OCR found (almost) no words — nothing to work with.
 * - "not_a_receipt": sharp, readable text but no sign of a receipt.
 * - "blurry": low blur score or low OCR confidence.
 * - "low_resolution": the photo is small.
 * - "partial": items found but no total, or they don't add up to it.
 * - "unclear": items found and the receipt continues below them, but no total
 *   could be read (a garbled total isn't a cut-off receipt).
 *
 * `ok` is false for "empty" and "not_a_receipt", and for "blurry" /
 * "low_resolution" unless the parse still came out consistent (items that add
 * up to a total). "partial" alone never blocks — the user reviews the lines.
 */
export function assessReceiptQuality(input: ReceiptQualityInput): ReceiptQualityAssessment {
  const { parsed, text } = input;
  const blurry =
    (input.blurScore !== null && input.blurScore < BLURRY_BELOW) ||
    (input.ocrConfidence !== null && input.ocrConfidence < LOW_OCR_CONFIDENCE && readableWords(text) >= MIN_READABLE_WORDS);
  const lowResolution = Math.max(input.width, input.height) < MIN_LONG_EDGE_PX || input.width * input.height < MIN_PIXELS;
  const empty = readableWords(text) < MIN_READABLE_WORDS && parsed.lines.length === 0;
  const notAReceipt = !empty && !blurry && receiptSignals(text, parsed) < MIN_RECEIPT_SIGNALS;
  // No total was read: that only suggests a cut-off receipt when the items run into the end of the text. When the receipt visibly
  // carries on below them ("total_unreadable") nothing is missing from the photo; the total was just illegible.
  const totalUnreadable = parsed.total === null && parsed.warnings.includes("total_unreadable");
  const partial = parsed.lines.length > 0 && ((parsed.total === null && !totalUnreadable) || parsed.warnings.includes("total_mismatch"));
  // A subtotal that matched the items is a reading success, not a problem worth a warning.
  const unclear = parsed.lines.length > 0 && totalUnreadable && parsed.subtotal === null;

  const flags: Record<ReceiptQualityWarning, boolean> = {
    empty,
    not_a_receipt: notAReceipt,
    blurry,
    low_resolution: lowResolution,
    partial,
    unclear,
  };
  const warnings = RECEIPT_QUALITY_WARNINGS.filter((w) => flags[w]);
  const consistent = parseIsConsistent(parsed);
  const ok = !empty && !notAReceipt && ((!blurry && !lowResolution) || consistent);
  return { ok, warnings, message: warnings.length > 0 ? RECEIPT_QUALITY_MESSAGES[warnings[0]] : null };
}
