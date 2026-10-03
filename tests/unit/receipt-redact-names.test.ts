import { describe, expect, it } from "vitest";
import { redactReceiptText } from "@/lib/receipts/redact";

/** From the security review: slips that name the buyer after "Bought by", "Ordered by" and the like. */
describe("receipt redaction: who bought it", () => {
  it.each(["Bought by: Jane Citizen", "Purchased by Jane Citizen", "Ordered by: Jane Citizen", "Placed by - Jane Citizen", "Account holder: Jane Citizen"])(
    "removes the name after %s",
    (line) => {
      const out = redactReceiptText(line);
      expect(out).not.toMatch(/Jane|Citizen/);
      expect(out).toContain("▪▪▪");
    },
  );

  it("leaves item lines and prices alone", () => {
    const lines = ["MILK 2L 3.50", "BANANAS 1.234kg @ $3.90/kg 4.81", "ORDER TOTAL 54.20", "Bought 2 for 5.00"];
    for (const l of lines) expect(redactReceiptText(l)).toBe(l);
  });

  it("is idempotent", () => {
    const once = redactReceiptText("Bought by: Jane Citizen");
    expect(redactReceiptText(once)).toBe(once);
  });
});

/** From the privacy review: names that aren't introduced by a label at the start of a line. */
describe("receipt redaction: names without a leading label", () => {
  it.each([
    ["You were served by Sam Rivera today", /Sam|Rivera/],
    ["Thank you for shopping. Served by Sam", /Sam/],
    ["Sam served you today", /\bSam\b/],
    ["Order for: Jane Citizen", /Jane|Citizen/],
    ["Order for Jane Citizen", /Jane|Citizen/],
    ["Pick-up for Jane Citizen", /Jane|Citizen/],
    ["Delivery for Jane", /Jane/],
    ["Prepared for Jane Citizen", /Jane|Citizen/],
    ["Hi, Jane!", /Jane/],
    ["Thanks, Jane!", /Jane/],
    ["Thank you Jane Citizen", /Jane|Citizen/],
    ["VISA DEBIT CITIZEN/JANE MR", /CITIZEN|JANE/],
    ["Cardholder JANE CITIZEN", /JANE|CITIZEN/],
  ])("removes the name in %j", (line, name) => {
    const out = redactReceiptText(line);
    expect(out).not.toMatch(name);
    expect(out).toContain("▪▪▪");
    // Safe to run again.
    expect(redactReceiptText(out)).toBe(out);
  });

  it.each([
    "Thank you for shopping with us",
    "Thank you, come again!",
    "Thanks for visiting",
    "Order for delivery within 3 days",
    "Order for the week 24.50",
    "Staff served you today",
    "Please see staff at the service desk",
    "MILK 2L 3.50",
    "CHIPS/DIP 2 FOR 5.00",
    "Rewards points earned 12",
  ])("leaves %j alone", (line) => {
    expect(redactReceiptText(line)).toBe(line);
  });
});
