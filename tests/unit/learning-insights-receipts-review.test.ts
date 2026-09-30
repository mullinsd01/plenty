/**
 * Regression tests from an adversarial review of learning, prediction,
 * insights and receipt parsing. Each block pins a defect that was found and
 * fixed; the scenario in each test is the one that exposed it.
 */
import { describe, expect, it } from "vitest";
import { computeConsumptionStats } from "@/lib/consumption/stats";
import type { BatchState, ConsumptionObservation, ConsumptionStatsInput } from "@/lib/consumption/types";
import { computeShoppingRhythm, spendSummary } from "@/lib/insights";
import { predictRunOut, type PredictionStats } from "@/lib/prediction/engine";
import { parseReceiptText } from "@/lib/receipts/parse";

const DAY = 86_400_000;
const NOW = new Date("2026-09-30T09:00:00Z");
const TODAY = "2026-09-30";

interface ObsSpec {
  endedDaysAgo: number;
  durationDays: number;
  used: number;
  wasted?: number;
  outcome?: ConsumptionObservation["outcome"];
}

function observation({ endedDaysAgo, durationDays, used, wasted = 0, outcome = "consumed" }: ObsSpec): ConsumptionObservation {
  const endedAt = new Date(NOW.getTime() - endedDaysAgo * DAY);
  return {
    amountUsedBase: used,
    amountWastedBase: wasted,
    durationDays,
    startedAt: new Date(endedAt.getTime() - durationDays * DAY),
    endedAt,
    outcome,
    householdSize: 2,
  };
}

function stats(overrides: Partial<ConsumptionStatsInput>) {
  return computeConsumptionStats({
    baseUnit: "each",
    observations: [],
    purchases: [],
    priorDailyPerPerson: null,
    householdSize: 2,
    now: NOW,
    ...overrides,
  });
}

// ─── Consumption learning ───────────────────────────────────────────────────

describe("computeConsumptionStats — partly used, binned lifecycles are partial evidence", () => {
  /** A bunch of coriander that went off after six days with 40% used. */
  const binnedBunch = (endedDaysAgo: number) =>
    observation({ endedDaysAgo, durationDays: 6, used: 0.4, wasted: 0.6, outcome: "expired" });

  it("won't predict a custom product from two half-used bunches when one finished bunch isn't enough", () => {
    // A custom product has no catalog prior, so history alone must justify a prediction.
    const oneFinished = stats({ observations: [observation({ endedDaysAgo: 3, durationDays: 6, used: 1 })] });
    expect(oneFinished.dailyRate).toBeNull();

    // Each binned bunch is worth half a finished one, so two of them are no more evidence.
    const twoBinned = stats({ observations: [binnedBunch(12), binnedBunch(3)] });
    expect(twoBinned.observations).toBe(2);
    expect(twoBinned.historyMedianRate).toBeCloseTo(0.4 / 6, 9);
    expect(twoBinned.dailyRate).toBeNull();
    expect(twoBinned.basis).toBe("estimate");
    expect(twoBinned.confidence).toBe("low");
  });

  it("learns from four half-used bunches, the equivalent of two finished ones", () => {
    const four = stats({ observations: [binnedBunch(30), binnedBunch(21), binnedBunch(12), binnedBunch(3)] });
    expect(four.dailyRate).toBeCloseTo(0.4 / 6, 9);
    expect(four.basis).toBe("history");
    expect(four.confidence).toBe("medium");
  });

  it("doesn't claim high confidence from five lifecycles that mostly ended in the bin", () => {
    const five = stats({ observations: [39, 30, 21, 12, 3].map(binnedBunch) });
    expect(five.observations).toBe(5);
    expect(five.variability).toBe(0);
    // Five finished bunches would be "high"; five half-used ones are 2.5 bunches of evidence.
    expect(five.confidence).toBe("medium");
    const finished = stats({
      observations: [39, 30, 21, 12, 3].map((ago) => observation({ endedDaysAgo: ago, durationDays: 6, used: 1 })),
    });
    expect(finished.confidence).toBe("high");
  });

  it("gives a half-used lifecycle half the pull against Plenty's prior", () => {
    // Prior: 100 ml/person/day → 200 ml/day. Both lifecycles say 500 ml/day.
    const mixed = stats({
      baseUnit: "ml",
      priorDailyPerPerson: 100,
      observations: [
        observation({ endedDaysAgo: 9, durationDays: 4, used: 2000 }),
        observation({ endedDaysAgo: 3, durationDays: 2, used: 1000, wasted: 1000, outcome: "wasted" }),
      ],
    });
    // 1.5 observations of evidence against a prior worth 2: w = 1.5 / 3.5.
    expect(mixed.dailyRate).toBeCloseTo(200 + (500 - 200) * (1.5 / 3.5), 6);
    expect(mixed.basis).toBe("estimate");
  });
});

describe("computeConsumptionStats — lifecycles without a usable length", () => {
  const bottle = (endedDaysAgo: number) => observation({ endedDaysAgo, durationDays: 4, used: 2000 });

  it("derives an unknown length from the start and end dates instead of assuming half a day", () => {
    const unknownLength: ConsumptionObservation = { ...bottle(1), durationDays: Number.NaN };
    const result = stats({ baseUnit: "ml", observations: [bottle(6), unknownLength] });
    expect(result.historyMedianRate).toBeCloseTo(500, 6);
    expect(result.dailyRate).toBeCloseTo(500, 6);
  });

  it("doesn't learn a rate from a lifecycle whose length can't be known", () => {
    const undatable: ConsumptionObservation = { ...bottle(1), durationDays: Number.NaN, startedAt: new Date(Number.NaN) };
    const backwards: ConsumptionObservation = {
      ...bottle(2),
      durationDays: -3,
      startedAt: new Date(NOW.getTime() + DAY),
    };
    const result = stats({ baseUnit: "ml", observations: [bottle(10), bottle(6), undatable, backwards] });
    expect(result.observations).toBe(2);
    expect(result.historyMedianRate).toBeCloseTo(500, 6);
    expect(result.historyMeanRate).toBeCloseTo(500, 6);
    // They still happened: the waste summary sees all four lifecycles.
    expect(result.lastFinishedAt?.getTime()).toBe(NOW.getTime() - DAY);
  });
});

// ─── Run-out prediction ─────────────────────────────────────────────────────

describe("predictRunOut — uncertainty grows with time since the level was last known", () => {
  /** Plenty's starting estimate for milk: 400 ml a day, ±50%. */
  const estimate: PredictionStats = {
    dailyRate: 400,
    basis: "estimate",
    confidence: "low",
    variability: null,
    observations: 0,
    baseUnit: "ml",
    typicalPurchaseAmount: null,
  };

  function milk(boughtDaysAgo: number, levelDaysAgo = boughtDaysAgo, fraction = 1): BatchState {
    return {
      itemId: "milk",
      quantityBase: 2000,
      knownFraction: fraction,
      purchasedAt: new Date(NOW.getTime() - boughtDaysAgo * DAY),
      levelUpdatedAt: new Date(NOW.getTime() - levelDaysAgo * DAY),
      expiresAt: null,
    };
  }

  const predict = (batch: BatchState, stats: PredictionStats = estimate) =>
    predictRunOut({ batches: [batch], stats, productName: "Milk", householdSize: 2, now: NOW });

  it("doesn't say 'about 1 day' four days into a ±50% estimate of a five-day bottle", () => {
    const p = predict(milk(4))!;
    expect(p.daysRemaining).toBeCloseTo(1, 9);
    // The bottle lasts 2.5–7.5 days in all, so anywhere from none to 3.5 days are left.
    expect(p.daysLow).toBe(0);
    expect(p.daysHigh).toBeCloseTo(3.5, 9);
    expect(p.label).toBe("up to 4 days");
  });

  it("never narrows around the point estimate as the estimate ages", () => {
    // Previously the margin shrank with what was left (2.5, 2, 1.5, 1 days), so an
    // older, more extrapolated guess looked *more* certain.
    for (const ago of [0, 1, 2, 3, 4]) {
      const p = predict(milk(ago))!;
      expect(p.daysHigh - p.daysRemaining).toBeCloseTo(2.5, 9);
      expect(p.daysLow).toBeCloseTo(Math.max(0, p.daysRemaining - 2.5), 9);
    }
    expect(predict(milk(3))!.label).toBe("up to 5 days");
  });

  it("matches the plain ±spread band right after a purchase or check-in", () => {
    const fresh = predict(milk(0))!;
    expect(fresh.daysLow).toBeCloseTo(2.5, 9);
    expect(fresh.daysHigh).toBeCloseTo(7.5, 9);
    // Bought ten days ago, but the household said "half full" just now.
    const checked = predict(milk(10, 0, 0.5))!;
    expect(checked.daysLow).toBeCloseTo(1.25, 9);
    expect(checked.daysHigh).toBeCloseTo(3.75, 9);
  });

  it("measures the extrapolation from the latest confirmed level, not the purchase", () => {
    // Half full a day ago → 1 L then, 600 ml now: 1.5 days left of a 2.5-day stretch (±50% → ±1.25).
    const p = predict(milk(10, 1, 0.5))!;
    expect(p.daysRemaining).toBeCloseTo(1.5, 9);
    expect(p.daysLow).toBeCloseTo(0.25, 9);
    expect(p.daysHigh).toBeCloseTo(2.75, 9);
  });

  it("applies the same logic to learned history", () => {
    const history: PredictionStats = { ...estimate, basis: "history", confidence: "high", variability: 0.1, observations: 8 };
    const p = predict(milk(3), history)!;
    // 5-day bottle ±10% → ±0.5 days around the 2 days left.
    expect(p.daysLow).toBeCloseTo(1.5, 9);
    expect(p.daysHigh).toBeCloseTo(2.5, 9);
    expect(p.label).toBe("about 2 days");
  });
});

// ─── Shopping rhythm ────────────────────────────────────────────────────────

describe("computeShoppingRhythm — a single gap is not a rhythm", () => {
  it("doesn't tell a new household it shops every 3 days after a big shop and one top-up", () => {
    const r = computeShoppingRhythm({
      purchaseDates: ["2026-09-26", "2026-09-29"],
      today: TODAY,
      usualShopDay: null,
      shopIntervalDays: null,
    });
    expect(r.basis).toBe("history");
    expect(r.confidence).toBe("low");
    expect(r.label).toBeNull();
    // Falls back to the weekly default rather than a 3-day cycle learned from one gap.
    expect(r.intervalDays).toBe(7);
    expect(r.nextShopDate).toBe("2026-10-06");
  });

  it("learns the interval once there are two gaps to go on", () => {
    const r = computeShoppingRhythm({
      purchaseDates: ["2026-09-19", "2026-09-24", "2026-09-29"],
      today: TODAY,
      usualShopDay: null,
      shopIntervalDays: null,
    });
    expect(r.intervalDays).toBe(5);
    expect(r.label).toBe("You shop about every 5 days");
    expect(r.nextShopDate).toBe("2026-10-04");
  });
});

// ─── Spend ──────────────────────────────────────────────────────────────────

describe("spendSummary — budget wording agrees with the rounded figures it shows", () => {
  const weeks = (total: number) =>
    ["2026-09-05", "2026-09-12", "2026-09-19", "2026-09-26"].map((date) => ({ date, total }));

  it("doesn't say 'about $200 a week, over your $200 budget'", () => {
    const summary = spendSummary({ receipts: weeks(201.3), today: TODAY, weeklyBudget: 200 });
    expect(summary.overBudgetWeeks).toBe(4);
    expect(summary.label).toBe("You spend about $200 a week, right on your $200 budget");
  });

  it("doesn't say 'about $200 a week, within your $198 budget'", () => {
    const summary = spendSummary({ receipts: weeks(197.6), today: TODAY, weeklyBudget: 198 });
    expect(summary.label).toBe("You spend about $200 a week, right on your $198 budget");
  });

  it("still reports clearly over or under", () => {
    expect(spendSummary({ receipts: weeks(203), today: TODAY, weeklyBudget: 200 }).label).toBe(
      "You spend about $205 a week, over your $200 budget",
    );
    expect(spendSummary({ receipts: weeks(197.4), today: TODAY, weeklyBudget: 200 }).label).toBe(
      "You spend about $195 a week, within your $200 budget",
    );
    expect(spendSummary({ receipts: weeks(197.5), today: TODAY, weeklyBudget: 200 }).label).toBe(
      "You spend about $200 a week, within your $200 budget",
    );
    expect(spendSummary({ receipts: weeks(30.2), today: TODAY, weeklyBudget: 30, currency: "GBP" }).label).toBe(
      "You spend about £30 a week, right on your £30 budget",
    );
  });
});

// ─── Receipt parsing ────────────────────────────────────────────────────────

describe("parseReceiptText — products named like payment-terminal fields", () => {
  it("keeps items whose names start with a card-terminal code or 'SNAP'", () => {
    const text = [
      "WALMART",
      "PAN DULCE 2.98",
      "SNAP PEAS 8OZ 2.50",
      "MID STRENGTH LAGER 6PK 12.00",
      "MILK 3.12",
      "TOTAL 20.60",
      "09/26/2026 18:45",
    ].join("\n");
    const parsed = parseReceiptText(text, { today: TODAY });
    expect(parsed.lines.map((l) => [l.description, l.price])).toEqual([
      ["PAN DULCE", 2.98],
      ["SNAP PEAS 8OZ", 2.5],
      ["MID STRENGTH LAGER 6PK", 12],
      ["MILK", 3.12],
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it("doesn't turn 'Regular Price' reference lines into phantom items", () => {
    const target = [
      "TARGET",
      "212040001 MP ORANGE JUICE NF $2.99",
      "    Regular Price $3.49",
      "GG WHOLE MILK $3.49",
      "  REG PRICE 3.99",
      "  YOU SAVED 0.50",
      "ORIGINAL PRICE 4.29",
      "WAS $6.00 NOW $4.00",
      "SUBTOTAL $6.48",
      "TOTAL $6.48",
      "09/26/2026 18:45",
    ].join("\n");
    const parsed = parseReceiptText(target, { today: TODAY });
    expect(parsed.lines.map((l) => [l.description, l.price])).toEqual([
      ["MP ORANGE JUICE NF", 2.99],
      ["GG WHOLE MILK", 3.49],
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it("still skips EFTPOS slip fields and SNAP benefit lines, even without a total to stop at", () => {
    const text = [
      "WALMART",
      "MILK 3.12",
      "BREAD 1.42",
      "AID A0000000031010",
      "PAN ****1234 0.00",
      "TVR 0000008000",
      "TID 12345678 1.00",
      "MID: 123456789",
      "STAN 004512 2.00",
      "SNAP BAL 12.34",
      "SNAP ELIGIBLE 4.54",
      "SNAP 4.54",
      "09/26/2026 18:45",
    ].join("\n");
    const parsed = parseReceiptText(text, { today: TODAY });
    expect(parsed.lines.map((l) => l.description)).toEqual(["MILK", "BREAD"]);
  });
});
