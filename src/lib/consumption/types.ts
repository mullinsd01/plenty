import type { Confidence, ConsumptionOutcome, PredictionBasis } from "@/lib/domain";
import type { BaseUnit } from "@/lib/units";

/** One completed lifecycle of a product in the household (bought → finished/wasted/expired). */
export interface ConsumptionObservation {
  /** Amount actually used, in base units (excludes the wasted part). */
  amountUsedBase: number;
  amountWastedBase: number;
  durationDays: number;
  startedAt: Date;
  endedAt: Date;
  outcome: ConsumptionOutcome;
  /** Adult-equivalents in the household at the time. */
  householdSize: number;
}

export interface PurchaseObservation {
  purchasedAt: Date;
  /** Amount bought, in base units. */
  amountBase: number;
}

export interface ConsumptionStatsInput {
  baseUnit: BaseUnit;
  observations: ConsumptionObservation[];
  purchases: PurchaseObservation[];
  /**
   * Prior daily use for ONE adult-equivalent in base units/day (catalog
   * `dailyUsePerPerson` converted to base). Null if the product has no prior.
   */
  priorDailyPerPerson: number | null;
  /** Current adult-equivalents. */
  householdSize: number;
  now: Date;
}

export interface ConsumptionStats {
  baseUnit: BaseUnit;
  /** Observations considered (after dropping unusable ones). */
  observations: number;
  outliersExcluded: number;
  /** Blended rate used for predictions (base units/day, current household size, seasonally adjusted). Null = can't predict. */
  dailyRate: number | null;
  historyMedianRate: number | null;
  historyMeanRate: number | null;
  /** Exponentially recency-weighted rate. */
  recentRate: number | null;
  /** Prior scaled to current household size. */
  priorRate: number | null;
  /** Coefficient of variation of observed rates (null with < 2 observations). */
  variability: number | null;
  /** Multiplier for the current month (1 when not enough data). */
  seasonalFactor: number;
  typicalPurchaseAmount: number | null;
  typicalPurchaseIntervalDays: number | null;
  purchaseCount: number;
  /** Wasted / (used + wasted), 0–1. */
  wasteRatio: number;
  wasteEvents: number;
  lastPurchasedAt: Date | null;
  lastFinishedAt: Date | null;
  basis: PredictionBasis;
  confidence: Confidence;
  /** Bought repeatedly and regularly — a household staple. */
  isStaple: boolean;
}

/** One active batch of a product, as known right now. */
export interface BatchState {
  itemId: string;
  /** Purchased amount in base units. */
  quantityBase: number;
  /** Last known fraction remaining (0–1). */
  knownFraction: number;
  /** When `knownFraction` was last set (purchase, user adjustment, check-in). */
  levelUpdatedAt: Date;
  purchasedAt: Date;
  /** Effective expiry instant (end of expiry day), if any. */
  expiresAt: Date | null;
}

export interface RunOutPrediction {
  /** Estimated amount left right now, base units. */
  remainingBase: number;
  /** Per-batch estimated fraction remaining right now, keyed by itemId. */
  batchFractions: Record<string, number>;
  dailyRate: number;
  daysRemaining: number;
  daysLow: number;
  daysHigh: number;
  runOutAt: Date;
  confidence: Confidence;
  basis: PredictionBasis;
  /** Human, avoids false precision: "about 2 days", "probably today", "about a week". */
  label: string;
  /** Plain-language explanation of the basis, e.g. "You usually get through 2 L in about 4 days." */
  reason: string;
  /** Plenty believes it's (nearly) gone and should ask "Did you finish the milk?" rather than assume. */
  needsCheckIn: boolean;
}
