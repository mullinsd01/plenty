/**
 * Shopping rhythm: when does this household shop, and when's the next shop?
 *
 * Preferences the household set always win; otherwise the rhythm is learned
 * from recent shop dates, falling back to a weekly default.
 */

import type { Confidence } from "@/lib/domain";
import { addDays, daysBetweenDates, isDateString, WEEKDAY_NAMES, weekdayOf } from "@/lib/dates";
import { median } from "@/lib/consumption/stats";

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Only the most recent shops shape the rhythm. */
export const RHYTHM_MAX_SHOPS = 12;
/** A typical weekday needs at least this many shops… */
export const WEEKDAY_MIN_SHOPS = 3;
/** …and must account for at least this share of them. */
export const WEEKDAY_MIN_SHARE = 0.4;
export const MIN_HISTORY_INTERVAL_DAYS = 2;
export const MAX_HISTORY_INTERVAL_DAYS = 21;
export const MIN_PREFERENCE_INTERVAL_DAYS = 1;
export const MAX_PREFERENCE_INTERVAL_DAYS = 60;
export const DEFAULT_SHOP_INTERVAL_DAYS = 7;
/**
 * A learned weekday only snaps the next shop when shops are at least this
 * far apart (a twice-a-week shopper's favourite day shouldn't hide the other).
 */
export const WEEKDAY_SNAP_MIN_INTERVAL_DAYS = 5;
export const HIGH_CONFIDENCE_MIN_SHOPS = 6;
export const HIGH_CONFIDENCE_MAX_GAP_CV = 0.35;
export const HIGH_CONFIDENCE_MIN_WEEKDAY_SHARE = 0.6;
export const MEDIUM_CONFIDENCE_MIN_SHOPS = 3;

const DAYS_PER_WEEK = 7;
const FORTNIGHT_DAYS = 14;
/** Snapping to the shop weekday moves the due date at most this many days earlier. */
const MAX_SNAP_BACK_DAYS = 3;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ShoppingRhythmInput {
  /** Dates of past shops ("YYYY-MM-DD"), any order, duplicates allowed. */
  purchaseDates: string[];
  today: string;
  /** Preferred shop day (0 = Sunday … 6 = Saturday), if the household set one. */
  usualShopDay: number | null;
  /** Preferred days between shops, if the household set it. */
  shopIntervalDays: number | null;
}

export type RhythmBasis = "preference" | "history" | "default";

export interface ShoppingRhythm {
  /** 0 = Sunday … 6 = Saturday. */
  typicalWeekday: number | null;
  intervalDays: number;
  /** Next expected shop, never before today. */
  nextShopDate: string;
  /** The shop after that (next + interval). */
  followingShopDate: string;
  basis: RhythmBasis;
  confidence: Confidence;
  /** "You usually shop on Saturdays", "You shop about every 5 days"; null without enough to say. */
  label: string | null;
}

interface HistoryRhythm {
  shops: string[];
  weekday: number | null;
  weekdayShare: number;
  intervalDays: number | null;
  gapCv: number | null;
}

// ─── History analysis ───────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Valid, de-duplicated shop dates up to today, oldest first, most recent `RHYTHM_MAX_SHOPS`. */
function recentShops(dates: readonly string[], today: string): string[] {
  const valid = new Set(dates.filter((d) => isDateString(d) && d <= today));
  return [...valid].sort().slice(-RHYTHM_MAX_SHOPS);
}

/** The single most common weekday and its share; ties have no typical weekday. */
function dominantWeekday(shops: readonly string[]): { weekday: number | null; share: number } {
  if (shops.length < WEEKDAY_MIN_SHOPS) return { weekday: null, share: 0 };
  const counts = new Array<number>(DAYS_PER_WEEK).fill(0);
  for (const shop of shops) counts[weekdayOf(shop)] += 1;
  const top = Math.max(...counts);
  const share = top / shops.length;
  const isUnique = counts.filter((c) => c === top).length === 1;
  return isUnique && share >= WEEKDAY_MIN_SHARE ? { weekday: counts.indexOf(top), share } : { weekday: null, share };
}

function coefficientOfVariation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean <= 0) return null;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / mean;
}

function analyseHistory(shops: string[]): HistoryRhythm {
  const gaps = shops.slice(1).map((shop, i) => daysBetweenDates(shops[i], shop));
  const medianGap = median(gaps);
  const { weekday, share } = dominantWeekday(shops);
  return {
    shops,
    weekday,
    weekdayShare: share,
    intervalDays:
      medianGap === null ? null : clamp(Math.round(medianGap), MIN_HISTORY_INTERVAL_DAYS, MAX_HISTORY_INTERVAL_DAYS),
    gapCv: coefficientOfVariation(gaps),
  };
}

// ─── Preferences ────────────────────────────────────────────────────────────

function preferredWeekday(value: number | null): number | null {
  return value !== null && Number.isInteger(value) && value >= 0 && value < DAYS_PER_WEEK ? value : null;
}

function preferredInterval(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return clamp(Math.round(value), MIN_PREFERENCE_INTERVAL_DAYS, MAX_PREFERENCE_INTERVAL_DAYS);
}

// ─── Next shop ──────────────────────────────────────────────────────────────

/** The first `weekday` on or after `date`. */
function onOrAfterWeekday(date: string, weekday: number): string {
  return addDays(date, (weekday - weekdayOf(date) + DAYS_PER_WEEK) % DAYS_PER_WEEK);
}

/** The `weekday` nearest to `date` (at most 3 days either side), but always after `after`. */
function nearestWeekdayAfter(date: string, weekday: number, after: string): string {
  const forward = (weekday - weekdayOf(date) + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  const nearest = addDays(date, forward <= MAX_SNAP_BACK_DAYS ? forward : forward - DAYS_PER_WEEK);
  return nearest > after ? nearest : onOrAfterWeekday(addDays(after, 1), weekday);
}

/**
 * Last shop + interval, snapped to the nearest shop weekday when one
 * applies — nearest rather than strictly forward, so a mid-week top-up shop
 * doesn't push the regular shop back a week. Overdue dates roll forward: to
 * the next shop weekday from today, or by whole intervals (keeping the
 * household's cycle) otherwise. With no shop history: the next shop weekday
 * from today, or half an interval away.
 */
function nextShop(lastShop: string | null, today: string, interval: number, snapWeekday: number | null): string {
  if (lastShop === null) {
    return snapWeekday !== null ? onOrAfterWeekday(today, snapWeekday) : addDays(today, Math.floor(interval / 2));
  }
  const due = addDays(lastShop, interval);
  const candidate = snapWeekday !== null ? nearestWeekdayAfter(due, snapWeekday, lastShop) : due;
  if (candidate >= today) return candidate;
  if (snapWeekday !== null) return onOrAfterWeekday(today, snapWeekday);
  const intervalsBehind = Math.ceil(daysBetweenDates(candidate, today) / interval);
  return addDays(candidate, intervalsBehind * interval);
}

// ─── Wording & confidence ───────────────────────────────────────────────────

function rhythmLabel(weekday: number | null, interval: number, hasInterval: boolean): string | null {
  if (weekday !== null) {
    const day = WEEKDAY_NAMES[weekday];
    return interval === FORTNIGHT_DAYS ? `You usually shop every second ${day}` : `You usually shop on ${day}s`;
  }
  if (!hasInterval) return null;
  if (interval === 1) return "You shop most days";
  if (interval === DAYS_PER_WEEK) return "You shop about once a week";
  if (interval === FORTNIGHT_DAYS) return "You shop about once a fortnight";
  return `You shop about every ${interval} days`;
}

function historyConfidence(history: HistoryRhythm): Confidence {
  const count = history.shops.length;
  const regular =
    (history.gapCv !== null && history.gapCv <= HIGH_CONFIDENCE_MAX_GAP_CV) ||
    (history.weekday !== null && history.weekdayShare >= HIGH_CONFIDENCE_MIN_WEEKDAY_SHARE);
  if (count >= HIGH_CONFIDENCE_MIN_SHOPS && regular) return "high";
  return count >= MEDIUM_CONFIDENCE_MIN_SHOPS ? "medium" : "low";
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Learn the household's shopping rhythm from its last 12 distinct shop
 * dates. The typical weekday is the unique most common one when it covers
 * ≥ 40% of at least 3 shops; the interval is the median gap (2–21 days).
 * Preferences override history; with neither, shops are assumed weekly and
 * the next one three days out.
 */
export function computeShoppingRhythm(input: ShoppingRhythmInput): ShoppingRhythm {
  const { today } = input;
  const history = analyseHistory(recentShops(input.purchaseDates, today));
  const prefWeekday = preferredWeekday(input.usualShopDay);
  const prefInterval = preferredInterval(input.shopIntervalDays);

  const typicalWeekday = prefWeekday ?? history.weekday;
  const intervalDays = prefInterval ?? history.intervalDays ?? DEFAULT_SHOP_INTERVAL_DAYS;
  const snaps = prefWeekday !== null || intervalDays >= WEEKDAY_SNAP_MIN_INTERVAL_DAYS;
  const lastShop = history.shops.at(-1) ?? null;
  const nextShopDate = nextShop(lastShop, today, intervalDays, snaps ? typicalWeekday : null);

  const basis: RhythmBasis =
    prefWeekday !== null || prefInterval !== null ? "preference" : lastShop !== null ? "history" : "default";
  const confidence: Confidence =
    basis === "preference" ? "high" : basis === "history" ? historyConfidence(history) : "low";
  const hasInterval = prefInterval !== null || history.intervalDays !== null;

  return {
    typicalWeekday,
    intervalDays,
    nextShopDate,
    followingShopDate: addDays(nextShopDate, intervalDays),
    basis,
    confidence,
    label: rhythmLabel(typicalWeekday, intervalDays, hasInterval),
  };
}

/**
 * Days from today until the shop after next. Anything expected to run out
 * within this horizon should be bought at the next shop.
 */
export function shoppingHorizonDays(rhythm: Pick<ShoppingRhythm, "followingShopDate">, today: string): number {
  return Math.max(0, daysBetweenDates(today, rhythm.followingShopDate));
}
