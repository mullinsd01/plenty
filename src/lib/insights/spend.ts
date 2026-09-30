/**
 * Grocery spend: weekly totals, averages against a budget, and what a
 * typical shop looks like. Weeks start on Monday.
 */

import type { Currency } from "@/lib/domain";
import { addDays, isDateString, weekdayOf } from "@/lib/dates";
import { median } from "@/lib/consumption/stats";

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Weeks shown in the spend summary (including the current one). */
export const SPEND_WEEKS = 8;
/** The trend compares the most recent completed weeks… */
export const TREND_RECENT_WEEKS = 3;
/** …with the completed weeks before them. */
export const TREND_EARLIER_WEEKS = 4;
/** Each side of the trend needs at least this many weeks with spend. */
export const TREND_MIN_WEEKS_WITH_SPEND = 2;
/** Relative change beyond which spend is trending up or down. */
export const TREND_THRESHOLD = 0.1;
/** Averages at or above this are rounded to the nearest 5 in labels. */
const ROUND_TO_FIVE_FROM = 50;
const ROUNDED_MONEY_STEP = 5;
const DAYS_PER_WEEK = 7;

const CURRENCY_SYMBOLS: Record<Currency, string> = {
  AUD: "$",
  NZD: "$",
  USD: "$",
  CAD: "$",
  GBP: "£",
  EUR: "€",
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SpendSummaryInput {
  receipts: Array<{ date: string; total: number }>;
  today: string;
  weeklyBudget: number | null;
  /** Used only for the label's currency symbol. Defaults to AUD. */
  currency?: Currency;
}

export interface SpendWeek {
  /** Monday of the week, "YYYY-MM-DD". */
  weekStart: string;
  total: number;
}

export type SpendTrend = "up" | "down" | "steady";

export interface SpendSummary {
  /** The last 8 Monday-start weeks including this one, oldest first, zero-filled. */
  weeks: SpendWeek[];
  /** Mean of completed weeks with spend (this week only if it's the only one); null without spend. */
  averageWeekly: number | null;
  thisWeek: number;
  /** Weeks (of the 8) whose total exceeded the budget. */
  overBudgetWeeks: number;
  trend: SpendTrend | null;
  /** "You spend about $185 a week, within your $200 budget"; null without spend. */
  label: string | null;
}

export interface TypicalShop {
  medianItems: number | null;
  medianSpend: number | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function roundCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function mean(values: readonly number[]): number | null {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

/** Monday on or before the given date. */
export function weekStartOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK));
}

function weeklyTotals(receipts: SpendSummaryInput["receipts"], today: string): SpendWeek[] {
  const current = weekStartOf(today);
  const starts = Array.from({ length: SPEND_WEEKS }, (_, i) => addDays(current, -DAYS_PER_WEEK * (SPEND_WEEKS - 1 - i)));
  const totals = new Map<string, number>(starts.map((s) => [s, 0]));
  for (const r of receipts) {
    if (!isDateString(r.date) || r.date > today || !Number.isFinite(r.total)) continue;
    const week = weekStartOf(r.date);
    const running = totals.get(week);
    if (running !== undefined) totals.set(week, running + r.total);
  }
  return starts.map((weekStart) => ({ weekStart, total: roundCents(totals.get(weekStart) ?? 0) }));
}

/**
 * Average of weeks with spend. The current week is still in progress, so it
 * only counts when no completed week has any spend.
 */
function averageOfSpendWeeks(weeks: readonly SpendWeek[]): number | null {
  const completed = weeks.slice(0, -1).filter((w) => w.total > 0).map((w) => w.total);
  const thisWeek = weeks.at(-1)?.total ?? 0;
  const avg = mean(completed) ?? (thisWeek > 0 ? thisWeek : null);
  return avg === null ? null : roundCents(avg);
}

function trendOf(weeks: readonly SpendWeek[]): SpendTrend | null {
  const completed = weeks.slice(0, -1);
  const recent = completed.slice(-TREND_RECENT_WEEKS).filter((w) => w.total > 0);
  const earlier = completed
    .slice(-(TREND_RECENT_WEEKS + TREND_EARLIER_WEEKS), -TREND_RECENT_WEEKS)
    .filter((w) => w.total > 0);
  if (recent.length < TREND_MIN_WEEKS_WITH_SPEND || earlier.length < TREND_MIN_WEEKS_WITH_SPEND) return null;
  const before = mean(earlier.map((w) => w.total)) ?? 0;
  const after = mean(recent.map((w) => w.total)) ?? 0;
  if (before <= 0) return null;
  const change = (after - before) / before;
  if (change > TREND_THRESHOLD) return "up";
  if (change < -TREND_THRESHOLD) return "down";
  return "steady";
}

/** Rounding step used when showing `amount`: 5 for larger amounts, else 1. */
function approxMoneyStep(amount: number): number {
  return amount >= ROUND_TO_FIVE_FROM ? ROUNDED_MONEY_STEP : 1;
}

/** "$185" — whole units, nearest 5 for larger amounts to avoid false precision. */
function formatApproxMoney(amount: number, currency: Currency): string {
  const step = approxMoneyStep(amount);
  return `${CURRENCY_SYMBOLS[currency]}${Math.round(amount / step) * step}`;
}

/**
 * Where the average sits against the budget, judged no more finely than the
 * figures shown: within half a rounding step of the (whole-unit) budget it is
 * "right on" it, so the label never reads "about $200 a week, over your $200
 * budget".
 */
function budgetPhrase(average: number, budget: number, currency: Currency): string {
  const shownBudget = Math.round(budget);
  const budgetText = `${CURRENCY_SYMBOLS[currency]}${shownBudget}`;
  if (Math.abs(average - shownBudget) < approxMoneyStep(average) / 2) return `right on your ${budgetText} budget`;
  return average > budget ? `over your ${budgetText} budget` : `within your ${budgetText} budget`;
}

function spendLabel(
  average: number | null,
  budget: number | null,
  trend: SpendTrend | null,
  currency: Currency,
): string | null {
  if (average === null) return null;
  const base = `You spend about ${formatApproxMoney(average, currency)} a week`;
  if (budget !== null) return `${base}, ${budgetPhrase(average, budget, currency)}`;
  if (trend === "up") return `${base}, and it's been creeping up`;
  if (trend === "down") return `${base}, and it's been coming down`;
  return base;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Weekly spend over the last 8 Monday-start weeks (oldest first, zero
 * filled; future-dated receipts ignored). The average covers completed weeks
 * with spend; the trend compares the last 3 completed weeks with the 4
 * before them (±10% is steady). Budget comparisons ignore a budget ≤ 0.
 */
export function spendSummary(input: SpendSummaryInput): SpendSummary {
  const weeks = weeklyTotals(input.receipts, input.today);
  const budget = input.weeklyBudget !== null && Number.isFinite(input.weeklyBudget) && input.weeklyBudget > 0
    ? input.weeklyBudget
    : null;
  const averageWeekly = averageOfSpendWeeks(weeks);
  const trend = trendOf(weeks);
  return {
    weeks,
    averageWeekly,
    thisWeek: weeks.at(-1)?.total ?? 0,
    overBudgetWeeks: budget === null ? 0 : weeks.filter((w) => w.total > budget).length,
    trend,
    label: spendLabel(averageWeekly, budget, trend, input.currency ?? "AUD"),
  };
}

/**
 * What a typical shop looks like: the median item count (rounded) and the
 * median receipt total. Receipts without items or totals are skipped for
 * the respective figure.
 */
export function typicalShop(receipts: ReadonlyArray<{ itemCount: number; total: number | null }>): TypicalShop {
  const items = median(receipts.map((r) => r.itemCount).filter((n) => Number.isFinite(n) && n > 0));
  const totals = receipts
    .map((r) => r.total)
    .filter((t): t is number => t !== null && Number.isFinite(t) && t > 0);
  const spend = median(totals);
  return {
    medianItems: items === null ? null : Math.round(items),
    medianSpend: spend === null ? null : roundCents(spend),
  };
}
