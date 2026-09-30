/**
 * Run-out prediction.
 *
 * Simulates how a household draws down its active batches of a product —
 * oldest first, anchored on the latest level each batch was given — then
 * turns what's left into an honest, deliberately imprecise estimate. When
 * the simulation says something is gone but nobody has confirmed it, Plenty
 * asks ("Did you finish the milk?") instead of assuming.
 */

import type { BatchState, ConsumptionStats, RunOutPrediction } from "@/lib/consumption/types";
import { addDaysToInstant, DAY_MS } from "@/lib/dates";
import { formatAmount, formatBase, type BaseUnit } from "@/lib/units";
import { formatDaysRemaining, formatDuration } from "@/lib/prediction/labels";

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Relative spread (±) of a prior-only estimate. */
export const ESTIMATE_SPREAD = 0.5;
/** Spread assumed for history with no measured variability. */
export const DEFAULT_VARIABILITY = 0.35;
export const MIN_SPREAD = 0.1;
export const MAX_SPREAD = 0.8;
/** With fewer observations than this, widen the spread… */
export const FEW_OBSERVATIONS = 3;
/** …by this factor. */
export const FEW_OBSERVATIONS_SPREAD_FACTOR = 1.25;
/** "Nearly gone": at most this fraction of the newest batch left… */
export const CHECK_IN_FRACTION_OF_NEWEST = 0.05;
/** …or less than this many days of use. */
export const CHECK_IN_MAX_DAYS = 0.35;

const ESTIMATE_REASON =
  "Plenty's starting estimate for a household of your size. It gets sharper each time you finish one.";
const ONE_PERSON_ESTIMATE_REASON =
  "Plenty's starting estimate for one person. It gets sharper each time you finish one.";
/** Amounts below this are treated as nothing left (float noise). */
const EMPTY_EPSILON = 1e-9;

// ─── Types ──────────────────────────────────────────────────────────────────

/** The learned statistics a prediction needs. */
export type PredictionStats = Pick<
  ConsumptionStats,
  "dailyRate" | "basis" | "confidence" | "variability" | "observations" | "baseUnit" | "typicalPurchaseAmount"
>;

export interface PredictRunOutInput {
  batches: BatchState[];
  stats: PredictionStats;
  productName: string;
  /** Current adult-equivalents; only shapes the wording of estimates. */
  householdSize: number;
  now: Date;
}

/** Result of the FIFO draw-down simulation. */
export interface BatchSimulation {
  /** Estimated fraction remaining per batch at `now` (0–1), keyed by itemId. */
  fractions: Record<string, number>;
  /** Estimated total left at `now`, base units. */
  remainingBase: number;
  /** The most recent level snapshot (purchase, adjustment, check-in); null without batches. */
  lastSnapshotAt: Date | null;
  /** Total left immediately after the most recent snapshot was applied, base units. */
  remainingAtLastSnapshot: number;
}

interface SimBatch {
  itemId: string;
  quantity: number;
  knownFraction: number;
  /** FIFO ordering key. */
  purchasedMs: number;
  /** When the batch is known to exist in the household (never after its snapshot). */
  startMs: number;
  snapshotMs: number;
  snapshotLevel: number;
  /** Simulated amount left; null until the snapshot has been applied. */
  level: number | null;
}

// ─── Simulation ─────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampFraction(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

function timeOr(value: Date, fallback: number): number {
  const ms = value instanceof Date ? value.getTime() : Number.NaN;
  return Number.isNaN(ms) ? fallback : ms;
}

function toSimBatch(batch: BatchState, nowMs: number): SimBatch {
  const quantity = Number.isFinite(batch.quantityBase) && batch.quantityBase > 0 ? batch.quantityBase : 0;
  const knownFraction = clampFraction(batch.knownFraction);
  const snapshotMs = Math.min(timeOr(batch.levelUpdatedAt, nowMs), nowMs);
  const purchasedMs = Math.min(timeOr(batch.purchasedAt, snapshotMs), nowMs);
  return {
    itemId: batch.itemId,
    quantity,
    knownFraction,
    purchasedMs,
    startMs: Math.min(purchasedMs, snapshotMs),
    snapshotMs,
    snapshotLevel: knownFraction * quantity,
    level: null,
  };
}

function compareFifo(a: SimBatch, b: SimBatch): number {
  return a.purchasedMs - b.purchasedMs || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0);
}

/**
 * The batch the household is drawing from at `t`: the oldest one that is
 * either simulated with something left, or not yet at its snapshot but
 * confirmed non-empty there. Consumption drawn from the latter is absorbed
 * (its snapshot already accounts for it), so a newer batch isn't touched
 * while an older one is known to still be in use.
 */
function drawTarget(sims: readonly SimBatch[], t: number): SimBatch | null {
  for (const s of sims) {
    if (s.level !== null && s.level > EMPTY_EPSILON) return s;
    if (s.level === null && s.startMs <= t && s.snapshotLevel > EMPTY_EPSILON) return s;
  }
  return null;
}

/** Consume continuously from `from` to `to`, moving to the next batch as each empties. */
function drawDown(sims: readonly SimBatch[], from: number, to: number, ratePerMs: number): void {
  let t = from;
  while (t < to && ratePerMs > 0) {
    const target = drawTarget(sims, t);
    if (!target || target.level === null) return;
    const msToEmpty = target.level / ratePerMs;
    if (t + msToEmpty >= to) {
      target.level = Math.max(0, target.level - ratePerMs * (to - t));
      return;
    }
    target.level = 0;
    t += msToEmpty;
  }
}

/** Apply every snapshot due by `t`; true when any was applied. */
function applySnapshots(sims: readonly SimBatch[], t: number): boolean {
  let applied = false;
  for (const s of sims) {
    if (s.level === null && s.snapshotMs <= t) {
      s.level = s.snapshotLevel;
      applied = true;
    }
  }
  return applied;
}

function poolLevel(sims: readonly SimBatch[]): number {
  return sims.reduce((sum, s) => sum + (s.level ?? 0), 0);
}

/**
 * FIFO draw-down simulation of a product's active batches.
 *
 * Each batch's `knownFraction` is a snapshot taken at `levelUpdatedAt`. From
 * the earliest snapshot until `now`, the household uses `dailyRate`
 * continuously from the oldest batch (by `purchasedAt`) that has something
 * left; a batch's snapshot resets its level at that moment, because
 * user-confirmed information supersedes the simulation. An older batch
 * whose (later) snapshot says it still had some left was in use until then,
 * so newer batches aren't drawn from in the meantime. Timestamps after
 * `now` are treated as `now`.
 */
export function simulateBatches(batches: readonly BatchState[], dailyRate: number, now: Date): BatchSimulation {
  const nowMs = now.getTime();
  const sims = batches.map((b) => toSimBatch(b, nowMs)).sort(compareFifo);
  if (sims.length === 0) return { fractions: {}, remainingBase: 0, lastSnapshotAt: null, remainingAtLastSnapshot: 0 };

  const ratePerMs = Number.isFinite(dailyRate) && dailyRate > 0 ? dailyRate / DAY_MS : 0;
  const firstSnapshot = Math.min(...sims.map((s) => s.snapshotMs));
  const checkpoints = [...new Set([...sims.map((s) => s.startMs), ...sims.map((s) => s.snapshotMs), nowMs])]
    .filter((ms) => ms > firstSnapshot)
    .sort((a, b) => a - b);

  applySnapshots(sims, firstSnapshot);
  let lastSnapshotMs = firstSnapshot;
  let remainingAtLastSnapshot = poolLevel(sims);
  let t = firstSnapshot;
  for (const checkpoint of checkpoints) {
    drawDown(sims, t, checkpoint, ratePerMs);
    t = checkpoint;
    if (applySnapshots(sims, t)) {
      lastSnapshotMs = t;
      remainingAtLastSnapshot = poolLevel(sims);
    }
  }

  const fractions: Record<string, number> = {};
  for (const s of sims) {
    fractions[s.itemId] = s.quantity > 0 ? clampFraction((s.level ?? 0) / s.quantity) : s.knownFraction;
  }
  return {
    fractions,
    remainingBase: poolLevel(sims),
    lastSnapshotAt: new Date(lastSnapshotMs),
    remainingAtLastSnapshot,
  };
}

/**
 * Estimated fraction left in each batch right now (keyed by itemId), for
 * per-item display. Without a usable rate the last known levels are returned.
 */
export function estimateBatchFractions(
  batches: readonly BatchState[],
  dailyRate: number | null,
  now: Date,
): Record<string, number> {
  return simulateBatches(batches, dailyRate ?? 0, now).fractions;
}

// ─── Prediction ─────────────────────────────────────────────────────────────

/** Relative ± spread of the days estimate: wider for priors, noisy or thin history. */
function relativeSpread(stats: PredictionStats): number {
  if (stats.basis === "estimate") return ESTIMATE_SPREAD;
  const spread = clamp(stats.variability ?? DEFAULT_VARIABILITY, MIN_SPREAD, MAX_SPREAD);
  return stats.observations < FEW_OBSERVATIONS ? spread * FEW_OBSERVATIONS_SPREAD_FACTOR : spread;
}

/**
 * Pessimistic/optimistic days left. The spread applies to how long the stock
 * lasts from its latest confirmed level (purchase, adjustment or check-in) —
 * not merely to what the simulation says is left — so the band widens, rather
 * than shrinks, the longer Plenty has been extrapolating from an uncertain
 * rate. Right after a snapshot it is simply `daysRemaining × (1 ± spread)`.
 */
function daysBand(
  sim: BatchSimulation,
  dailyRate: number,
  daysRemaining: number,
  spread: number,
): { daysLow: number; daysHigh: number } {
  const lastsFromSnapshot = Math.max(daysRemaining, sim.remainingAtLastSnapshot / dailyRate);
  const margin = spread * lastsFromSnapshot;
  return { daysLow: Math.max(0, daysRemaining - margin), daysHigh: daysRemaining + margin };
}

function describeAmount(amount: number, unit: BaseUnit): string {
  if (unit !== "each") return formatBase(amount, unit);
  return Math.abs(amount - 1) < 0.05 ? "one of these" : `${formatAmount(amount)} of these`;
}

/** Plain-language explanation of where the estimate comes from. */
function explainBasis(stats: PredictionStats, dailyRate: number, householdSize: number): string {
  if (stats.basis === "estimate") return householdSize <= 1 ? ONE_PERSON_ESTIMATE_REASON : ESTIMATE_REASON;
  const typical = stats.typicalPurchaseAmount;
  if (typical !== null && Number.isFinite(typical) && typical > 0) {
    return `You usually get through ${describeAmount(typical, stats.baseUnit)} in about ${formatDuration(typical / dailyRate)}.`;
  }
  return stats.observations === 1
    ? "Based on the last time you finished it."
    : `Based on the last ${stats.observations} times you finished it.`;
}

/** Quantity of the most recently purchased batch (0 when none has a quantity). */
function newestQuantity(batches: readonly BatchState[]): number {
  let newest: { ms: number; quantity: number } | null = null;
  for (const b of batches) {
    if (!(Number.isFinite(b.quantityBase) && b.quantityBase > 0)) continue;
    const ms = timeOr(b.purchasedAt, Number.NEGATIVE_INFINITY);
    if (!newest || ms > newest.ms) newest = { ms, quantity: b.quantityBase };
  }
  return newest?.quantity ?? 0;
}

/**
 * Plenty believes the product is (nearly) gone, but nothing the household
 * told us since says so: the pool was above the "nearly gone" line right
 * after the latest snapshot and has been simulated down past it since. Also
 * true when a level the user set as already nearly gone has since been
 * simulated all the way to empty.
 */
function shouldCheckIn(sim: BatchSimulation, batches: readonly BatchState[], dailyRate: number): boolean {
  const threshold = Math.max(CHECK_IN_FRACTION_OF_NEWEST * newestQuantity(batches), CHECK_IN_MAX_DAYS * dailyRate);
  if (sim.remainingBase > threshold) return false;
  if (sim.remainingAtLastSnapshot > threshold) return true;
  return sim.remainingBase <= EMPTY_EPSILON && sim.remainingAtLastSnapshot > EMPTY_EPSILON;
}

/**
 * Predict when a product will run out.
 *
 * Returns null when there's nothing on hand (no batch with a quantity and a
 * level above zero) or no usable daily rate. Otherwise simulates the batches
 * (see `simulateBatches`) and reports days remaining with a low/high band:
 * ±50% for estimates, ±variability (10–80%, widened ×1.25 below three
 * observations) for history, applied to how long the stock lasts from its
 * latest confirmed level (see `daysBand`). The label avoids false precision and the
 * reason explains the basis in plain language.
 */
export function predictRunOut(input: PredictRunOutInput): RunOutPrediction | null {
  const { batches, stats, now } = input;
  const dailyRate = stats.dailyRate;
  if (dailyRate === null || !Number.isFinite(dailyRate) || dailyRate <= 0) return null;
  const hasStock = batches.some((b) => b.quantityBase > 0 && b.knownFraction > 0);
  if (!hasStock) return null;

  const sim = simulateBatches(batches, dailyRate, now);
  const daysRemaining = sim.remainingBase / dailyRate;
  const { daysLow, daysHigh } = daysBand(sim, dailyRate, daysRemaining, relativeSpread(stats));

  return {
    remainingBase: sim.remainingBase,
    batchFractions: sim.fractions,
    dailyRate,
    daysRemaining,
    daysLow,
    daysHigh,
    runOutAt: addDaysToInstant(now, daysRemaining),
    confidence: stats.confidence,
    basis: stats.basis,
    label: formatDaysRemaining(daysRemaining, { low: daysLow, high: daysHigh, confidence: stats.confidence }),
    reason: explainBasis(stats, dailyRate, input.householdSize),
    needsCheckIn: shouldCheckIn(sim, batches, dailyRate),
  };
}
