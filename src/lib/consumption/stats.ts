/**
 * Consumption learning.
 *
 * Turns a household's completed product lifecycles (bought → finished,
 * wasted or expired) and its purchase history into a daily usage rate.
 * Until there's enough history the rate leans on Plenty's catalog prior;
 * each finished item shifts weight towards what this household actually does.
 *
 * Pure and deterministic: `now` is always supplied by the caller.
 */

import type { Confidence, PredictionBasis } from "@/lib/domain";
import type {
  ConsumptionObservation,
  ConsumptionStats,
  ConsumptionStatsInput,
  PurchaseObservation,
} from "@/lib/consumption/types";
import { DAY_MS, daysBetween, daysBetweenDates } from "@/lib/dates";

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Shortest lifecycle used when turning an observation into a daily rate. */
export const MIN_OBSERVATION_DAYS = 0.5;
/** Wasted/expired lifecycles where less than this share was used say nothing about the rate (censored). */
export const CENSORED_USE_FRACTION = 0.2;
/** Weight of wasted/expired lifecycles that still carry rate information. */
export const PARTIAL_OBSERVATION_WEIGHT = 0.5;
/** Outlier screening only runs once there are this many rate observations. */
export const OUTLIER_MIN_OBSERVATIONS = 4;
/** Rates further than this many robust standard deviations from the median are outliers. */
export const OUTLIER_MAD_MULTIPLIER = 3;
/** Scales a median absolute deviation to a normal-equivalent standard deviation. */
const MAD_TO_STD = 1.4826;
/** When the MAD is zero (most rates identical), allow ± this fraction of the median. */
export const OUTLIER_ZERO_MAD_TOLERANCE = 0.5;
/** Recent lifecycles count double the weight of ones this many days older. */
export const RECENCY_HALF_LIFE_DAYS = 60;

export const SEASONAL_MIN_SPAN_DAYS = 300;
export const SEASONAL_MIN_OBSERVATIONS = 8;
export const SEASONAL_MIN_IN_WINDOW = 3;
/** Observations within ± this many days of today's day-of-year (any year) form the seasonal window. */
export const SEASONAL_WINDOW_DAYS = 45;
export const SEASONAL_FACTOR_MIN = 0.6;
export const SEASONAL_FACTOR_MAX = 1.6;
const DAYS_PER_YEAR = 365;

/** Share of the history rate taken from the long-run median (the rest is the recent rate). */
export const HISTORY_MEDIAN_WEIGHT = 0.5;
/**
 * The prior is worth this many observations when blending (w = e / (e + k)).
 * Here and in the thresholds below, observations are counted as evidence: a
 * finished lifecycle counts 1, a partly used wasted/expired one counts
 * `PARTIAL_OBSERVATION_WEIGHT`.
 */
export const PRIOR_PSEUDO_OBSERVATIONS = 2;
/** Observations (evidence) needed before the rate counts as learned from history. */
export const MIN_HISTORY_OBSERVATIONS = 2;

export const HIGH_CONFIDENCE_MIN_OBSERVATIONS = 5;
export const HIGH_CONFIDENCE_MAX_CV = 0.35;
export const MEDIUM_CONFIDENCE_MIN_OBSERVATIONS = 3;
export const MEDIUM_CONFIDENCE_MAX_CV = 0.6;
/** Two very consistent observations are also enough for medium confidence. */
export const MEDIUM_CONFIDENCE_CONSISTENT_CV = 0.25;

export const STAPLE_MIN_PURCHASES = 3;
export const STAPLE_MAX_INTERVAL_DAYS = 21;
/** A staple must have been bought within this many typical intervals of now. */
export const STAPLE_RECENCY_INTERVALS = 2.5;

const EPSILON = 1e-9;

// ─── Internal shapes ────────────────────────────────────────────────────────

interface WeightedValue {
  value: number;
  weight: number;
}

/** An observation with amounts and household size made safe to compute with. */
interface CleanObservation {
  used: number;
  wasted: number;
  /** Null when the lifecycle's length can't be known (it then can't inform the rate). */
  durationDays: number | null;
  endedAt: Date;
  /** Midpoint of the lifecycle; what seasonality is keyed on. */
  midpoint: Date;
  outcome: ConsumptionObservation["outcome"];
  householdSize: number;
}

/** A daily rate learned from one lifecycle, normalised to the current household size. */
interface RateSample {
  rate: number;
  weight: number;
  endedAt: Date;
  midpoint: Date;
}

interface PurchaseSummary {
  typicalPurchaseAmount: number | null;
  typicalPurchaseIntervalDays: number | null;
  purchaseCount: number;
  lastPurchasedAt: Date | null;
}

interface WasteSummary {
  wasteRatio: number;
  wasteEvents: number;
  lastFinishedAt: Date | null;
}

// ─── Numeric helpers ────────────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function positiveOr(value: number, fallback: number): number {
  return isFiniteNumber(value) && value > 0 ? value : fallback;
}

/** Median of the finite values (mean of the middle two for even counts); null when there are none. */
export function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Weighted median; reduces to the ordinary median when all weights are equal. */
function weightedMedian(items: readonly WeightedValue[]): number | null {
  const sorted = items.filter((i) => i.weight > 0).sort((a, b) => a.value - b.value);
  if (sorted.length === 0) return null;
  const half = sorted.reduce((sum, i) => sum + i.weight, 0) / 2;
  let cumulative = 0;
  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i].weight;
    if (Math.abs(cumulative - half) < EPSILON && i + 1 < sorted.length) {
      return (sorted[i].value + sorted[i + 1].value) / 2;
    }
    if (cumulative > half) return sorted[i].value;
  }
  return sorted[sorted.length - 1].value;
}

function weightedMean(items: readonly WeightedValue[]): number | null {
  let total = 0;
  let weights = 0;
  for (const { value, weight } of items) {
    total += value * weight;
    weights += weight;
  }
  return weights > 0 ? total / weights : null;
}

/**
 * Coefficient of variation with reliability weights (equals the sample CV
 * when weights are equal). Null with fewer than two items or a zero mean.
 */
function weightedCv(items: readonly WeightedValue[]): number | null {
  if (items.length < 2) return null;
  const mean = weightedMean(items);
  if (mean === null || mean <= 0) return null;
  const v1 = items.reduce((sum, i) => sum + i.weight, 0);
  const v2 = items.reduce((sum, i) => sum + i.weight * i.weight, 0);
  const denominator = v1 - v2 / v1;
  if (denominator <= 0) return null;
  const variance = items.reduce((sum, i) => sum + i.weight * (i.value - mean) ** 2, 0) / denominator;
  return Math.sqrt(variance) / mean;
}

function dayOfYear(instant: Date): number {
  return Math.floor((instant.getTime() - Date.UTC(instant.getUTCFullYear(), 0, 1)) / DAY_MS);
}

function circularDayDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % DAYS_PER_YEAR;
  return Math.min(diff, DAYS_PER_YEAR - diff);
}

// ─── Observations → rate samples ────────────────────────────────────────────

/**
 * Length of a lifecycle in days: the recorded duration, else the time from
 * start to end. Null when neither is usable (missing, or ending before it
 * started) — such a lifecycle says nothing about the rate, and must not be
 * read as an instant one.
 */
function lifecycleDays(o: ConsumptionObservation, endedAt: Date): number | null {
  if (isFiniteNumber(o.durationDays) && o.durationDays >= 0) return o.durationDays;
  if (!isValidDate(o.startedAt)) return null;
  const fromDates = daysBetween(o.startedAt, endedAt);
  return fromDates >= 0 ? fromDates : null;
}

function cleanObservation(o: ConsumptionObservation, currentHouseholdSize: number): CleanObservation | null {
  if (!isValidDate(o.endedAt) || !isFiniteNumber(o.amountUsedBase)) return null;
  const durationDays = lifecycleDays(o, o.endedAt);
  const startedAt = isValidDate(o.startedAt) ? o.startedAt : new Date(o.endedAt.getTime() - (durationDays ?? 0) * DAY_MS);
  return {
    used: Math.max(0, o.amountUsedBase),
    wasted: isFiniteNumber(o.amountWastedBase) ? Math.max(0, o.amountWastedBase) : 0,
    durationDays,
    endedAt: o.endedAt,
    midpoint: new Date((startedAt.getTime() + o.endedAt.getTime()) / 2),
    outcome: o.outcome,
    // Unknown household size at the time: assume it matched today's (no scaling).
    householdSize: positiveOr(o.householdSize, currentHouseholdSize),
  };
}

/**
 * How much a lifecycle tells us about the usage rate: fully for consumed
 * items, half for wasted/expired ones, nothing when most of it was binned.
 */
function observationWeight(o: CleanObservation): number {
  if (o.outcome === "consumed") return 1;
  const usedFraction = o.used / (o.used + o.wasted);
  return usedFraction < CENSORED_USE_FRACTION ? 0 : PARTIAL_OBSERVATION_WEIGHT;
}

function toRateSample(o: CleanObservation, currentHouseholdSize: number): RateSample | null {
  if (o.used <= 0 || o.durationDays === null) return null;
  const weight = observationWeight(o);
  if (weight === 0) return null;
  const perAdultEquivalent = o.used / Math.max(o.durationDays, MIN_OBSERVATION_DAYS) / o.householdSize;
  return {
    rate: perAdultEquivalent * currentHouseholdSize,
    weight,
    endedAt: o.endedAt,
    midpoint: o.midpoint,
  };
}

/** Drop rates far from the median (robust MAD test) once there are enough to judge. */
function excludeOutliers(samples: RateSample[]): { kept: RateSample[]; excluded: number } {
  if (samples.length < OUTLIER_MIN_OBSERVATIONS) return { kept: samples, excluded: 0 };
  const rates = samples.map((s) => s.rate);
  const centre = median(rates) ?? 0;
  const mad = median(rates.map((r) => Math.abs(r - centre))) ?? 0;
  const tolerance =
    mad > EPSILON * centre ? OUTLIER_MAD_MULTIPLIER * MAD_TO_STD * mad : OUTLIER_ZERO_MAD_TOLERANCE * centre;
  const kept = samples.filter((s) => Math.abs(s.rate - centre) <= tolerance * (1 + EPSILON));
  return { kept, excluded: samples.length - kept.length };
}

function asWeighted(samples: readonly RateSample[]): WeightedValue[] {
  return samples.map((s) => ({ value: s.rate, weight: s.weight }));
}

function recencyWeightedRate(samples: readonly RateSample[], now: Date): number | null {
  const decayed = samples.map((s) => {
    const ageDays = Math.max(0, daysBetween(s.endedAt, now));
    return { value: s.rate, weight: s.weight * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS) };
  });
  // Centuries-old data can underflow every weight to zero; fall back to the plain mean.
  return weightedMean(decayed) ?? weightedMean(asWeighted(samples));
}

/**
 * Ratio of usage around this time of year to overall usage. Only trusted
 * with most of a year of history and several observations in the window.
 */
function seasonalFactorFor(samples: readonly RateSample[], now: Date, overallMean: number | null): number {
  if (samples.length < SEASONAL_MIN_OBSERVATIONS || overallMean === null || overallMean <= 0) return 1;
  const times = samples.map((s) => s.midpoint.getTime());
  const spanDays = (Math.max(...times) - Math.min(...times)) / DAY_MS;
  if (spanDays < SEASONAL_MIN_SPAN_DAYS) return 1;
  const today = dayOfYear(now);
  const inWindow = samples.filter((s) => circularDayDistance(dayOfYear(s.midpoint), today) <= SEASONAL_WINDOW_DAYS);
  if (inWindow.length < SEASONAL_MIN_IN_WINDOW) return 1;
  const windowMean = weightedMean(asWeighted(inWindow));
  if (windowMean === null) return 1;
  return clamp(windowMean / overallMean, SEASONAL_FACTOR_MIN, SEASONAL_FACTOR_MAX);
}

// ─── Blending & confidence ──────────────────────────────────────────────────

interface BlendInput {
  /** Observations' worth of history (sum of sample weights). */
  evidence: number;
  medianRate: number | null;
  recentRate: number | null;
  priorRate: number | null;
  seasonalFactor: number;
}

/**
 * Blend history (half median, half recency-weighted) with the prior, which
 * is worth `PRIOR_PSEUDO_OBSERVATIONS` observations, then apply the seasonal
 * factor. With no history the prior stands alone; with no prior a single
 * observation isn't enough to predict from.
 *
 * The recent rate only partly reflects the current season (a 60-day
 * half-life reaches well outside the ±45-day window), so scaling the whole
 * blend tracks seasonal usage better than scaling the median alone.
 */
function blendDailyRate({ evidence, medianRate, recentRate, priorRate, seasonalFactor }: BlendInput): number | null {
  if (evidence <= 0 || medianRate === null || recentRate === null) return priorRate;
  if (priorRate === null && !atLeast(evidence, MIN_HISTORY_OBSERVATIONS)) return null;
  const historyRate = HISTORY_MEDIAN_WEIGHT * medianRate + (1 - HISTORY_MEDIAN_WEIGHT) * recentRate;
  const w = evidence / (evidence + PRIOR_PSEUDO_OBSERVATIONS);
  const blended = priorRate === null ? historyRate : w * historyRate + (1 - w) * priorRate;
  return blended * seasonalFactor;
}

/** `evidence` reaches `threshold`, ignoring float noise from summing weights. */
function atLeast(evidence: number, threshold: number): boolean {
  return evidence >= threshold - EPSILON;
}

function historyConfidence(evidence: number, cv: number | null): Confidence {
  const spread = cv ?? Number.POSITIVE_INFINITY;
  if (atLeast(evidence, HIGH_CONFIDENCE_MIN_OBSERVATIONS) && spread <= HIGH_CONFIDENCE_MAX_CV) return "high";
  if (atLeast(evidence, MEDIUM_CONFIDENCE_MIN_OBSERVATIONS) && spread <= MEDIUM_CONFIDENCE_MAX_CV) return "medium";
  if (atLeast(evidence, MIN_HISTORY_OBSERVATIONS) && spread <= MEDIUM_CONFIDENCE_CONSISTENT_CV) return "medium";
  return "low";
}

// ─── Purchases & waste ──────────────────────────────────────────────────────

function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Purchase rhythm. Purchases on the same UTC calendar day are one shop:
 * their amounts add up and they count once towards `purchaseCount`.
 */
function summarisePurchases(purchases: readonly PurchaseObservation[]): PurchaseSummary {
  const byDay = new Map<string, number>();
  let lastPurchasedAt: Date | null = null;
  for (const p of purchases) {
    if (!isValidDate(p.purchasedAt)) continue;
    const day = utcDay(p.purchasedAt);
    const amount = isFiniteNumber(p.amountBase) && p.amountBase > 0 ? p.amountBase : 0;
    byDay.set(day, (byDay.get(day) ?? 0) + amount);
    if (!lastPurchasedAt || p.purchasedAt > lastPurchasedAt) lastPurchasedAt = p.purchasedAt;
  }
  const days = [...byDay.keys()].sort();
  const gaps = days.slice(1).map((day, i) => daysBetweenDates(days[i], day));
  const amounts = [...byDay.values()].filter((a) => a > 0);
  return {
    typicalPurchaseAmount: median(amounts),
    typicalPurchaseIntervalDays: median(gaps),
    purchaseCount: days.length,
    lastPurchasedAt,
  };
}

function summariseWaste(observations: readonly CleanObservation[]): WasteSummary {
  let used = 0;
  let wasted = 0;
  let wasteEvents = 0;
  let lastFinishedAt: Date | null = null;
  for (const o of observations) {
    used += o.used;
    wasted += o.wasted;
    if (o.wasted > 0 || o.outcome !== "consumed") wasteEvents += 1;
    if (o.outcome === "consumed" && (!lastFinishedAt || o.endedAt > lastFinishedAt)) lastFinishedAt = o.endedAt;
  }
  const total = used + wasted;
  return { wasteRatio: total > 0 ? wasted / total : 0, wasteEvents, lastFinishedAt };
}

function isStapleProduct(purchases: PurchaseSummary, now: Date): boolean {
  const { purchaseCount, typicalPurchaseIntervalDays: interval, lastPurchasedAt } = purchases;
  if (purchaseCount < STAPLE_MIN_PURCHASES || interval === null || interval > STAPLE_MAX_INTERVAL_DAYS) return false;
  return lastPurchasedAt !== null && daysBetween(lastPurchasedAt, now) <= STAPLE_RECENCY_INTERVALS * interval;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Learn a household's consumption statistics for one product.
 *
 * Each usable lifecycle becomes a daily rate per adult-equivalent (so a
 * household that grows or shrinks keeps its learning), rescaled to today's
 * household size. Mostly-wasted lifecycles are censored from rate learning
 * but always count as waste; outliers are screened with a robust MAD test.
 * The final `dailyRate` blends a median/recency history rate with the
 * catalog prior (the prior is worth two observations) and applies a
 * seasonal factor once there is most of a year of history.
 *
 * `observations` reports the lifecycles that informed the rate (after
 * censoring and outlier removal). Basis, confidence and the pull against the
 * prior weigh them as evidence: a partly used, binned lifecycle is worth half
 * a finished one, so `basis` is "history" from two finished lifecycles (or
 * four half-used ones).
 */
export function computeConsumptionStats(input: ConsumptionStatsInput): ConsumptionStats {
  const householdSize = positiveOr(input.householdSize, 1);
  const clean = input.observations
    .map((o) => cleanObservation(o, householdSize))
    .filter((o): o is CleanObservation => o !== null);

  const samples = clean.map((o) => toRateSample(o, householdSize)).filter((s): s is RateSample => s !== null);
  const { kept, excluded } = excludeOutliers(samples);
  const n = kept.length;
  const weighted = asWeighted(kept);
  const evidence = weighted.reduce((sum, w) => sum + w.weight, 0);

  const historyMedianRate = weightedMedian(weighted);
  const historyMeanRate = weightedMean(weighted);
  const recentRate = n > 0 ? recencyWeightedRate(kept, input.now) : null;
  const variability = weightedCv(weighted);
  const seasonalFactor = seasonalFactorFor(kept, input.now, historyMeanRate);

  const priorPerPerson = input.priorDailyPerPerson;
  const priorRate = isFiniteNumber(priorPerPerson) && priorPerPerson > 0 ? priorPerPerson * householdSize : null;
  const dailyRate = blendDailyRate({ evidence, medianRate: historyMedianRate, recentRate, priorRate, seasonalFactor });

  const learned = atLeast(evidence, MIN_HISTORY_OBSERVATIONS) && dailyRate !== null;
  const basis: PredictionBasis = learned ? "history" : "estimate";
  const confidence: Confidence = basis === "history" ? historyConfidence(evidence, variability) : "low";
  const purchases = summarisePurchases(input.purchases);

  return {
    baseUnit: input.baseUnit,
    observations: n,
    outliersExcluded: excluded,
    dailyRate,
    historyMedianRate,
    historyMeanRate,
    recentRate,
    priorRate,
    variability,
    seasonalFactor,
    ...purchases,
    ...summariseWaste(clean),
    basis,
    confidence,
    isStaple: isStapleProduct(purchases, input.now),
  };
}
