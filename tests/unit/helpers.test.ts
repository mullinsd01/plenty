import { describe, expect, it } from "vitest";
import { addDays, daysBetweenDates, relativeDayLabel, toDateString, weekdayOf, zonedDateTimeToInstant } from "@/lib/dates";
import { adultEquivalents, levelLabel, levelPhrase } from "@/lib/domain";
import { formatMoney, pluralize } from "@/lib/format";
import { parseQuickAdd } from "@/lib/quick-add";
import { convert, formatQuantity, packagesNeeded, parseUnit, toBaseUnit } from "@/lib/units";

describe("quick add parsing", () => {
  it("understands counts, measures, dozens and plain names", () => {
    expect(parseQuickAdd("2 milk, bread, 500g mince, a dozen eggs")).toEqual([
      { name: "Milk", quantity: null, unit: null, packCount: 2 },
      { name: "Bread", quantity: null, unit: null, packCount: 1 },
      { name: "Mince", quantity: 500, unit: "g", packCount: 1 },
      { name: "Eggs", quantity: 12, unit: "each", packCount: 1 },
    ]);
  });

  it("handles litres, decimals with commas, trailing multipliers and new lines", () => {
    const items = parseQuickAdd("1,5 l orange juice\nbananas x6\ntwo avocados");
    expect(items[0]).toMatchObject({ name: "Orange juice", quantity: 1.5, unit: "l" });
    expect(items[1]).toMatchObject({ name: "Bananas", packCount: 6 });
    expect(items[2]).toMatchObject({ name: "Avocados", packCount: 2 });
  });

  it("ignores empty fragments and caps silly counts", () => {
    expect(parseQuickAdd(" , ,, ")).toEqual([]);
    expect(parseQuickAdd("5000 cans")[0].packCount).toBe(100);
  });
});

describe("dates in the household's timezone", () => {
  it("finds the local calendar date", () => {
    // 2026-09-30T15:00Z is 1am on 1 October in Sydney (AEST, UTC+10).
    expect(toDateString(new Date("2026-09-30T15:00:00Z"), "Australia/Sydney")).toBe("2026-10-01");
    expect(toDateString(new Date("2026-09-30T15:00:00Z"), "UTC")).toBe("2026-09-30");
  });

  it("converts a local wall-clock time to the right instant, across DST", () => {
    // Sydney is UTC+10 in September and UTC+11 after DST starts (4 Oct 2026).
    expect(zonedDateTimeToInstant("2026-09-30", 12, "Australia/Sydney").toISOString()).toBe("2026-09-30T02:00:00.000Z");
    expect(zonedDateTimeToInstant("2026-10-10", 12, "Australia/Sydney").toISOString()).toBe("2026-10-10T01:00:00.000Z");
    // Adelaide has a half-hour offset.
    expect(zonedDateTimeToInstant("2026-09-30", 0, "Australia/Adelaide").toISOString()).toBe("2026-09-29T14:30:00.000Z");
  });

  it("does calendar arithmetic and friendly labels", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(daysBetweenDates("2026-09-26", "2026-10-03")).toBe(7);
    expect(weekdayOf("2026-09-26")).toBe(6);
    expect(relativeDayLabel("2026-09-30", "2026-09-30")).toBe("Today");
    expect(relativeDayLabel("2026-10-01", "2026-09-30")).toBe("Tomorrow");
    expect(relativeDayLabel("2026-10-02", "2026-09-30")).toBe("Friday");
  });
});

describe("units", () => {
  it("parses unit spellings", () => {
    expect(parseUnit("Litres")).toBe("l");
    expect(parseUnit("tins")).toBe("can");
    expect(parseUnit("nope")).toBeNull();
  });

  it("converts within and across dimensions with product knowledge", () => {
    expect(convert(1.5, "kg", "g")).toBe(1500);
    expect(convert(2, "tbsp", "ml")).toBe(30);
    expect(convert(1, "can", "g", { eachWeightG: 400 })).toBe(400);
    expect(convert(500, "ml", "g", { densityGPerMl: 1.03 })).toBeCloseTo(515);
    expect(convert(1, "can", "g")).toBeNull();
    expect(toBaseUnit(1.2, "kg", "each", { eachWeightG: 120 })).toBeCloseTo(10);
  });

  it("formats without false precision", () => {
    expect(formatQuantity(1500, "ml")).toBe("1.5 L");
    expect(formatQuantity(0.5, "kg")).toBe("500 g");
    expect(formatQuantity(12, "each")).toBe("12");
    expect(formatQuantity(3, "can")).toBe("3 cans");
    expect(formatQuantity(0.5, "cup")).toBe("½ cup");
  });

  it("rounds purchases up to whole packages", () => {
    expect(packagesNeeded(150, 300)).toBe(1);
    expect(packagesNeeded(301, 300)).toBe(2);
    expect(packagesNeeded(600, 300)).toBe(2);
  });
});

describe("domain helpers", () => {
  it("scales households to adult equivalents", () => {
    expect(adultEquivalents(2, 0)).toBe(2);
    expect(adultEquivalents(2, 1)).toBe(2.6);
    expect(adultEquivalents(0, 1)).toBe(1);
  });

  it("describes levels", () => {
    expect(levelLabel(1)).toBe("Full");
    expect(levelLabel(0.5)).toBe("Half");
    expect(levelLabel(0.1)).toBe("Low");
    expect(levelPhrase(0.2)).toBe("running low");
  });

  it("formats money and counts", () => {
    expect(formatMoney(68.61, "AUD")).toBe("$68.61");
    expect(formatMoney(230, "AUD")).toBe("$230");
    expect(pluralize(1, "item")).toBe("1 item");
    expect(pluralize(3, "item")).toBe("3 items");
  });
});
