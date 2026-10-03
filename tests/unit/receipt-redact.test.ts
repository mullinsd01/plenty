import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG } from "@/lib/catalog";
import { MAX_REDACT_LINE, REDACTED, redactReceiptLine, redactReceiptText, redactReceiptTextDetailed } from "@/lib/receipts/redact";
import { parseReceiptText } from "@/lib/receipts/parse";

const TODAY = "2026-09-30";
const FIXTURES = path.resolve(__dirname, "../fixtures/receipts");

/** The receipts written out in the parser's own tests, so there is one source of sample slips. */
function parserTestReceipts(): Record<string, string> {
  const source = readFileSync(path.resolve(__dirname, "receipt-parse.test.ts"), "utf8");
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/const ([A-Z_]+) = `([\s\S]*?)`;/g)) out[m[1]] = m[2];
  return out;
}

const fixtureReceipts = (): Record<string, string> =>
  Object.fromEntries(
    readdirSync(FIXTURES)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => [f, readFileSync(path.join(FIXTURES, f), "utf8")]),
  );

const redact = redactReceiptText;

// ─── What must go ───────────────────────────────────────────────────────────

describe("card numbers", () => {
  it.each([
    ["a bare 16-digit number", "CARD 4111111111111111", "4111111111111111"],
    ["a 13-digit number", "Card 4222222222222", "4222222222222"],
    ["a 19-digit number", "PAN 6759649826438453009", "6759649826438453009"],
    ["a spaced number", "4111 1111 1111 1111", "4111 1111 1111 1111"],
    ["a hyphenated number", "4111-1111-1111-1111", "4111-1111-1111-1111"],
    ["an Amex-style grouping", "3782 822463 10005", "822463"],
    ["a dotted number", "4111.1111.1111.1111", "4111.1111.1111.1111"],
    ["a slashed number", "4111/1111/1111/1111", "4111/1111/1111/1111"],
    ["a number inside a line of words", "Paid with card number 5500005555555559 thanks", "5500005555555559"],
    ["a fullwidth-digit number", "４１１１ １１１１ １１１１ １１１１", "1111"],
    ["a number split by zero-width spaces", "4111​1111​1111​1111", "1111"],
    ["an OCR-damaged number", "4111 1111 1111 111l", "4111"],
    ["a number with the letter O for zero", "5500 0O55 5555 5559", "5555"],
  ])("removes %s", (_name, line, secret) => {
    const out = redact(line);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it.each([
    ["****1234", "1234"],
    ["**** **** **** 1234", "1234"],
    ["XXXX XXXX XXXX 1234", "1234"],
    ["xxxx-xxxx-xxxx-1234", "1234"],
    ["XXXXXXXXXXXX1234", "1234"],
    ["411111******1111", "1111"],
    ["6008 **** **** 1234", "6008"],
    ["•••• •••• •••• 4821", "4821"],
    ["###########1234", "1234"],
  ])("removes the masked form %s", (masked, secret) => {
    const out = redact(`Card ${masked} approved`);
    expect(out).not.toContain(secret);
  });

  it.each([
    ["VISA ending 1234", "1234"],
    ["Mastercard ending in 5678", "5678"],
    ["Visa Debit ending 4821", "4821"],
    ["Card ending: 9999", "9999"],
    ["AMEX ends in 0005", "0005"],
    ["last 4 digits: 4242", "4242"],
    ["Last four digits 4242", "4242"],
  ])("removes the card tail in %s", (line, secret) => {
    expect(redact(line)).not.toContain(secret);
  });

  it("removes payment slip codes but keeps what was paid", () => {
    const slip = [
      "EFTPOS                          $52.26",
      "Approval code: 123456",
      "Auth code A1B2C3",
      "Terminal ID: T0012345",
      "Merchant ID 000123456789",
      "TERM 12345678 MERCH 87654321",
      "RRN 123456789012",
      "AID A0000000031010",
      "Receipt No: 00123456",
    ].join("\n");
    const out = redact(slip);
    expect(out).toContain("EFTPOS                          $52.26");
    for (const secret of ["123456", "A1B2C3", "T0012345", "000123456789", "12345678", "87654321", "A0000000031010", "00123456"]) {
      expect(out).not.toContain(secret);
    }
    // The labels stay, so the slip still reads as a slip.
    expect(out).toContain(`Approval code: ${REDACTED}`);
    expect(out).toContain(`Terminal ID: ${REDACTED}`);
    expect(out).toContain(`Merchant ID ${REDACTED}`);
  });
});

describe("loyalty and member numbers", () => {
  it.each([
    ["EVERYDAY REWARDS CARD ****4821", "4821"],
    ["Everyday Rewards: 9876 5432 1098 7654", "9876"],
    ["flybuys 6008 **** **** 1234", "6008"],
    ["Flybuys number 6008 4321 9876 5432", "6008"],
    ["Clubcard 634004 0123456789", "0123456789"],
    ["Nectar card no *******1234", "1234"],
    ["Member No: 100234567", "100234567"],
    ["Membership ID 88776655", "88776655"],
    ["Rewards card #5551234", "5551234"],
    ["Loyalty: 55512345678", "55512345678"],
    ["Customer ID: 4455667788", "4455667788"],
    ["Kroger Plus 4003 5599 12", "4003"],
  ])("removes the number in %s", (line, secret) => {
    const out = redact(line);
    expect(out).not.toContain(secret);
  });

  it("keeps the programme's name and points earned", () => {
    const out = redact("EVERYDAY REWARDS CARD ****4821\nPOINTS EARNED THIS SHOP 68\nCLUBCARD POINTS THIS VISIT 16");
    expect(out).toContain("EVERYDAY REWARDS CARD");
    expect(out).toContain("POINTS EARNED THIS SHOP 68");
    expect(out).toContain("CLUBCARD POINTS THIS VISIT 16");
  });
});

describe("contact details", () => {
  it.each([
    ["Ph: (02) 9000 1234", "9000"],
    ["Phone 02 9000 1234", "9000 1234"],
    ["Tel: +61 2 9000 1234", "9000"],
    ["Call us on 1800 123 456", "123 456"],
    ["Customer care 1300 765 432", "765 432"],
    ["Mobile 0412 345 678", "345 678"],
    ["0412 345 678", "345 678"],
    ["+44 20 7946 0958", "7946"],
    ["020 7946 0958", "7946"],
    ["(479) 273-4134", "273"],
    ["( 479 ) 273 - 4134", "273"],
    ["555-123-4567", "123-4567"],
    ["555 123 4567", "123 4567"],
    ["Ph: 09 360 1234", "360 1234"],
    ["Fax 02 9000 5678", "5678"],
  ])("removes the phone number in %s", (line, secret) => {
    expect(redact(line)).not.toContain(secret);
  });

  it.each([
    ["jane.doe@example.com", "jane.doe"],
    ["Receipt sent to Jane.Doe+shop@mail.example.com.au", "Jane.Doe"],
    ["EMAIL: j_smith@outlook.com", "j_smith"],
    ["jane . doe @ example . com", "jane"],
    ["jane@example.com   3.10", "jane"],
  ])("removes the email address in %s", (line, secret) => {
    expect(redact(line)).not.toContain(secret);
  });

  it("removes links, which often carry a receipt or customer id", () => {
    const out = redact("Tell us how we did: https://survey.example.com/r/abc123?cust=998877\nwww.woolworths.com.au/receipt/55\nsurvey.example.co/xyz");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("998877");
    expect(out).not.toContain("woolworths.com.au");
    expect(out).not.toContain("xyz");
  });
});

describe("addresses", () => {
  it("removes street addresses and postcodes but keeps the store and suburb", () => {
    const out = redact(
      ["WOOLWORTHS", "Woolworths Metro Town Hall", "Shop 3, 480 Kent St", "Sydney NSW 2000", "12 Parramatta Rd, Auburn NSW 2144", "123 High Street, London SE1 7AB"].join("\n"),
    );
    expect(out).toContain("WOOLWORTHS");
    expect(out).toContain("Woolworths Metro Town Hall");
    expect(out).toContain("Sydney NSW");
    expect(out).toContain("Auburn NSW");
    expect(out).toContain("London");
    for (const secret of ["480", "Kent St", "2000", "Parramatta", "2144", "High Street", "SE1", "7AB"]) expect(out).not.toContain(secret);
  });

  it.each([
    ["Unit 4/22 Smith Street", "Smith"],
    ["5/22 High Street, Newtown", "High Street"],
    ["12-14 Station Road", "Station"],
    ["Level 2, 100 George Street, Sydney", "George"],
    ["1234 SE WALTON BLVD", "WALTON"],
    ["BENTONVILLE AR 72712", "72712"],
    ["PO Box 1234", "1234"],
    ["P.O. Box 77", "77"],
    ["Locked Bag 9", "Locked Bag 9"],
    ["Deliver to: 5 Wattle Gr, Newtown", "Wattle"],
    ["Ship to  Jane Citizen, 9 Elm Ct", "Jane"],
    ["Address: somewhere private", "somewhere private"],
  ])("removes the address in %s", (line, secret) => {
    expect(redact(`TESCO\nTesco Express\n${line}\nMILK 2L 3.10`)).not.toContain(secret);
  });

  it("keeps a lone bare street name only in the header block, never in the items", () => {
    const out = redact("COLES\nNewtown Central, King St\nNewtown NSW 2042\nMILK 2L 3.10\nKING ST PIE 3.00");
    expect(out).not.toContain("King St\n");
    expect(out).toContain("KING ST PIE 3.00");
  });

  it("leaves register and lane numbers alone", () => {
    const line = "29/09/26 10:15  Store 812  Lane 3";
    expect(redact(`COLES\n${line}`)).toContain(line);
    expect(redact("26/09/2026 17:42  STORE 1234  LANE 5")).toContain("STORE 1234  LANE 5");
  });
});

describe("people", () => {
  it.each([
    ["Served by: Jane Citizen", "Jane"],
    ["SERVED BY JANE C", "JANE"],
    ["Cashier: Bob", "Bob"],
    ["Cashier Sam 042", "Sam"],
    ["Operator: Priya N.", "Priya"],
    ["Customer: John Smith", "John"],
    ["Customer name - Maria Rossi", "Maria"],
    ["Cardholder: A B JONES", "JONES"],
    ["Name: Chris Taylor", "Chris"],
    ["MANAGER JOHN SMITH", "SMITH"],
    ["Hi Sarah,", "Sarah"],
    ["Dear Mr Jones", "Jones"],
    ["Team member: Alex", "Alex"],
  ])("removes the name in %s", (line, secret) => {
    expect(redact(line)).not.toContain(secret);
  });

  it.each([
    "CUSTOMER COPY",
    "Customer Copy - please retain",
    "CUSTOMER SERVICE 1800 123 456 is wrong but not a name",
    "Thank you for shopping at ALDI",
    "THANK YOU FOR SHOPPING WITH US",
    "Hello there",
    "Hi everyone",
    "NAME BRAND SPAGHETTI 500G 2.00",
  ])("does not touch the line %s", (line) => {
    const out = redact(line);
    // The phone number in the odd example above is removed, but the words stay.
    expect(out.replace(/[•\s]+/g, " ").toLowerCase()).toContain(line.split(/\d/)[0].replace(/\s+/g, " ").toLowerCase().trim().slice(0, 12));
  });

  it("removes business registration numbers", () => {
    const out = redact("ABN 12 345 678 901\nVAT Number: GB 123 4567 89\nGST No: 045-903-213\nACN 123 456 789");
    for (const secret of ["345", "123 4567", "045-903", "456 789"]) expect(out).not.toContain(secret);
    expect(out).toContain("ABN");
    expect(out).toContain("VAT Number");
  });
});

// ─── What must stay ─────────────────────────────────────────────────────────

describe("what a receipt is for", () => {
  it("never changes an ordinary product line, however it is priced", () => {
    const changed: string[] = [];
    for (const product of CATALOG) {
      const upper = product.name.toUpperCase();
      for (const line of [`${upper}   3.10`, `${upper} 500G    $12.99`, `2 x ${upper}   6.20`, `${upper} 1KG 0.842 kg @ $3.90/kg  3.28`, `${upper}`, `  ${upper.slice(0, 18)} 2L  1,234.50`]) {
        if (redact(line) !== line || redactReceiptLine(line) !== line) changed.push(line);
      }
    }
    expect(changed).toEqual([]);
  });

  it("never changes prices, totals, quantities, weights, dates or times", () => {
    const lines = [
      "SUBTOTAL                          $52.26",
      "**** TOTAL                        $52.26",
      "Total for 10 items:               $33.85",
      "GST included in total              $0.36",
      "  0.842 kg NET @ $3.90/kg           3.28",
      "  2 @ $2.00 EACH                    4.00",
      "  3 @ $1.90 each",
      "  LESS SPECIAL                     -1.00",
      "26/09/2026 17:42  STORE 1234  LANE 5",
      "19.09.26  14:05  0123 04 5678",
      "22 Sep 2026 18:05  STORE 2045  OP 123",
      "09/27/26 7:14pm 402 29 108 52",
      "TOTAL 1 2 3",
      "4 x 1.25  5.00  12.50  100.00  1,000.00  1.00 2.00 3.00 4.00 5.00 6.00",
      "EFTPOS  $68.61",
      "Mastercard                        $33.85",
      "VISA DEBIT                        £15.59",
      "YOU SAVED                          $1.00",
      "POINTS EARNED THIS SHOP               68",
    ];
    for (const line of lines) expect(redact(line)).toBe(line);
  });

  it("keeps the store name, the date and every item when it redacts a whole receipt", () => {
    const out = redact(fixtureReceipts()["woolworths-weekly.txt"]);
    expect(out).toContain("WOOLWORTHS");
    expect(out).toContain("Woolworths Metro Town Hall");
    expect(out).toContain("26/09/2026 17:42");
    expect(out).toContain("W/M FULL CREAM 2L                   3.10");
    expect(out).toContain("TOTAL                             $68.61");
    expect(out).toContain("0.842 kg NET @ $3.90/kg           3.28");
    expect(out).not.toContain("4821");
    expect(out).not.toContain("9000 1234");
    expect(out).not.toContain("480 Kent");
    expect(out).not.toContain("345 678 901");
  });

  it("keeps line count and order, so line-based tools still line up", () => {
    const text = fixtureReceipts()["aldi-shop.txt"];
    expect(redact(text).split("\n")).toHaveLength(text.split("\n").length);
  });
});

describe("parsing is unchanged by redaction", () => {
  const all = { ...fixtureReceipts(), ...parserTestReceipts() };

  it("found the sample receipts", () => {
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(12);
  });

  it.each(Object.entries(all))("parses %s identically before and after", (_name, text) => {
    const before = parseReceiptText(text, { today: TODAY });
    const after = parseReceiptText(redact(text), { today: TODAY });
    expect(after.store).toBe(before.store);
    expect(after.purchasedOn).toBe(before.purchasedOn);
    expect(after.total).toBe(before.total);
    expect(after.subtotal).toBe(before.subtotal);
    expect(after.warnings).toEqual(before.warnings);
    expect(after.lines.map(({ description, price, quantity, weightKg, unitPrice, discount }) => ({ description, price, quantity, weightKg, unitPrice, discount }))).toEqual(
      before.lines.map(({ description, price, quantity, weightKg, unitPrice, discount }) => ({ description, price, quantity, weightKg, unitPrice, discount })),
    );
  });

  it("actually removed something from each sample (so the comparison means something)", () => {
    const untouched = Object.entries(all).filter(([, text]) => redactReceiptTextDetailed(text).total === 0).map(([name]) => name);
    // A couple of the parser's own samples have no personal details at all.
    expect(untouched.length).toBeLessThan(Object.keys(all).length / 2);
  });
});

// ─── Behaviour ──────────────────────────────────────────────────────────────

describe("redaction behaviour", () => {
  it("is idempotent", () => {
    for (const text of [...Object.values(fixtureReceipts()), ...Object.values(parserTestReceipts())]) {
      const once = redact(text);
      expect(redact(once)).toBe(once);
    }
    const nasty = "Card 4111 1111 1111 1111 ****1234 jane@x.com 0412 345 678\nServed by Jane\n12 Smith St";
    expect(redact(redact(nasty))).toBe(redact(nasty));
  });

  it("reports what it removed", () => {
    const r = redactReceiptTextDetailed("Card 4111111111111111\nPh: (02) 9000 1234\nServed by Jane\nme@example.com\nShop 3, 480 Kent St");
    expect(r.removed.card).toBe(1);
    expect(r.removed.phone).toBe(1);
    expect(r.removed.name).toBe(1);
    expect(r.removed.email).toBe(1);
    expect(r.removed.address).toBe(1);
    expect(r.total).toBe(5);
  });

  it("handles empty and missing input", () => {
    expect(redact("")).toBe("");
    expect(redactReceiptLine("")).toBe("");
    expect(redact(undefined as unknown as string)).toBe("");
    expect(redactReceiptLine(null as unknown as string)).toBe("");
  });

  it("keeps Windows and old Mac line endings working", () => {
    const out = redact("Card 4111111111111111\r\nMILK 2L 3.10\rBREAD 2.70");
    expect(out.split("\n")).toHaveLength(3);
    expect(out).not.toContain("4111");
  });

  it("redacts an item line's numbers without touching its words", () => {
    expect(redactReceiptLine("9300633123456 FULL CREAM MILK 2L")).not.toContain("9300633123456");
    // The number is removed, not replaced, so what remains is exactly the product's words.
    expect(redactReceiptLine("9300633123456 FULL CREAM MILK 2L")).toBe("FULL CREAM MILK 2L");
    expect(redactReceiptLine("W/M FULL CREAM 2L")).toBe("W/M FULL CREAM 2L");
    // Labels are not applied to item lines: "Name brand" is a product, not a person.
    expect(redactReceiptLine("NAME BRAND PASTA 500G")).toBe("NAME BRAND PASTA 500G");
    expect(redactReceiptLine("GIFT CARD 50.00")).toBe("GIFT CARD 50.00");
  });
});

// ─── Adversarial ────────────────────────────────────────────────────────────

describe("adversarial input", () => {
  it("cannot be made to run for long (matching stays linear on runs of digits, masks, spaces and hyphens)", () => {
    const attacks = [
      "1 ".repeat(5000),
      "-".repeat(100_000),
      "*".repeat(50_000),
      "*1".repeat(20_000),
      "4111 ".repeat(10_000),
      "a".repeat(100_000) + "@",
      "a@" + "b.".repeat(30_000),
      "@".repeat(50_000),
      ("(" + "1".repeat(10) + ") ").repeat(3000),
      "0".repeat(100_000),
      `${"Shop 3, ".repeat(5000)}480 Kent St`,
      `${"unit ".repeat(8000)}1 st`,
      "http://" + "a".repeat(100_000),
      "ph:" + " 1".repeat(40_000),
      "x".repeat(50_000) + " 1234",
      `${"VISA ".repeat(10_000)}ending`,
      ("Served by " + "x".repeat(100) + "\n").repeat(1000),
      "\n".repeat(200_000),
      "7".repeat(200_000),
      "xX".repeat(100_000),
      "XXXX ".repeat(40_000),
      "•".repeat(100_000),
      "1-".repeat(100_000),
      "1  ".repeat(60_000),
      `${"*".repeat(200)} ${"x".repeat(200)} 1234`.repeat(100),
    ];
    for (const attack of attacks) {
      const started = performance.now();
      redact(attack);
      redactReceiptLine(attack);
      expect(performance.now() - started, `slow on ${attack.slice(0, 20)}…`).toBeLessThan(300);
    }
  });

  it("bounds what it returns", () => {
    expect(redactReceiptLine("x".repeat(10_000)).length).toBeLessThanOrEqual(10_000);
    const out = redact("y".repeat(MAX_REDACT_LINE * 5));
    expect(out.length).toBeLessThanOrEqual(MAX_REDACT_LINE);
    expect(redact(("line 1.00\n").repeat(100_000)).length).toBeLessThanOrEqual(40_000);
  });

  it("finds numbers hidden in noise around them", () => {
    for (const line of [
      "*4111111111111111*",
      "(4111111111111111)",
      "#4111111111111111",
      "CARD:4111111111111111.",
      "ref4111111111111111x",
      "4111  1111  1111 1111",
      "4111 - 1111 - 1111 - 1111",
    ]) {
      expect(redact(line), line).not.toMatch(/4111\D*1111\D*1111/);
    }
  });

  it("does not let a private value ride along in a price-looking line", () => {
    const out = redact("Served by Jane Citizen   3.10");
    expect(out).not.toContain("Jane");
    expect(out).toContain("3.10");
  });

  it("handles control characters, odd unicode and embedded nulls", () => {
    const out = redact("Card\u0000 4111\u0007 1111 1111\u0000 1111‮\nPh: (02) 9000 1234");
    expect(out).not.toMatch(/4111|9000/);
  });

  it("does not turn a placeholder back into data or grow with repeated passes", () => {
    const once = redact("Card 4111 1111 1111 1111");
    expect(once).toBe(redact(once));
    expect(once.length).toBeLessThan(40);
  });

  it("does not mistake prices, dates or product sizes for identifiers", () => {
    for (const line of [
      "WW WATER 24PK 375ML           5.50",
      "COKE 30X375ML                 28.00",
      "SMITHS CHIPS 12 X 18G         6.00",
      "BEEF MINCE 1.234KG 12.34",
      "CIGARETTE LIGHTERS 50 PACK    7.00",
      "20/09/2026 12:30",
      "2026-09-20T12:30:00",
      "QTY 12  @ 1.25  15.00",
      "LOTTO 1234567 NUMBERS",
    ]) {
      expect(redact(line), line).toBe(line);
    }
  });
});
