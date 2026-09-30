import { describe, expect, it } from "vitest";
import {
  estimateBatchFractions,
  predictRunOut,
  simulateBatches,
  type PredictionStats,
  type PredictRunOutInput,
} from "@/lib/prediction/engine";
import { formatDaysRemaining, formatDaysShort, formatDuration } from "@/lib/prediction/labels";
import type { BatchState } from "@/lib/consumption/types";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-09-30T09:00:00Z");

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

interface BatchSpec {
  id: string;
  quantity?: number;
  fraction?: number;
  purchasedAgo: number;
  /** When the level was last set; defaults to the purchase time. */
  levelAgo?: number;
}

function batch({ id, quantity = 2000, fraction = 1, purchasedAgo, levelAgo }: BatchSpec): BatchState {
  return {
    itemId: id,
    quantityBase: quantity,
    knownFraction: fraction,
    purchasedAt: ago(purchasedAgo),
    levelUpdatedAt: ago(levelAgo ?? purchasedAgo),
    expiresAt: null,
  };
}

/** A household that reliably gets through 500 ml of milk a day. */
const milkHistory: PredictionStats = {
  dailyRate: 500,
  basis: "history",
  confidence: "high",
  variability: 0.1,
  observations: 8,
  baseUnit: "ml",
  typicalPurchaseAmount: 2000,
};

const milkEstimate: PredictionStats = {
  dailyRate: 400,
  basis: "estimate",
  confidence: "low",
  variability: null,
  observations: 0,
  baseUnit: "ml",
  typicalPurchaseAmount: null,
};

function predict(batches: BatchState[], stats: PredictionStats = milkHistory, extra: Partial<PredictRunOutInput> = {}) {
  return predictRunOut({ batches, stats, productName: "Milk", householdSize: 2, now: NOW, ...extra });
}

describe("predictRunOut — FIFO across batches", () => {
  it("finishes the old bottle before opening the one bought today", () => {
    const old = batch({ id: "old", purchasedAgo: 3.6 * DAY });
    const fresh = batch({ id: "new", purchasedAgo: 2 * HOUR });
    const prediction = predict([fresh, old]);
    expect(prediction).not.toBeNull();
    const p = prediction!;
    expect(p.batchFractions.old).toBeCloseTo(0.1, 6);
    expect(p.batchFractions.new).toBe(1);
    expect(p.remainingBase).toBeCloseTo(2200, 6);
    expect(p.daysRemaining).toBeCloseTo(4.4, 6);
    expect(p.label).toBe("about 4 days");
    expect(p.needsCheckIn).toBe(false);
    expect(p.runOutAt.getTime()).toBeCloseTo(NOW.getTime() + 4.4 * DAY, -3);
  });

  it("moves on to the newer bottle once the old one is empty", () => {
    const old = batch({ id: "old", purchasedAgo: 5 * DAY });
    const fresh = batch({ id: "new", purchasedAgo: 3 * DAY });
    const p = predict([old, fresh])!;
    // Old: 2 L gone after 4 days. New: drawn for the last day.
    expect(p.batchFractions.old).toBe(0);
    expect(p.batchFractions.new).toBeCloseTo(0.75, 6);
    expect(p.remainingBase).toBeCloseTo(1500, 6);
    expect(p.label).toBe("about 3 days");
  });

  it("orders by purchase date, not by input order or item id", () => {
    const fractions = estimateBatchFractions(
      [batch({ id: "a", purchasedAgo: 1 * DAY }), batch({ id: "z", purchasedAgo: 2 * DAY })],
      500,
      NOW,
    );
    expect(fractions.z).toBeCloseTo(0.5, 6);
    expect(fractions.a).toBe(1);
  });
});

describe("predictRunOut — user-confirmed levels", () => {
  it("lets a check-in override what the simulation assumed", () => {
    // Simulation alone would say this bottle ran out six days ago…
    const unconfirmed = predict([batch({ id: "milk", purchasedAgo: 10 * DAY })])!;
    expect(unconfirmed.remainingBase).toBe(0);
    // …but yesterday the household said it was half full.
    const confirmed = predict([batch({ id: "milk", purchasedAgo: 10 * DAY, fraction: 0.5, levelAgo: 1 * DAY })])!;
    expect(confirmed.batchFractions.milk).toBeCloseTo(0.25, 6);
    expect(confirmed.remainingBase).toBeCloseTo(500, 6);
    expect(confirmed.label).toBe("about 1 day");
    expect(confirmed.needsCheckIn).toBe(false);
  });

  it("does not touch a newer bottle while an older one is confirmed still in use", () => {
    const old = batch({ id: "old", purchasedAgo: 6 * DAY, fraction: 0.5, levelAgo: 12 * HOUR });
    const fresh = batch({ id: "new", purchasedAgo: 2 * DAY });
    const p = predict([old, fresh])!;
    expect(p.batchFractions.new).toBe(1);
    expect(p.batchFractions.old).toBeCloseTo((1000 - 250) / 2000, 6);
    expect(p.remainingBase).toBeCloseTo(2750, 6);
  });

  it("treats timestamps in the future as now", () => {
    const skewed: BatchState = { ...batch({ id: "milk", purchasedAgo: 0, fraction: 0.6 }), levelUpdatedAt: new Date(NOW.getTime() + HOUR) };
    expect(estimateBatchFractions([skewed], 500, NOW).milk).toBeCloseTo(0.6, 6);
  });

  it("returns last known levels when there's no usable rate", () => {
    const batches = [batch({ id: "a", purchasedAgo: 5 * DAY, fraction: 0.4 })];
    expect(estimateBatchFractions(batches, null, NOW)).toEqual({ a: 0.4 });
    expect(estimateBatchFractions(batches, 0, NOW)).toEqual({ a: 0.4 });
  });
});

describe("predictRunOut — check-ins", () => {
  it("asks rather than assumes once the milk is predicted gone", () => {
    const p = predict([batch({ id: "milk", purchasedAgo: 5 * DAY })])!;
    expect(p.remainingBase).toBe(0);
    expect(p.daysRemaining).toBe(0);
    expect(p.label).toBe("probably out now");
    expect(p.needsCheckIn).toBe(true);
  });

  it("asks when only a sliver (≤ 5% of the newest bottle) should be left", () => {
    // 2 L bought 3.85 days ago at 500 ml/day → 75 ml left (3.75%).
    const p = predict([batch({ id: "milk", purchasedAgo: 3.85 * DAY })])!;
    expect(p.remainingBase).toBeCloseTo(75, 6);
    expect(p.needsCheckIn).toBe(true);
  });

  it("also treats less than a third of a day's use as nearly gone", () => {
    // 1 L carton: 5% is 50 ml, but 150 ml is only 0.3 days at 500 ml/day.
    const p = predict([batch({ id: "milk", quantity: 1000, purchasedAgo: 1.7 * DAY })])!;
    expect(p.remainingBase).toBeCloseTo(150, 6);
    expect(p.needsCheckIn).toBe(true);
  });

  it("doesn't ask while there's clearly some left", () => {
    const p = predict([batch({ id: "milk", purchasedAgo: 3.5 * DAY })])!;
    expect(p.remainingBase).toBeCloseTo(250, 6);
    expect(p.needsCheckIn).toBe(false);
  });

  it("doesn't ask when the household just told us it's nearly empty", () => {
    const p = predict([batch({ id: "milk", purchasedAgo: 3 * DAY, fraction: 0.03, levelAgo: 1 * HOUR })])!;
    expect(p.needsCheckIn).toBe(false);
  });

  it("asks again once that last sliver should be long gone", () => {
    const p = predict([batch({ id: "milk", purchasedAgo: 5 * DAY, fraction: 0.03, levelAgo: 2 * DAY })])!;
    expect(p.remainingBase).toBe(0);
    expect(p.needsCheckIn).toBe(true);
  });
});

describe("predictRunOut — uncertainty, basis and wording", () => {
  it("returns null with nothing on hand or no rate", () => {
    expect(predict([])).toBeNull();
    expect(predict([batch({ id: "a", purchasedAgo: DAY, fraction: 0 })])).toBeNull();
    expect(predict([batch({ id: "a", purchasedAgo: DAY, quantity: 0 })])).toBeNull();
    expect(predict([batch({ id: "a", purchasedAgo: DAY })], { ...milkHistory, dailyRate: null })).toBeNull();
    expect(predict([batch({ id: "a", purchasedAgo: DAY })], { ...milkHistory, dailyRate: 0 })).toBeNull();
  });

  it("gives estimates a ±50% band and a range label", () => {
    const p = predict([batch({ id: "milk", purchasedAgo: 2 * HOUR, quantity: 2000 })], milkEstimate)!;
    const days = p.daysRemaining;
    expect(p.basis).toBe("estimate");
    expect(p.daysLow).toBeCloseTo(days * 0.5, 6);
    expect(p.daysHigh).toBeCloseTo(days * 1.5, 6);
    // ~4.98 days, low confidence → 2–7 days rather than a precise-sounding "about 5 days".
    expect(p.label).toBe("2–7 days");
    expect(p.reason).toBe(
      "Plenty's starting estimate for a household of your size. It gets sharper each time you finish one.",
    );
  });

  it("words estimates for one person accordingly", () => {
    const p = predict([batch({ id: "milk", purchasedAgo: 0 })], milkEstimate, { householdSize: 1 })!;
    expect(p.reason).toBe("Plenty's starting estimate for one person. It gets sharper each time you finish one.");
  });

  it("uses measured variability for history, widened when history is thin", () => {
    const batches = [batch({ id: "milk", purchasedAgo: 0 })];
    const steady = predict(batches)!;
    expect(steady.daysRemaining).toBeCloseTo(4, 6);
    expect(steady.daysLow).toBeCloseTo(3.6, 6);
    expect(steady.daysHigh).toBeCloseTo(4.4, 6);

    const thin = predict(batches, { ...milkHistory, observations: 2 })!;
    expect(thin.daysHigh).toBeCloseTo(4 * 1.125, 6);

    const unknown = predict(batches, { ...milkHistory, variability: null })!;
    expect(unknown.daysHigh).toBeCloseTo(4 * 1.35, 6);

    const wild = predict(batches, { ...milkHistory, variability: 3, observations: 2 })!;
    expect(wild.daysLow).toBe(0);
    expect(wild.daysHigh).toBeCloseTo(8, 6);
  });

  it("explains history in terms of the household's usual purchase", () => {
    const p = predict([batch({ id: "milk", purchasedAgo: DAY })])!;
    expect(p.reason).toBe("You usually get through 2 L in about 4 days.");
    expect(p.confidence).toBe("high");
    expect(p.basis).toBe("history");
  });

  it("falls back to the number of finished items without a usual purchase", () => {
    const p = predict([batch({ id: "milk", purchasedAgo: DAY })], { ...milkHistory, typicalPurchaseAmount: null })!;
    expect(p.reason).toBe("Based on the last 8 times you finished it.");
  });

  it("describes counted products without a bare number", () => {
    const eggs: PredictionStats = { ...milkHistory, baseUnit: "each", dailyRate: 2, typicalPurchaseAmount: 12 };
    const p = predict([batch({ id: "eggs", quantity: 12, purchasedAgo: DAY })], eggs)!;
    expect(p.reason).toBe("You usually get through 12 of these in about 6 days.");
    expect(p.label).toBe("about 5 days");
  });
});

describe("simulateBatches", () => {
  it("reports the level right after the latest snapshot", () => {
    const sim = simulateBatches(
      [batch({ id: "old", purchasedAgo: 3 * DAY }), batch({ id: "new", purchasedAgo: 1 * DAY })],
      500,
      NOW,
    );
    expect(sim.lastSnapshotAt?.getTime()).toBe(ago(DAY).getTime());
    expect(sim.remainingAtLastSnapshot).toBeCloseTo(1000 + 2000, 6);
    expect(sim.remainingBase).toBeCloseTo(2500, 6);
  });

  it("handles no batches", () => {
    expect(simulateBatches([], 500, NOW)).toEqual({
      fractions: {},
      remainingBase: 0,
      lastSnapshotAt: null,
      remainingAtLastSnapshot: 0,
    });
  });
});

describe("formatDaysRemaining", () => {
  it.each([
    [0, "probably out now"],
    [0.35, "probably out now"],
    [0.5, "probably today"],
    [0.75, "about 1 day"],
    [1.49, "about 1 day"],
    [1.5, "about 2 days"],
    [4.4, "about 4 days"],
    [6.49, "about 6 days"],
    [6.5, "about a week"],
    [9.9, "about a week"],
    [10, "about 2 weeks"],
    [17.4, "about 2 weeks"],
    [17.5, "about 3 weeks"],
    [24.9, "about 3 weeks"],
    [25, "a month or more"],
    [Number.POSITIVE_INFINITY, "a month or more"],
    [-2, "probably out now"],
  ])("%s days → %s", (days, label) => {
    expect(formatDaysRemaining(days)).toBe(label);
  });

  it("never shows false precision", () => {
    for (let days = 0; days <= 60; days += 0.05) {
      const label = formatDaysRemaining(days, { confidence: "high" });
      expect(label).not.toMatch(/\d\.\d/);
      expect(label).toMatch(/^(probably out now|probably today|about 1 day|about [2-6] days|about a week|about [23] weeks|a month or more)$/);
    }
  });

  it("shows a range for unsure short estimates", () => {
    expect(formatDaysRemaining(3, { low: 1.5, high: 4.5, confidence: "low" })).toBe("2–5 days");
    expect(formatDaysRemaining(1.2, { low: 0.3, high: 2.1, confidence: "low" })).toBe("up to 2 days");
  });

  it("keeps a single figure when the range is narrow, confidence is decent or it's far off", () => {
    expect(formatDaysRemaining(3, { low: 2.6, high: 3.4, confidence: "low" })).toBe("about 3 days");
    expect(formatDaysRemaining(3, { low: 1.5, high: 4.5, confidence: "medium" })).toBe("about 3 days");
    expect(formatDaysRemaining(12, { low: 6, high: 18, confidence: "low" })).toBe("about 2 weeks");
    expect(formatDaysRemaining(0.5, { low: 0, high: 2, confidence: "low" })).toBe("probably today");
  });
});

describe("formatDaysShort and formatDuration", () => {
  it.each([
    [0, "today"],
    [0.7, "today"],
    [1, "1 day"],
    [2.2, "2 days"],
    [10, "10 days"],
    [20, "3 weeks"],
    [7 * 6, "6 weeks"],
    [60, "2 months"],
    [Number.NaN, "today"],
  ])("formatDaysShort(%s) → %s", (days, label) => {
    expect(formatDaysShort(days)).toBe(label);
  });

  it.each([
    [0.4, "a day"],
    [1, "a day"],
    [4, "4 days"],
    [8, "a week"],
    [14, "2 weeks"],
    [21, "3 weeks"],
    [30, "a month"],
    [90, "3 months"],
  ])("formatDuration(%s) → %s", (days, label) => {
    expect(formatDuration(days)).toBe(label);
  });
});
