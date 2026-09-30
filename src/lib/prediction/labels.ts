/**
 * Human wording for run-out estimates and durations.
 *
 * Predictions are estimates, so the wording deliberately avoids false
 * precision: "about 4 days", "about a week", or a range ("2–4 days") while
 * Plenty is still learning a household.
 */

import type { Confidence } from "@/lib/domain";

// ─── Thresholds (days) ──────────────────────────────────────────────────────

/** At or below this, the item is probably already gone. */
export const OUT_NOW_MAX_DAYS = 0.35;
/** Below this, it will probably run out today. */
export const TODAY_MAX_DAYS = 0.75;
/** Below this, "about 1 day". */
export const ONE_DAY_MAX_DAYS = 1.5;
/** Below this, "about N days" (N = 2–6). */
export const FEW_DAYS_MAX_DAYS = 6.5;
/** Below this, "about a week". */
export const ABOUT_A_WEEK_MAX_DAYS = 10;
/** Below this, "about 2 weeks". */
export const TWO_WEEKS_MAX_DAYS = 17.5;
/** Below this, "about 3 weeks"; beyond it "a month or more". */
export const THREE_WEEKS_MAX_DAYS = 25;
/** Low-confidence estimates shorter than this are shown as a range. */
export const RANGE_MAX_DAYS = 10;
/** …but only when the rounded ends of the range differ by at least this much. */
export const RANGE_MIN_WIDTH_DAYS = 2;

/** Durations shorter than this read as "about a month" rather than "N months". */
const ABOUT_A_MONTH_MAX_DAYS = 45;
/** Short labels switch from days to weeks at this point. */
const SHORT_DAYS_MAX_DAYS = 13.5;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;

export interface DaysRemainingOptions {
  /** Pessimistic end of the estimate, in days. */
  low?: number | null;
  /** Optimistic end of the estimate, in days. */
  high?: number | null;
  confidence?: Confidence | null;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "2–4 days" / "up to 3 days" for unsure short estimates, else null. */
function lowConfidenceRange(days: number, { low, high, confidence }: DaysRemainingOptions): string | null {
  if (confidence !== "low" || days >= RANGE_MAX_DAYS) return null;
  if (low == null || high == null || !Number.isFinite(low) || !Number.isFinite(high)) return null;
  const from = Math.max(0, Math.round(Math.min(low, days)));
  const to = Math.round(Math.max(high, days));
  if (to - from < RANGE_MIN_WIDTH_DAYS) return null;
  return from === 0 ? `up to ${plural(to, "day", "days")}` : `${from}–${to} days`;
}

/**
 * How long until something runs out, without false precision:
 * "probably out now", "probably today", "about 1 day", "about 4 days",
 * "about a week", "about 2 weeks", "about 3 weeks", "a month or more".
 * A low-confidence estimate under 10 days whose rounded low/high differ by
 * two or more days is shown as a range instead ("2–4 days").
 */
export function formatDaysRemaining(days: number, options: DaysRemainingOptions = {}): string {
  if (Number.isNaN(days) || days <= OUT_NOW_MAX_DAYS) return "probably out now";
  if (days < TODAY_MAX_DAYS) return "probably today";
  const range = lowConfidenceRange(days, options);
  if (range) return range;
  if (days < ONE_DAY_MAX_DAYS) return "about 1 day";
  if (days < FEW_DAYS_MAX_DAYS) return `about ${Math.round(days)} days`;
  if (days < ABOUT_A_WEEK_MAX_DAYS) return "about a week";
  if (days < TWO_WEEKS_MAX_DAYS) return "about 2 weeks";
  if (days < THREE_WEEKS_MAX_DAYS) return "about 3 weeks";
  return "a month or more";
}

/**
 * Compact form for chips and list rows: "today", "1 day", "5 days",
 * "2 weeks", "3 months". Anything under ¾ of a day (or invalid) is "today".
 */
export function formatDaysShort(days: number): string {
  if (!(days >= TODAY_MAX_DAYS)) return "today";
  if (days < ONE_DAY_MAX_DAYS) return "1 day";
  if (days < SHORT_DAYS_MAX_DAYS) return `${Math.round(days)} days`;
  if (days < ABOUT_A_MONTH_MAX_DAYS) return plural(Math.round(days / DAYS_PER_WEEK), "week", "weeks");
  return plural(Math.round(days / DAYS_PER_MONTH), "month", "months");
}

/**
 * A rounded duration for use after "about"/"in about":
 * "a day", "4 days", "a week", "2 weeks", "3 weeks", "a month", "2 months".
 */
export function formatDuration(days: number): string {
  if (!(days >= ONE_DAY_MAX_DAYS)) return "a day";
  if (days < FEW_DAYS_MAX_DAYS) return `${Math.round(days)} days`;
  if (days < ABOUT_A_WEEK_MAX_DAYS) return "a week";
  if (days < TWO_WEEKS_MAX_DAYS) return "2 weeks";
  if (days < THREE_WEEKS_MAX_DAYS) return "3 weeks";
  if (days < ABOUT_A_MONTH_MAX_DAYS) return "a month";
  return `${Math.round(days / DAYS_PER_MONTH)} months`;
}
