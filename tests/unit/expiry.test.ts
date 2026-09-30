import { describe, expect, it } from "vitest";
import { assessUseSoon, estimateExpiry, type ExpiryEstimateInput } from "@/lib/prediction/expiry";

function expiry(overrides: Partial<ExpiryEstimateInput>): string | null {
  return estimateExpiry({
    purchasedAt: new Date("2026-09-30T02:00:00Z"),
    shelfLifeDays: null,
    freezerShelfLifeDays: null,
    location: "fridge",
    perishable: true,
    timeZone: "UTC",
    ...overrides,
  });
}

describe("estimateExpiry", () => {
  it("counts shelf life from the purchase day in the household's timezone", () => {
    // 8 pm UTC on 30 Sep is 6 am on 1 Oct in Sydney.
    const evening = new Date("2026-09-30T20:00:00Z");
    expect(expiry({ purchasedAt: evening, shelfLifeDays: 7, timeZone: "Australia/Sydney" })).toBe("2026-10-08");
    expect(expiry({ purchasedAt: evening, shelfLifeDays: 7, timeZone: "Europe/London" })).toBe("2026-10-07");
  });

  it("uses the freezer shelf life when frozen", () => {
    expect(expiry({ location: "freezer", shelfLifeDays: 3, freezerShelfLifeDays: 180 })).toBe("2027-03-29");
  });

  it("never shortens life by freezing when only the fresh shelf life is known", () => {
    // Fresh chicken breast moved to the freezer.
    expect(expiry({ location: "freezer", shelfLifeDays: 3 })).toBe("2026-12-29");
    // Frozen peas, normally kept frozen, carry a long shelf life already.
    expect(expiry({ location: "freezer", shelfLifeDays: 365, perishable: false })).toBe("2027-09-30");
  });

  it("defaults perishables to a week and leaves non-perishables open", () => {
    expect(expiry({ perishable: true })).toBe("2026-10-07");
    expect(expiry({ location: "freezer", perishable: true })).toBe("2026-12-29");
    expect(expiry({ location: "pantry", perishable: false })).toBeNull();
    expect(expiry({ location: "freezer", perishable: false })).toBeNull();
  });

  it("handles same-day, fractional and invalid inputs", () => {
    expect(expiry({ shelfLifeDays: 0 })).toBe("2026-09-30");
    expect(expiry({ shelfLifeDays: 2.6 })).toBe("2026-10-03");
    expect(expiry({ shelfLifeDays: -4, perishable: false })).toBeNull();
    expect(expiry({ purchasedAt: new Date(Number.NaN), shelfLifeDays: 5 })).toBeNull();
  });
});

describe("assessUseSoon", () => {
  const today = "2026-09-30";

  it.each([
    ["2026-09-28", -2, "expired", "Expired 2 days ago"],
    ["2026-09-29", -1, "expired", "Expired yesterday"],
    ["2026-09-30", 0, "today", "Use today"],
    ["2026-10-01", 1, "soon", "Use by tomorrow"],
    ["2026-10-02", 2, "soon", "Use within 2 days"],
    ["2026-10-03", 3, "soon", "Use within 3 days"],
    ["2026-10-05", 5, "ok", "Good for about 5 days"],
    ["2026-10-08", 8, "ok", "Good for about a week"],
    ["2026-11-02", 33, "ok", "Good for about a month"],
  ] as const)("expiring %s → %s", (expiresOn, days, status, label) => {
    const result = assessUseSoon({ expiresOn, today, remainingFraction: 0.5 });
    expect(result.daysUntilExpiry).toBe(days);
    expect(result.status).toBe(status);
    expect(result.label).toBe(label);
  });

  it("is unknown without a valid expiry date", () => {
    for (const expiresOn of [null, "someday", "2026-13-45"]) {
      expect(assessUseSoon({ expiresOn, today, remainingFraction: 1 })).toEqual({
        daysUntilExpiry: null,
        status: "unknown",
        atRiskOfWaste: false,
        label: "No expiry date",
      });
    }
  });

  it("flags a bag of spinach that won't be finished in time", () => {
    // 80% left, expires in 2 days, household eats ~10% of the bag a day → ~55% binned.
    expect(assessUseSoon({ expiresOn: "2026-10-02", today, remainingFraction: 0.8, dailyShareOfBatch: 0.1 }).atRiskOfWaste).toBe(true);
    // Eating 40% a day, it'll be gone before it turns.
    expect(assessUseSoon({ expiresOn: "2026-10-02", today, remainingFraction: 0.8, dailyShareOfBatch: 0.4 }).atRiskOfWaste).toBe(false);
  });

  it("projects slow use even when expiry is a while off", () => {
    const slow = assessUseSoon({ expiresOn: "2026-10-10", today, remainingFraction: 1, dailyShareOfBatch: 0.05 });
    expect(slow.status).toBe("ok");
    expect(slow.atRiskOfWaste).toBe(true);
  });

  it("without a usage rate, only judges items that are due soon", () => {
    expect(assessUseSoon({ expiresOn: "2026-10-10", today, remainingFraction: 1 }).atRiskOfWaste).toBe(false);
    expect(assessUseSoon({ expiresOn: "2026-10-01", today, remainingFraction: 0.6 }).atRiskOfWaste).toBe(true);
    expect(assessUseSoon({ expiresOn: "2026-10-01", today, remainingFraction: 0.2 }).atRiskOfWaste).toBe(false);
  });

  it("treats anything substantial left past expiry as at risk", () => {
    expect(assessUseSoon({ expiresOn: "2026-09-27", today, remainingFraction: 0.5, dailyShareOfBatch: 0.5 }).atRiskOfWaste).toBe(true);
    expect(assessUseSoon({ expiresOn: "2026-09-27", today, remainingFraction: 0.1 }).atRiskOfWaste).toBe(false);
  });
});
