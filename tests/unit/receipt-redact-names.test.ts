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
