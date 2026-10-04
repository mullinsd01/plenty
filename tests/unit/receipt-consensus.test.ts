import { describe, expect, it } from "vitest";
import { mergeReadings, type Reading } from "@/lib/receipts/consensus";
import { parseReceiptText, READING_SEPARATOR, type ParsedReceiptLine } from "@/lib/receipts/parse";

const TODAY = "2026-09-30";

function line(description: string, price: number | null, extra: Partial<ParsedReceiptLine> = {}): ParsedReceiptLine {
  return { raw: description, description, quantity: null, weightKg: null, unitPrice: null, price, discount: null, ...extra };
}

function reading(lines: ParsedReceiptLine[], extra: Partial<Reading> = {}): Reading {
  return { store: null, purchasedOn: null, dateRejection: null, total: null, subtotal: null, taxes: [], footerSeen: false, lines, ...extra };
}

describe("mergeReadings", () => {
  const milk = (price: number | null) => line("Full cream milk 2L", price);
  const bread = (price: number | null) => line("White bread 700g", price);
  const eggs = (price: number | null) => line("Free range eggs 12pk", price);

  it("returns a single reading unchanged and an empty one for none", () => {
    const only = reading([milk(3.1)], { total: 3.1 });
    expect(mergeReadings([only])).toBe(only);
    expect(mergeReadings([])).toMatchObject({ lines: [], total: null, store: null });
  });

  it("decides each price by vote, so one misread digit is outvoted", () => {
    const merged = mergeReadings([
      reading([milk(3.1), bread(2.98), eggs(6.2)]),
      reading([milk(3.1), bread(2.38), eggs(6.2)]),
      reading([milk(3.1), bread(2.38), eggs(8.2)]),
    ]);
    expect(merged.lines.map((l) => l.price)).toEqual([3.1, 2.38, 6.2]);
  });

  it("recovers a price one reading couldn't read, and keeps the first reading's on a tie", () => {
    const merged = mergeReadings([reading([milk(null), bread(2.7)]), reading([milk(3.1), bread(2.7)]), reading([milk(3.1), bread(2.7)])]);
    expect(merged.lines.map((l) => l.price)).toEqual([3.1, 2.7]);
    const tie = mergeReadings([reading([milk(3.1)]), reading([milk(3.2)])]);
    expect(tie.lines[0].price).toBe(3.1);
  });

  it("adds an item that two readings found but the best reading missed, in receipt order", () => {
    const merged = mergeReadings([reading([milk(3.1), eggs(6.2)]), reading([milk(3.1), bread(2.7), eggs(6.2)]), reading([milk(3.1), bread(2.7)])]);
    expect(merged.lines.map((l) => l.description)).toEqual(["Full cream milk 2L", "White bread 700g", "Free range eggs 12pk"]);
  });

  it("drops an item only one reading saw unless it is in the best reading", () => {
    const junk = line("Wakable Ttews", 1.18);
    const merged = mergeReadings([reading([milk(3.1), bread(2.7)]), reading([milk(3.1), junk, bread(2.7)]), reading([milk(3.1), bread(2.7)])]);
    expect(merged.lines.map((l) => l.description)).toEqual(["Full cream milk 2L", "White bread 700g"]);
    // With only two readings neither can outvote the other: the better one's lines stand.
    const keeps = mergeReadings([reading([milk(3.1)]), reading([milk(3.1), bread(2.7)])]);
    expect(keeps.lines).toHaveLength(2);
    const alone = mergeReadings([reading([milk(3.1), bread(2.7)]), reading([milk(3.1), junk])]);
    expect(alone.lines.map((l) => l.description)).toEqual(["Full cream milk 2L", "White bread 700g"]);
  });

  it("aligns lines whose descriptions OCR read differently", () => {
    const merged = mergeReadings([
      reading([line("Bertoconi Australiandy Swed Ham off Bone", 2.38), line("Don Shredded Han KG", 0.88)]),
      reading([line("Bertocchi AustralianDt Sucd Ham off Bone", 2.38), line("Don Shredded Ham KG", 0.88)]),
    ]);
    expect(merged.lines).toHaveLength(2);
    expect(merged.lines.map((l) => l.price)).toEqual([2.38, 0.88]);
  });

  it("keeps different items with similar prices apart", () => {
    const merged = mergeReadings([reading([line("Bananas", 3.5), line("Apples", 3.5)]), reading([line("Bananas", 3.5), line("Apples", 3.5)])]);
    expect(merged.lines.map((l) => l.description)).toEqual(["Bananas", "Apples"]);
  });

  it("keeps two lines with the same name apart when each reading has both", () => {
    const merged = mergeReadings([reading([line("Bread rolls 6pk", 3), line("Bread rolls 6pk", 3)]), reading([line("Bread rolls 6pk", 3), line("Bread rolls 6pk", 3)])]);
    expect(merged.lines).toHaveLength(2);
  });

  it("votes on weights, quantities and the discount, using the price before discount", () => {
    const base = { description: "Passata 700g" };
    const merged = mergeReadings([
      reading([line(base.description, 2.5, { discount: 1, quantity: 2 })]),
      reading([line(base.description, 3.5, { weightKg: null, quantity: 2 })]),
      reading([line(base.description, 2.5, { discount: 1, quantity: 2 })]),
    ]);
    expect(merged.lines[0]).toMatchObject({ price: 2.5, discount: 1, quantity: 2 });
    const weighed = mergeReadings([
      reading([line("Bananas", 3.28, { weightKg: 0.842 })]),
      reading([line("Bananas", 3.28, { weightKg: 0.832 })]),
      reading([line("Bananas", 3.28, { weightKg: 0.842 })]),
    ]);
    expect(weighed.lines[0].weightKg).toBe(0.842);
  });

  it("believes a total two readings agree on, or a single one the items add up to, and nothing else", () => {
    const items = [milk(3.1), bread(2.7)];
    expect(mergeReadings([reading(items, { total: 5.8 }), reading(items, { total: 5.8 }), reading(items, { total: 9.8 })]).total).toBe(5.8);
    expect(mergeReadings([reading(items, { total: 5.8 }), reading(items)]).total).toBe(5.8);
    expect(mergeReadings([reading(items, { total: 9.0 }), reading(items)]).total).toBeNull();
    expect(mergeReadings([reading(items, { total: 5.8 }), reading(items, { total: 9.0 })]).total).toBe(5.8);
    // Tax-inclusive receipts: the items add up to the total less tax.
    expect(mergeReadings([reading(items, { total: 6.3, taxes: [0.5] }), reading(items)]).total).toBe(6.3);
  });

  it("takes the store and date most readings agree on, and keeps the date rejection when there is none", () => {
    const merged = mergeReadings([
      reading([milk(3.1)], { store: "Coles", purchasedOn: "2026-09-26" }),
      reading([milk(3.1)], { store: "Woolworths", purchasedOn: "2026-09-26" }),
      reading([milk(3.1)], { store: "Woolworths", purchasedOn: "2026-09-20" }),
    ]);
    expect(merged).toMatchObject({ store: "Woolworths", purchasedOn: "2026-09-26", dateRejection: null });
    const none = mergeReadings([reading([milk(3.1)]), reading([milk(3.1)], { dateRejection: "date_in_future" })]);
    expect(none).toMatchObject({ purchasedOn: null, dateRejection: "date_in_future" });
  });

  it("is deterministic and does not modify its input", () => {
    const readings = [reading([milk(3.1), bread(2.98)]), reading([milk(3.1), bread(2.38)]), reading([milk(3.1), bread(2.38)])];
    const copy = JSON.parse(JSON.stringify(readings));
    expect(mergeReadings(readings)).toEqual(mergeReadings(readings));
    expect(readings).toEqual(copy);
  });
});

describe("parseReceiptText with several readings", () => {
  const A = ["WOOLWORTHS", "MILK 2L 3.10", "BREAD 700G 2.98", "EGGS 12PK 6.20", "TOTAL 12.30"].join("\n");
  const B = ["WOOLWORTHS", "MILK 2L 3.10", "BREAD 700G 2.70", "EGGS 12PK 6.20", "TOTAL 12.00"].join("\n");
  const C = ["W00LWORTHS", "MILK 2L 3.10", "BREAD 700G 2.70", "EGGS 12PK 8.20", "TOTAL 12.00"].join("\n");
  const join = (...texts: string[]) => texts.join(`\n${READING_SEPARATOR}\n`);

  it("merges readings separated by form feeds", () => {
    const parsed = parseReceiptText(join(A, B, C), { today: TODAY });
    expect(parsed.lines.map((l) => [l.description, l.price])).toEqual([
      ["MILK 2L", 3.1],
      ["BREAD 700G", 2.7],
      ["EGGS 12PK", 6.2],
    ]);
    expect(parsed).toMatchObject({ store: "Woolworths", total: 12 });
    expect(parsed.warnings).toEqual(["no_date"]);
    const dated = parseReceiptText(join(A, `${B}\n26/09/2026 17:42`, `${C}\n26/09/2026 17:42`), { today: TODAY });
    expect(dated.purchasedOn).toBe("2026-09-26");
    expect(dated.warnings).toEqual([]);
  });

  it("gives one reading exactly the result it always had", () => {
    expect(parseReceiptText(A, { today: TODAY })).toEqual(parseReceiptText(`${A}\n${READING_SEPARATOR}\n`, { today: TODAY }));
    expect(parseReceiptText(join(A, "", "  "), { today: TODAY })).toEqual(parseReceiptText(A, { today: TODAY }));
  });

  it("works out the warnings from the merged result", () => {
    const withoutTotal = (text: string) => text.replace(/\nTOTAL .*/, "");
    const merged = parseReceiptText(join(withoutTotal(A), withoutTotal(B), withoutTotal(C)), { today: TODAY });
    expect(merged.total).toBeNull();
    expect(merged.warnings).toContain("no_total");
    const mismatch = parseReceiptText(join(B, B.replace("TOTAL 12.00", "TOTAL 40.00"), B.replace("TOTAL 12.00", "TOTAL 40.00")), { today: TODAY });
    expect(mismatch.total).toBe(40);
    expect(mismatch.warnings).toContain("total_mismatch");
  });
});
