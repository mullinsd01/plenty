import { describe, expect, it } from "vitest";
import { computeConsumptionStats, median } from "@/lib/consumption/stats";
import type {
  ConsumptionObservation,
  ConsumptionStatsInput,
  PurchaseObservation,
} from "@/lib/consumption/types";

const DAY = 86_400_000;
const NOW = new Date("2026-09-30T09:00:00Z");

function daysBefore(days: number, from: Date = NOW): Date {
  return new Date(from.getTime() - days * DAY);
}

interface ObsSpec {
  /** Days before `now` the lifecycle ended. */
  endedDaysAgo: number;
  durationDays: number;
  used: number;
  wasted?: number;
  outcome?: ConsumptionObservation["outcome"];
  householdSize?: number;
  now?: Date;
}

function observation(spec: ObsSpec): ConsumptionObservation {
  const endedAt = daysBefore(spec.endedDaysAgo, spec.now ?? NOW);
  return {
    amountUsedBase: spec.used,
    amountWastedBase: spec.wasted ?? 0,
    durationDays: spec.durationDays,
    startedAt: new Date(endedAt.getTime() - spec.durationDays * DAY),
    endedAt,
    outcome: spec.outcome ?? "consumed",
    householdSize: spec.householdSize ?? 2,
  };
}

function input(overrides: Partial<ConsumptionStatsInput> = {}): ConsumptionStatsInput {
  return {
    baseUnit: "ml",
    observations: [],
    purchases: [],
    priorDailyPerPerson: 200,
    householdSize: 2,
    now: NOW,
    ...overrides,
  };
}

/**
 * A two-adult household that really gets through a 2 L milk every ~4 days
 * (≈500 ml/day). Plenty's prior says 200 ml/person/day (400 ml/day).
 * Returns ten back-to-back bottle lifecycles, oldest first, ending just
 * before `NOW`.
 */
function milkHistory(): { observations: ConsumptionObservation[]; purchases: PurchaseObservation[] } {
  const durations = [4, 3.8, 4.2, 4, 4.4, 3.6, 4, 4.1, 3.9, 4];
  const observations: ConsumptionObservation[] = [];
  const purchases: PurchaseObservation[] = [];
  let start = daysBefore(durations.reduce((s, d) => s + d, 0) + 0.25);
  for (const d of durations) {
    const endedAt = new Date(start.getTime() + d * DAY);
    purchases.push({ purchasedAt: start, amountBase: 2000 });
    observations.push({
      amountUsedBase: 2000,
      amountWastedBase: 0,
      durationDays: d,
      startedAt: start,
      endedAt,
      outcome: "consumed",
      householdSize: 2,
    });
    start = endedAt;
  }
  return { observations, purchases };
}

describe("median", () => {
  it("handles odd, even, empty and non-finite input", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median([Number.NaN, 5])).toBe(5);
  });
});

describe("computeConsumptionStats — learning a milk household", () => {
  const history = milkHistory();

  /** Stats as they'd be recomputed right after the k-th bottle was finished. */
  function statsAfter(k: number) {
    const now = k === 0 ? history.purchases[0].purchasedAt : history.observations[k - 1].endedAt;
    return computeConsumptionStats(
      input({
        observations: history.observations.slice(0, k),
        purchases: history.purchases.slice(0, Math.min(k + 1, history.purchases.length)),
        now,
      }),
    );
  }

  it("starts from Plenty's estimate scaled to the household", () => {
    const stats = statsAfter(0);
    expect(stats.basis).toBe("estimate");
    expect(stats.confidence).toBe("low");
    expect(stats.priorRate).toBe(400);
    expect(stats.dailyRate).toBe(400);
    expect(stats.observations).toBe(0);
    expect(stats.historyMedianRate).toBeNull();
    expect(stats.variability).toBeNull();
  });

  it("does not trust a single finished bottle, but moves towards it", () => {
    const stats = statsAfter(1);
    expect(stats.basis).toBe("estimate");
    expect(stats.confidence).toBe("low");
    // w = 1/3 → 1/3 × 500 + 2/3 × 400
    expect(stats.dailyRate).toBeCloseTo(433.33, 1);
  });

  it("switches to history with two consistent bottles (medium confidence)", () => {
    const stats = statsAfter(2);
    expect(stats.basis).toBe("history");
    expect(stats.confidence).toBe("medium");
    expect(stats.variability).not.toBeNull();
    expect(stats.variability as number).toBeLessThan(0.25);
  });

  it("reaches high confidence from five consistent bottles", () => {
    expect(statsAfter(4).confidence).toBe("medium");
    expect(statsAfter(5).confidence).toBe("high");
    expect(statsAfter(10).confidence).toBe("high");
  });

  it("converges on the household's real rate as bottles are finished", () => {
    const truth = 500;
    const errors = [1, 3, 5, 10].map((k) => Math.abs((statsAfter(k).dailyRate as number) - truth));
    for (let i = 1; i < errors.length; i++) expect(errors[i]).toBeLessThan(errors[i - 1]);
    const final = statsAfter(10);
    expect(Math.abs((final.dailyRate as number) - truth) / truth).toBeLessThan(0.05);
    expect(final.historyMedianRate as number).toBeCloseTo(500, -1);
    expect(final.observations).toBe(10);
    expect(final.outliersExcluded).toBe(0);
  });

  it("learns the purchase rhythm and marks milk as a staple", () => {
    const stats = statsAfter(10);
    expect(stats.purchaseCount).toBe(10);
    expect(stats.typicalPurchaseAmount).toBe(2000);
    expect(stats.typicalPurchaseIntervalDays).toBe(4);
    expect(stats.isStaple).toBe(true);
    expect(stats.lastFinishedAt?.getTime()).toBe(history.observations[9].endedAt.getTime());
    expect(stats.wasteRatio).toBe(0);
    expect(stats.wasteEvents).toBe(0);
  });
});

describe("computeConsumptionStats — blending and basis", () => {
  it("cannot predict without a prior and fewer than two observations", () => {
    const none = computeConsumptionStats(input({ priorDailyPerPerson: null }));
    expect(none.dailyRate).toBeNull();
    expect(none.basis).toBe("estimate");
    expect(none.confidence).toBe("low");

    const one = computeConsumptionStats(
      input({ priorDailyPerPerson: null, observations: [observation({ endedDaysAgo: 1, durationDays: 4, used: 2000 })] }),
    );
    expect(one.dailyRate).toBeNull();
    expect(one.historyMedianRate).toBe(500);
  });

  it("predicts from history alone when there is no prior", () => {
    const stats = computeConsumptionStats(
      input({
        priorDailyPerPerson: null,
        observations: [
          observation({ endedDaysAgo: 5, durationDays: 4, used: 2000 }),
          observation({ endedDaysAgo: 1, durationDays: 4, used: 2000 }),
        ],
      }),
    );
    expect(stats.dailyRate).toBeCloseTo(500, 6);
    expect(stats.basis).toBe("history");
    expect(stats.priorRate).toBeNull();
  });

  it("treats a zero or invalid prior as no prior", () => {
    expect(computeConsumptionStats(input({ priorDailyPerPerson: 0 })).dailyRate).toBeNull();
    expect(computeConsumptionStats(input({ priorDailyPerPerson: Number.NaN })).priorRate).toBeNull();
  });

  it("scales the prior by adult-equivalents (children count 0.6)", () => {
    const stats = computeConsumptionStats(input({ householdSize: 2.6 }));
    expect(stats.priorRate).toBeCloseTo(520, 6);
    expect(stats.dailyRate).toBeCloseTo(520, 6);
  });

  it("keeps confidence low when history is erratic", () => {
    const stats = computeConsumptionStats(
      input({
        observations: [
          observation({ endedDaysAgo: 20, durationDays: 1.5, used: 2000 }),
          observation({ endedDaysAgo: 12, durationDays: 8, used: 2000 }),
          observation({ endedDaysAgo: 3, durationDays: 3, used: 2000 }),
        ],
      }),
    );
    expect(stats.basis).toBe("history");
    expect(stats.variability as number).toBeGreaterThan(0.6);
    expect(stats.confidence).toBe("low");
  });

  it("weights recent lifecycles more heavily in the recent rate", () => {
    const stats = computeConsumptionStats(
      input({
        observations: [
          observation({ endedDaysAgo: 240, durationDays: 4, used: 1200 }), // 300/day, long ago
          observation({ endedDaysAgo: 200, durationDays: 4, used: 1200 }),
          observation({ endedDaysAgo: 2, durationDays: 4, used: 2400 }), // 600/day, now
        ],
      }),
    );
    expect(stats.historyMeanRate as number).toBeCloseTo(400, 6);
    expect(stats.recentRate as number).toBeGreaterThan(550);
  });
});

describe("computeConsumptionStats — outliers", () => {
  const regular = [30, 26, 22, 18, 14, 10].map((ago, i) =>
    observation({ endedDaysAgo: ago, durationDays: [4, 3.9, 4.1, 4, 4.2, 3.8][i], used: 2000 }),
  );

  it("excludes a party week from rate learning", () => {
    const party = observation({ endedDaysAgo: 6, durationDays: 0.5, used: 2000 }); // 4000 ml/day
    const stats = computeConsumptionStats(input({ observations: [...regular, party] }));
    expect(stats.outliersExcluded).toBe(1);
    expect(stats.observations).toBe(6);
    expect(stats.historyMeanRate as number).toBeLessThan(520);
    expect(stats.confidence).toBe("high");
  });

  it("uses ±50% of the median when most rates are identical (MAD = 0)", () => {
    const same = [40, 32, 24, 16, 8].map((ago) => observation({ endedDaysAgo: ago, durationDays: 4, used: 2000 }));
    const high = observation({ endedDaysAgo: 2, durationDays: 2.5, used: 2000 }); // 800/day, +60%
    const mild = observation({ endedDaysAgo: 1, durationDays: 2000 / 700, used: 2000 }); // 700/day, +40%
    const stats = computeConsumptionStats(input({ observations: [...same, high, mild] }));
    expect(stats.outliersExcluded).toBe(1);
    expect(stats.observations).toBe(6);
  });

  it("does not screen outliers with fewer than four observations", () => {
    const stats = computeConsumptionStats(
      input({
        observations: [
          observation({ endedDaysAgo: 10, durationDays: 4, used: 2000 }),
          observation({ endedDaysAgo: 6, durationDays: 4, used: 2000 }),
          observation({ endedDaysAgo: 2, durationDays: 0.5, used: 2000 }),
        ],
      }),
    );
    expect(stats.outliersExcluded).toBe(0);
    expect(stats.observations).toBe(3);
  });
});

describe("computeConsumptionStats — household size changes", () => {
  it("rescales rates learned with two adults to a household of three", () => {
    const observations = [20, 15, 10, 5].map((ago) =>
      observation({ endedDaysAgo: ago, durationDays: 4, used: 2000, householdSize: 2 }),
    );
    const stats = computeConsumptionStats(input({ observations, householdSize: 3, priorDailyPerPerson: null }));
    expect(stats.historyMedianRate).toBeCloseTo(750, 6);
    expect(stats.dailyRate).toBeCloseTo(750, 6);
  });

  it("recognises consistent per-person use across a growing household", () => {
    const observations = [
      ...[40, 35, 30].map((ago) => observation({ endedDaysAgo: ago, durationDays: 4, used: 2000, householdSize: 2 })),
      ...[12, 8, 4].map((ago) => observation({ endedDaysAgo: ago, durationDays: 2, used: 2000, householdSize: 4 })),
    ];
    const stats = computeConsumptionStats(input({ observations, householdSize: 4 }));
    expect(stats.historyMedianRate).toBeCloseTo(1000, 6);
    expect(stats.variability as number).toBeLessThan(0.01);
    expect(stats.confidence).toBe("high");
    expect(stats.outliersExcluded).toBe(0);
  });

  it("assumes today's household size when an observation's size is missing", () => {
    const stats = computeConsumptionStats(
      input({
        householdSize: 3,
        observations: [observation({ endedDaysAgo: 2, durationDays: 4, used: 2000, householdSize: 0 })],
      }),
    );
    expect(stats.historyMedianRate).toBeCloseTo(500, 6);
  });
});

describe("computeConsumptionStats — waste and censoring", () => {
  // Baby spinach, 120 g bags, one adult.
  const spinach = [
    observation({ endedDaysAgo: 30, durationDays: 5, used: 120, householdSize: 1 }), // 24 g/day
    observation({ endedDaysAgo: 20, durationDays: 7, used: 10, wasted: 110, outcome: "expired", householdSize: 1 }),
    observation({ endedDaysAgo: 10, durationDays: 6, used: 60, wasted: 60, outcome: "wasted", householdSize: 1 }),
    observation({ endedDaysAgo: 3, durationDays: 6, used: 0, wasted: 120, outcome: "wasted", householdSize: 1 }),
  ];

  it("censors mostly-wasted bags but half-weights partly used ones", () => {
    const stats = computeConsumptionStats(
      input({ baseUnit: "g", observations: spinach, householdSize: 1, priorDailyPerPerson: 15 }),
    );
    // Only the consumed bag (24 g/day, weight 1) and the half-used bag (10 g/day, weight 0.5) inform the rate.
    expect(stats.observations).toBe(2);
    expect(stats.historyMeanRate as number).toBeCloseTo((24 + 0.5 * 10) / 1.5, 6);
  });

  it("counts every waste event and the wasted share", () => {
    const stats = computeConsumptionStats(input({ baseUnit: "g", observations: spinach, householdSize: 1 }));
    expect(stats.wasteEvents).toBe(3);
    expect(stats.wasteRatio).toBeCloseTo(290 / 480, 6);
    expect(stats.lastFinishedAt?.getTime()).toBe(spinach[0].endedAt.getTime());
  });

  it("ignores observations with invalid numbers or dates", () => {
    const broken: ConsumptionObservation = { ...spinach[0], amountUsedBase: Number.NaN };
    const undated: ConsumptionObservation = { ...spinach[0], endedAt: new Date(Number.NaN) };
    const stats = computeConsumptionStats(input({ baseUnit: "g", observations: [broken, undated], householdSize: 1 }));
    expect(stats.observations).toBe(0);
    expect(stats.wasteEvents).toBe(0);
    expect(stats.lastFinishedAt).toBeNull();
  });

  it("floors very short lifecycles at half a day", () => {
    const stats = computeConsumptionStats(
      input({
        priorDailyPerPerson: null,
        observations: [
          observation({ endedDaysAgo: 3, durationDays: 0.1, used: 500 }),
          observation({ endedDaysAgo: 1, durationDays: 0.1, used: 500 }),
        ],
      }),
    );
    expect(stats.historyMedianRate).toBeCloseTo(1000, 6);
  });
});

describe("computeConsumptionStats — seasonality", () => {
  /**
   * Sparkling water for two adults over ~2 years, a lifecycle every 15 days:
   * 1.5 L/day through the Australian summer (Dec–Feb), 1 L/day otherwise.
   */
  function sparklingWater(now: Date, count = 48, spacingDays = 15): ConsumptionObservation[] {
    return Array.from({ length: count }, (_, i) => {
      const endedDaysAgo = 1 + i * spacingDays;
      const endedAt = daysBefore(endedDaysAgo, now);
      const month = new Date(endedAt.getTime() - 2 * DAY).getUTCMonth();
      const summer = month === 11 || month === 0 || month === 1;
      return observation({ endedDaysAgo, durationDays: 4, used: (summer ? 1500 : 1000) * 4, now });
    });
  }

  it("lifts the rate in summer once there's more than a year of history", () => {
    const january = new Date("2027-01-15T09:00:00Z");
    const stats = computeConsumptionStats(
      input({ observations: sparklingWater(january), now: january, priorDailyPerPerson: null }),
    );
    expect(stats.seasonalFactor).toBeGreaterThan(1.2);
    expect(stats.seasonalFactor).toBeLessThanOrEqual(1.6);
    expect(Math.abs((stats.dailyRate as number) - 1500) / 1500).toBeLessThan(0.1);
  });

  it("lowers it outside summer", () => {
    const july = new Date("2027-07-15T09:00:00Z");
    const stats = computeConsumptionStats(
      input({ observations: sparklingWater(july), now: july, priorDailyPerPerson: null }),
    );
    expect(stats.seasonalFactor).toBeLessThan(1);
    expect(stats.seasonalFactor).toBeGreaterThanOrEqual(0.6);
    expect(Math.abs((stats.dailyRate as number) - 1000) / 1000).toBeLessThan(0.1);
  });

  it("stays at 1 without enough span, observations or in-season data", () => {
    const january = new Date("2027-01-15T09:00:00Z");
    // 15 observations over ~210 days: not enough span.
    const shortSpan = computeConsumptionStats(input({ observations: sparklingWater(january, 15), now: january }));
    expect(shortSpan.seasonalFactor).toBe(1);
    // 7 observations across 420 days: too few.
    const sparse = computeConsumptionStats(input({ observations: sparklingWater(january, 7, 70), now: january }));
    expect(sparse.seasonalFactor).toBe(1);
    // 10 observations spanning a year, but none within ±45 days of mid-January.
    const offSeason = [100, 130, 160, 190, 220, 250, 280, 310, 340, 400].map((ago) =>
      observation({ endedDaysAgo: ago, durationDays: 4, used: 4000, now: january }),
    );
    expect(computeConsumptionStats(input({ observations: offSeason, now: january })).seasonalFactor).toBe(1);
  });
});

describe("computeConsumptionStats — purchases and staples", () => {
  const at = (iso: string, amountBase = 2000): PurchaseObservation => ({ purchasedAt: new Date(iso), amountBase });

  it("merges same-day purchases into one shop", () => {
    const stats = computeConsumptionStats(
      input({
        purchases: [
          at("2026-09-01T01:00:00Z"),
          at("2026-09-01T20:00:00Z"),
          at("2026-09-08T03:00:00Z"),
          at("2026-09-15T03:00:00Z"),
          at("2026-09-22T03:00:00Z"),
        ],
      }),
    );
    expect(stats.purchaseCount).toBe(4);
    expect(stats.typicalPurchaseAmount).toBe(2000);
    expect(stats.typicalPurchaseIntervalDays).toBe(7);
    expect(stats.lastPurchasedAt?.toISOString()).toBe("2026-09-22T03:00:00.000Z");
    expect(stats.isStaple).toBe(true);
  });

  it("is not a staple when bought rarely, irregularly or not lately", () => {
    const twice = computeConsumptionStats(input({ purchases: [at("2026-09-20T00:00:00Z"), at("2026-09-27T00:00:00Z")] }));
    expect(twice.isStaple).toBe(false);

    const monthly = computeConsumptionStats(
      input({ purchases: [at("2026-06-28T00:00:00Z"), at("2026-07-28T00:00:00Z"), at("2026-08-28T00:00:00Z"), at("2026-09-28T00:00:00Z")] }),
    );
    expect(monthly.typicalPurchaseIntervalDays).toBe(31);
    expect(monthly.isStaple).toBe(false);

    const lapsed = computeConsumptionStats(
      input({ purchases: [at("2026-06-01T00:00:00Z"), at("2026-06-08T00:00:00Z"), at("2026-06-15T00:00:00Z")] }),
    );
    expect(lapsed.isStaple).toBe(false);
  });

  it("has no interval with a single shop", () => {
    const stats = computeConsumptionStats(input({ purchases: [at("2026-09-20T00:00:00Z", 0)] }));
    expect(stats.purchaseCount).toBe(1);
    expect(stats.typicalPurchaseIntervalDays).toBeNull();
    expect(stats.typicalPurchaseAmount).toBeNull();
  });
});
