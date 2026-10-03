/**
 * Expiry estimates and "use soon" assessments.
 *
 * Expiry dates are calendar dates ("YYYY-MM-DD") in the household's
 * timezone and are inclusive: something expiring today is still fine to use
 * today.
 */

import type { StorageLocation } from "@/lib/domain";
import { addDays, daysBetweenDates, isDateString, toDateString } from "@/lib/dates";
import { formatDuration } from "@/lib/prediction/labels";

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Shelf life assumed for perishables the catalog knows nothing about. */
export const DEFAULT_PERISHABLE_SHELF_LIFE_DAYS = 7;
/** Freezer life assumed when only the fresh shelf life (or nothing) is known. */
export const DEFAULT_FREEZER_SHELF_LIFE_DAYS = 90;
/** Expiring within this many days counts as "use soon". */
export const USE_SOON_DAYS = 3;
/** Projected to have more than this fraction left at expiry → at risk of waste. */
export const WASTE_RISK_FRACTION = 0.25;
/** On average about half of the expiry day itself is still left for using it. */
const EXPIRY_DAY_ALLOWANCE_DAYS = 0.5;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExpiryEstimateInput {
  purchasedAt: Date;
  /** Days it stays good at its usual location after purchase. */
  shelfLifeDays?: number | null;
  /** Days it lasts frozen. */
  freezerShelfLifeDays?: number | null;
  location: StorageLocation;
  perishable: boolean;
  /** Household timezone; decides which calendar day the purchase fell on. */
  timeZone: string;
}

export type UseSoonStatus = "expired" | "today" | "soon" | "ok" | "unknown";

export interface UseSoonInput {
  expiresOn: string | null;
  today: string;
  /** Fraction of the batch left now (0–1). */
  remainingFraction: number;
  /** Fraction of this batch consumed per day, when known. */
  dailyShareOfBatch?: number | null;
}

export interface UseSoonAssessment {
  /** Whole days from today to the expiry date (negative once expired). */
  daysUntilExpiry: number | null;
  status: UseSoonStatus;
  /** Projected to still have more than 25% left when it expires. */
  atRiskOfWaste: boolean;
  /** "Expired 2 days ago", "Use today", "Use within 2 days", "Around 5 days to go". */
  label: string;
}

// ─── Expiry estimates ───────────────────────────────────────────────────────

function knownDays(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Shelf life in days for where the item is kept; null when unknowable. */
function shelfLifeFor(input: ExpiryEstimateInput): number | null {
  const fresh = knownDays(input.shelfLifeDays);
  if (input.location === "freezer") {
    const frozen = knownDays(input.freezerShelfLifeDays);
    if (frozen !== null) return frozen;
    // Freezing never shortens life: items normally kept frozen already carry
    // their freezer life as `shelfLifeDays`; fresh items moved in get a default.
    if (fresh !== null) return Math.max(fresh, DEFAULT_FREEZER_SHELF_LIFE_DAYS);
    return input.perishable ? DEFAULT_FREEZER_SHELF_LIFE_DAYS : null;
  }
  if (fresh !== null) return fresh;
  return input.perishable ? DEFAULT_PERISHABLE_SHELF_LIFE_DAYS : null;
}

/**
 * Estimated expiry date ("YYYY-MM-DD") counted from the purchase day in the
 * household's timezone. The freezer uses the freezer shelf life (at least
 * 90 days when only the fresh life is known); unknown perishables get 7
 * days; unknown non-perishables return null. Fractional shelf lives round to
 * the nearest day.
 */
export function estimateExpiry(input: ExpiryEstimateInput): string | null {
  if (!(input.purchasedAt instanceof Date) || Number.isNaN(input.purchasedAt.getTime())) return null;
  const days = shelfLifeFor(input);
  if (days === null) return null;
  return addDays(toDateString(input.purchasedAt, input.timeZone), Math.round(days));
}

// ─── Use-soon assessment ────────────────────────────────────────────────────

/** A real calendar date: `isDateString` alone lets overflowing dates like "2026-13-45" through. */
function isCalendarDate(value: string): boolean {
  return isDateString(value) && addDays(value, 0) === value;
}

function statusFor(daysUntilExpiry: number): Exclude<UseSoonStatus, "unknown"> {
  if (daysUntilExpiry < 0) return "expired";
  if (daysUntilExpiry === 0) return "today";
  return daysUntilExpiry <= USE_SOON_DAYS ? "soon" : "ok";
}

function labelFor(status: UseSoonStatus, days: number): string {
  switch (status) {
    case "expired":
      return days === -1 ? "Expired yesterday" : `Expired ${-days} days ago`;
    case "today":
      return "Use today";
    case "soon":
      return days === 1 ? "Use by tomorrow" : `Use within ${days} days`;
    case "ok":
      // A date, not a promise: Plenty can only say how far off it is, never that the food is fine to eat.
      return `Around ${formatDuration(days)} to go`;
    case "unknown":
      return "No expiry date";
  }
}

/**
 * Whether more than a quarter will be left when it expires. With a known
 * daily share, remaining use is projected up to the end of the expiry day;
 * without one, only items already expired or due within `USE_SOON_DAYS`
 * are judged, on what's left now.
 */
function atRiskOfWaste(
  status: Exclude<UseSoonStatus, "unknown">,
  days: number,
  remaining: number,
  dailyShare: number | null,
): boolean {
  if (status === "expired") return remaining > WASTE_RISK_FRACTION;
  if (dailyShare === null) return status !== "ok" && remaining > WASTE_RISK_FRACTION;
  const projected = remaining - dailyShare * (days + EXPIRY_DAY_ALLOWANCE_DAYS);
  return projected > WASTE_RISK_FRACTION;
}

/**
 * How urgently a batch should be used: expired, today, soon (≤ 3 days), ok
 * or unknown (no valid expiry date), with a short label and whether it's
 * likely to be partly wasted.
 */
export function assessUseSoon(input: UseSoonInput): UseSoonAssessment {
  const { expiresOn, today } = input;
  if (expiresOn === null || !isCalendarDate(expiresOn) || !isCalendarDate(today)) {
    return { daysUntilExpiry: null, status: "unknown", atRiskOfWaste: false, label: labelFor("unknown", 0) };
  }
  const days = daysBetweenDates(today, expiresOn);
  const status = statusFor(days);
  const remaining = Number.isFinite(input.remainingFraction) ? Math.min(1, Math.max(0, input.remainingFraction)) : 0;
  const share = input.dailyShareOfBatch;
  const dailyShare = typeof share === "number" && Number.isFinite(share) && share >= 0 ? share : null;
  return {
    daysUntilExpiry: days,
    status,
    atRiskOfWaste: atRiskOfWaste(status, days, remaining, dailyShare),
    label: labelFor(status, days),
  };
}
