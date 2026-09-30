/**
 * Waste insights: products this household regularly buys more of than it
 * uses, with a gentle, practical suggestion.
 */

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Needs at least this many wasted/expired lifecycles before we say anything. */
export const WASTE_MIN_EVENTS = 2;
/** Share wasted at which a product is worth mentioning. */
export const WASTE_MEDIUM_RATIO = 0.25;
/** Share wasted at which it's a clear pattern. */
export const WASTE_HIGH_RATIO = 0.45;
/** Buying less by the full waste ratio overshoots; correct by this share of it. */
export const WASTE_CORRECTION_DAMPING = 0.8;
export const MIN_PURCHASE_FACTOR = 0.5;
export const MAX_PURCHASE_FACTOR = 0.9;
/** Bought at least this often → suggest buying less often as well as less. */
const REGULAR_PURCHASE_COUNT = 3;
const FACTOR_STEP = 0.05;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WasteInsightInput {
  productId: string;
  name: string;
  /** Wasted / (used + wasted), 0–1. */
  wasteRatio: number;
  wasteEvents: number;
  purchaseCount: number;
}

export type WasteSeverity = "high" | "medium";

export interface WasteInsight {
  productId: string;
  name: string;
  severity: WasteSeverity;
  /** "You usually buy more spinach than you use." */
  message: string;
  /** "Try a smaller bag, or plan a meal that uses it early in the week." */
  suggestion: string;
  /** Multiply the usual purchase amount by this (0.5–0.9). */
  suggestedPurchaseFactor: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Lower-case the first letter for mid-sentence use, leaving acronyms ("UHT milk") alone. */
function inSentence(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length > 1 && trimmed[1] === trimmed[1].toUpperCase() && /[A-Za-z]/.test(trimmed[1])) return trimmed;
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

function purchaseFactor(wasteRatio: number): number {
  const raw = 1 - wasteRatio * WASTE_CORRECTION_DAMPING;
  const stepped = Math.round(raw / FACTOR_STEP) * FACTOR_STEP;
  return Math.round(Math.min(MAX_PURCHASE_FACTOR, Math.max(MIN_PURCHASE_FACTOR, stepped)) * 100) / 100;
}

function suggestionFor(severity: WasteSeverity, purchaseCount: number): string {
  if (severity === "medium") return "Plan a meal that uses it early in the week, so less of it goes to waste.";
  return purchaseCount >= REGULAR_PURCHASE_COUNT
    ? "Try a smaller size or buying it less often, and plan a meal that uses it early in the week."
    : "Try a smaller size, or plan a meal that uses it early in the week.";
}

function toInsight(item: WasteInsightInput): WasteInsight {
  const severity: WasteSeverity = item.wasteRatio >= WASTE_HIGH_RATIO ? "high" : "medium";
  const name = inSentence(item.name);
  return {
    productId: item.productId,
    name: item.name,
    severity,
    message:
      severity === "high"
        ? `You usually buy more ${name} than you use.`
        : `Some of your ${name} tends to go to waste.`,
    suggestion: suggestionFor(severity, item.purchaseCount),
    suggestedPurchaseFactor: purchaseFactor(item.wasteRatio),
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Products with a real waste pattern (≥ 2 waste events and ≥ 25% wasted),
 * most severe first (high ≥ 45%), then by waste ratio, then name. Each
 * suggests a purchase factor of 1 − 0.8 × ratio, in 0.05 steps within 0.5–0.9.
 */
export function wasteInsights(items: readonly WasteInsightInput[]): WasteInsight[] {
  return items
    .filter(
      (i) =>
        Number.isFinite(i.wasteRatio) && i.wasteEvents >= WASTE_MIN_EVENTS && i.wasteRatio >= WASTE_MEDIUM_RATIO,
    )
    .map((i) => ({ ...i, wasteRatio: Math.min(1, i.wasteRatio) }))
    .sort(
      (a, b) =>
        Number(b.wasteRatio >= WASTE_HIGH_RATIO) - Number(a.wasteRatio >= WASTE_HIGH_RATIO) ||
        b.wasteRatio - a.wasteRatio ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    .map(toInsight);
}
