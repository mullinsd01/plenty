/**
 * Receipt content fingerprints.
 *
 * The same paper receipt photographed twice produces different image bytes
 * (so a different image hash) but the same content. A fingerprint of store,
 * date, total and line prices lets Plenty spot the duplicate.
 *
 * The hash is FNV-1a 64 (twice, with different prefixes, for 128 bits),
 * implemented with BigInt so this module stays pure and portable — no
 * node:crypto. It is an identifier, not a security primitive.
 */

import { isDateString } from "@/lib/dates";

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Without a total, at least this many line prices are needed to be distinctive. */
export const FINGERPRINT_MIN_LINE_PRICES = 3;
/** Bump when the canonical form changes so old and new fingerprints never collide. */
const FINGERPRINT_VERSION = "v1";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReceiptFingerprintInput {
  store: string | null;
  /** YYYY-MM-DD */
  purchasedOn: string | null;
  total: number | null;
  /** Line totals in any order; non-finite values are ignored. */
  linePrices: readonly number[];
}

// ─── Hashing ────────────────────────────────────────────────────────────────

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit hash of a UTF-8 string, as 16 lower-case hex characters. */
export function fnv1a64Hex(value: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

// ─── Canonical form ─────────────────────────────────────────────────────────

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** "Sainsbury's" → "sainsburys", "WOOLWORTHS " → "woolworths". */
function storeKey(store: string | null): string {
  return (store ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * A stable 32-hex-character fingerprint of a receipt's content, or null when
 * there is too little information to tell receipts apart: a valid purchase
 * date is required, plus either a total or at least
 * `FINGERPRINT_MIN_LINE_PRICES` line prices.
 *
 * Amounts are compared in cents and line prices are sorted, so rounding noise
 * and line order don't change the result; store names are compared
 * case- and punctuation-insensitively.
 */
export function receiptFingerprint(input: ReceiptFingerprintInput): string | null {
  const { purchasedOn } = input;
  if (!purchasedOn || !isDateString(purchasedOn)) return null;
  const total = input.total !== null && Number.isFinite(input.total) && input.total > 0 ? toCents(input.total) : null;
  const prices = input.linePrices
    .filter((p) => Number.isFinite(p))
    .map(toCents)
    .sort((a, b) => a - b);
  if (total === null && prices.length < FINGERPRINT_MIN_LINE_PRICES) return null;

  const canonical = [FINGERPRINT_VERSION, storeKey(input.store), purchasedOn, total === null ? "" : String(total), prices.join(",")].join("|");
  return fnv1a64Hex(canonical) + fnv1a64Hex(`plenty-receipt:${canonical}`);
}
