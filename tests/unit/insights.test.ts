import { describe, expect, it } from "vitest";
import {
  computeShoppingRhythm,
  shoppingHorizonDays,
  spendSummary,
  typicalShop,
  wasteInsights,
  weekStartOf,
  type ShoppingRhythmInput,
  type WasteInsightInput,
} from "@/lib/insights";

// Wednesday.
const TODAY = "2026-09-30";

function rhythm(overrides: Partial<ShoppingRhythmInput>) {
  return computeShoppingRhythm({
    purchaseDates: [],
    today: TODAY,
    usualShopDay: null,
    shopIntervalDays: null,
    ...overrides,
  });
}

/** Eight Saturday shops in a row plus one Wednesday top-up. */
const SATURDAY_SHOPPER = [
  "2026-08-08",
  "2026-08-15",
  "2026-08-22",
  "2026-08-29",
  "2026-09-05",
  "2026-09-12",
  "2026-09-16",
  "2026-09-19",
  "2026-09-26",
];

describe("computeShoppingRhythm", () => {
  it("recognises a Saturday shopper", () => {
    const r = rhythm({ purchaseDates: SATURDAY_SHOPPER });
    expect(r).toEqual({
      typicalWeekday: 6,
      intervalDays: 7,
      nextShopDate: "2026-10-03",
      followingShopDate: "2026-10-10",
      basis: "history",
      confidence: "high",
      label: "You usually shop on Saturdays",
    });
    expect(shoppingHorizonDays(r, TODAY)).toBe(10);
  });

  it("doesn't let a Monday top-up push the Saturday shop back a week", () => {
    const r = rhythm({ purchaseDates: [...SATURDAY_SHOPPER, "2026-09-28"] });
    expect(r.typicalWeekday).toBe(6);
    expect(r.nextShopDate).toBe("2026-10-03");
  });

  it("rolls an overdue Saturday shop forward to this Saturday", () => {
    const r = rhythm({ purchaseDates: SATURDAY_SHOPPER.slice(0, 6) });
    expect(r.nextShopDate).toBe("2026-10-03");
    expect(r.followingShopDate).toBe("2026-10-10");
  });

  it("learns an interval when there's no favourite day", () => {
    const r = rhythm({
      purchaseDates: ["2026-08-29", "2026-09-03", "2026-09-08", "2026-09-13", "2026-09-18", "2026-09-23", "2026-09-28"],
    });
    expect(r.typicalWeekday).toBeNull();
    expect(r.intervalDays).toBe(5);
    expect(r.nextShopDate).toBe("2026-10-03");
    expect(r.followingShopDate).toBe("2026-10-08");
    expect(r.label).toBe("You shop about every 5 days");
    expect(r.confidence).toBe("high");
  });

  it("rolls an overdue interval shop forward by whole intervals", () => {
    const r = rhythm({ purchaseDates: ["2026-08-29", "2026-09-03", "2026-09-08", "2026-09-13", "2026-09-18"] });
    expect(r.nextShopDate).toBe("2026-10-03");
    expect(r.confidence).toBe("medium");
  });

  it("has no single shop day for a twice-a-week shopper", () => {
    const dates = ["2026-08-15"];
    for (let i = 1; i < 13; i++) {
      const prev = new Date(`${dates[i - 1]}T00:00:00Z`);
      prev.setUTCDate(prev.getUTCDate() + (i % 2 === 1 ? 4 : 3));
      dates.push(prev.toISOString().slice(0, 10));
    }
    const r = rhythm({ purchaseDates: dates });
    expect(r.typicalWeekday).toBeNull();
    expect(r.intervalDays).toBe(3);
    expect(r.nextShopDate >= TODAY).toBe(true);
  });

  it("lets preferences override history", () => {
    const r = rhythm({ purchaseDates: SATURDAY_SHOPPER, usualShopDay: 4 });
    expect(r.typicalWeekday).toBe(4);
    expect(r.basis).toBe("preference");
    expect(r.confidence).toBe("high");
    expect(r.nextShopDate).toBe("2026-10-01");
    expect(r.label).toBe("You usually shop on Thursdays");
  });

  it("uses preferences without any history", () => {
    const fortnightly = rhythm({ usualShopDay: 6, shopIntervalDays: 14 });
    expect(fortnightly.nextShopDate).toBe("2026-10-03");
    expect(fortnightly.followingShopDate).toBe("2026-10-17");
    expect(fortnightly.label).toBe("You usually shop every second Saturday");

    const everyTen = rhythm({ shopIntervalDays: 10 });
    expect(everyTen.nextShopDate).toBe("2026-10-05");
    expect(everyTen.label).toBe("You shop about every 10 days");
  });

  it("falls back to a weekly default with no data", () => {
    expect(rhythm({})).toEqual({
      typicalWeekday: null,
      intervalDays: 7,
      nextShopDate: "2026-10-03",
      followingShopDate: "2026-10-10",
      basis: "default",
      confidence: "low",
      label: null,
    });
  });

  it("ignores duplicates, invalid and future dates", () => {
    const r = rhythm({
      purchaseDates: ["2026-09-26", "2026-09-26", "not-a-date", "2026-10-03", "2026-09-19", "2026-09-12"],
    });
    expect(r.intervalDays).toBe(7);
    expect(r.typicalWeekday).toBe(6);
    expect(r.nextShopDate).toBe("2026-10-03");
    expect(r.confidence).toBe("medium");
  });

  it("is cautious with a single shop", () => {
    const r = rhythm({ purchaseDates: ["2026-09-26"] });
    expect(r.basis).toBe("history");
    expect(r.confidence).toBe("low");
    expect(r.nextShopDate).toBe("2026-10-03");
    expect(r.label).toBeNull();
  });
});

describe("wasteInsights", () => {
  const items: WasteInsightInput[] = [
    { productId: "milk", name: "Full cream milk", wasteRatio: 0.05, wasteEvents: 1, purchaseCount: 12 },
    { productId: "coriander", name: "Coriander", wasteRatio: 0.3, wasteEvents: 2, purchaseCount: 4 },
    { productId: "spinach", name: "Baby spinach", wasteRatio: 0.5, wasteEvents: 3, purchaseCount: 6 },
    { productId: "lettuce", name: "Iceberg lettuce", wasteRatio: 0.6, wasteEvents: 1, purchaseCount: 1 },
    { productId: "zucchini", name: "Zucchini", wasteRatio: 0.25, wasteEvents: 2, purchaseCount: 5 },
    { productId: "rocket", name: "Rocket", wasteRatio: 0.7, wasteEvents: 2, purchaseCount: 2 },
    { productId: "uht", name: "UHT milk", wasteRatio: 0.5, wasteEvents: 2, purchaseCount: 3 },
  ];

  it("only reports real patterns, most severe first", () => {
    const insights = wasteInsights(items);
    expect(insights.map((i) => i.productId)).toEqual(["rocket", "spinach", "uht", "coriander", "zucchini"]);
    expect(insights.map((i) => i.severity)).toEqual(["high", "high", "high", "medium", "medium"]);
  });

  it("tells the household they buy more spinach than they use", () => {
    const spinach = wasteInsights(items).find((i) => i.productId === "spinach")!;
    expect(spinach.message).toBe("You usually buy more baby spinach than you use.");
    expect(spinach.suggestion).toBe(
      "Try a smaller size or buying it less often, and plan a meal that uses it early in the week.",
    );
    expect(spinach.suggestedPurchaseFactor).toBe(0.6);
    expect(spinach.name).toBe("Baby spinach");
  });

  it("words medium waste gently and keeps acronyms intact", () => {
    const insights = wasteInsights(items);
    expect(insights.find((i) => i.productId === "coriander")!.message).toBe("Some of your coriander tends to go to waste.");
    expect(insights.find((i) => i.productId === "uht")!.message).toBe("You usually buy more UHT milk than you use.");
    expect(insights.find((i) => i.productId === "rocket")!.suggestion).toBe(
      "Try a smaller size, or plan a meal that uses it early in the week.",
    );
  });

  it("suggests buying less in proportion to waste, within 0.5–0.9", () => {
    const factors = Object.fromEntries(wasteInsights(items).map((i) => [i.productId, i.suggestedPurchaseFactor]));
    expect(factors).toEqual({ rocket: 0.5, spinach: 0.6, uht: 0.6, coriander: 0.75, zucchini: 0.8 });
  });

  it("returns nothing without waste", () => {
    expect(wasteInsights([])).toEqual([]);
    expect(wasteInsights([{ ...items[0], wasteRatio: Number.NaN, wasteEvents: 5 }])).toEqual([]);
  });
});

describe("spendSummary", () => {
  const receipts = [
    { date: "2026-08-03", total: 500 }, // before the 8-week window
    { date: "2026-08-10", total: 150 },
    { date: "2026-08-15", total: 40 },
    { date: "2026-08-23", total: 180 }, // Sunday → week of 17 Aug
    { date: "2026-09-05", total: 170 },
    { date: "2026-09-09", total: 25.5 },
    { date: "2026-09-12", total: 210 },
    { date: "2026-09-19", total: 220 },
    { date: "2026-09-26", total: 240 },
    { date: "2026-09-29", total: 60 },
    { date: "2026-10-02", total: 999 }, // future
    { date: "not a date", total: 80 },
    { date: "2026-09-20", total: Number.NaN },
  ];

  it("totals the last 8 Monday-start weeks, zero-filled", () => {
    const summary = spendSummary({ receipts, today: TODAY, weeklyBudget: null });
    expect(summary.weeks).toEqual([
      { weekStart: "2026-08-10", total: 190 },
      { weekStart: "2026-08-17", total: 180 },
      { weekStart: "2026-08-24", total: 0 },
      { weekStart: "2026-08-31", total: 170 },
      { weekStart: "2026-09-07", total: 235.5 },
      { weekStart: "2026-09-14", total: 220 },
      { weekStart: "2026-09-21", total: 240 },
      { weekStart: "2026-09-28", total: 60 },
    ]);
    expect(summary.thisWeek).toBe(60);
  });

  it("averages completed weeks with spend and spots a rising trend", () => {
    const summary = spendSummary({ receipts, today: TODAY, weeklyBudget: null });
    expect(summary.averageWeekly).toBeCloseTo(1235.5 / 6, 2);
    expect(summary.trend).toBe("up");
    expect(summary.overBudgetWeeks).toBe(0);
    expect(summary.label).toBe("You spend about $205 a week, and it's been creeping up");
  });

  it("compares against the weekly budget", () => {
    const over = spendSummary({ receipts, today: TODAY, weeklyBudget: 200 });
    expect(over.overBudgetWeeks).toBe(3);
    expect(over.label).toBe("You spend about $205 a week, over your $200 budget");
    const within = spendSummary({ receipts, today: TODAY, weeklyBudget: 250, currency: "GBP" });
    expect(within.overBudgetWeeks).toBe(0);
    expect(within.label).toBe("You spend about £205 a week, within your £250 budget");
  });

  it("is steady when spend barely moves", () => {
    const flat = ["2026-08-15", "2026-08-22", "2026-08-29", "2026-09-05", "2026-09-12", "2026-09-19", "2026-09-26"].map(
      (date, i) => ({ date, total: 180 + (i % 2) * 8 }),
    );
    expect(spendSummary({ receipts: flat, today: TODAY, weeklyBudget: null }).trend).toBe("steady");
  });

  it("copes with no spend, or only this week's", () => {
    const empty = spendSummary({ receipts: [], today: TODAY, weeklyBudget: 150 });
    expect(empty.weeks).toHaveLength(8);
    expect(empty.weeks.every((w) => w.total === 0)).toBe(true);
    expect(empty.averageWeekly).toBeNull();
    expect(empty.trend).toBeNull();
    expect(empty.label).toBeNull();

    const fresh = spendSummary({ receipts: [{ date: "2026-09-28", total: 142.35 }], today: TODAY, weeklyBudget: null });
    expect(fresh.averageWeekly).toBe(142.35);
    expect(fresh.trend).toBeNull();
    expect(fresh.label).toBe("You spend about $140 a week");
  });
});

describe("weekStartOf and typicalShop", () => {
  it("finds the Monday of a week", () => {
    expect(weekStartOf("2026-09-27")).toBe("2026-09-21");
    expect(weekStartOf("2026-09-28")).toBe("2026-09-28");
    expect(weekStartOf("2026-09-30")).toBe("2026-09-28");
  });

  it("describes a typical shop, skipping missing figures", () => {
    expect(
      typicalShop([
        { itemCount: 20, total: 150 },
        { itemCount: 35, total: 210.5 },
        { itemCount: 8, total: null },
        { itemCount: 0, total: 0 },
        { itemCount: 28, total: 180 },
      ]),
    ).toEqual({ medianItems: 24, medianSpend: 180 });
    expect(typicalShop([])).toEqual({ medianItems: null, medianSpend: null });
  });
});
