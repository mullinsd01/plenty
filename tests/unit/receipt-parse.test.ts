import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FINGERPRINT_MIN_LINE_PRICES, fnv1a64Hex, receiptFingerprint } from "@/lib/receipts/fingerprint";
import { parseReceiptText, sumReceiptLines, type ParsedReceipt, type ParsedReceiptLine } from "@/lib/receipts/parse";
import { assessReceiptQuality, BLURRY_BELOW, RECEIPT_QUALITY_MESSAGES, type ReceiptQualityInput } from "@/lib/receipts/quality";

const TODAY = "2026-09-30";
const FIXTURES = path.resolve(__dirname, "../fixtures/receipts");

/** The fields that matter for most assertions, in a compact form. */
function items(parsed: ParsedReceipt): Array<Pick<ParsedReceiptLine, "description" | "price">> {
  return parsed.lines.map(({ description, price }) => ({ description, price }));
}

function line(parsed: ParsedReceipt, description: string): ParsedReceiptLine {
  const found = parsed.lines.find((l) => l.description === description);
  if (!found) throw new Error(`No line "${description}" in: ${parsed.lines.map((l) => l.description).join(", ")}`);
  return found;
}

// ─── Realistic receipts ─────────────────────────────────────────────────────

const WOOLWORTHS = `
               WOOLWORTHS
       Woolworths Metro Town Hall
          Shop 3, 480 Kent St
            Sydney NSW 2000
           Ph: (02) 9000 1234
           ABN 12 345 678 901
              TAX INVOICE
----------------------------------------
W/M FULL CREAM 2L                   3.10
BANANAS KG
  0.842 kg NET @ $3.90/kg           3.28
WW WHITE BREAD 700G                 2.70
WW FREE RANGE EGGS 12PK             6.20
SAN REMO SPAGHETTI 500G
  2 @ $2.00 EACH                    4.00
MUTTI PASSATA 700G                  3.50
  LESS SPECIAL                     -1.00
BEGA TASTY CHEESE 500G              9.00
  PRICE REDUCED                    -1.50
  MEMBER PRICE                     -0.50
CARRY BAG                           0.15
----------------------------------------
8 SUBTOTAL                        $28.93
TOTAL                             $28.93
EFTPOS                            $28.93
Total includes GST                 $0.01
----------------------------------------
YOU SAVED                          $3.00
26/09/2026 17:42  STORE 1234  LANE 5
EVERYDAY REWARDS CARD ****4821
POINTS EARNED THIS SHOP               28
     THANK YOU FOR SHOPPING WITH US
`;

const COLES_EXPRESS = `
Coles Express
Coles Express Surry Hills 4521
ABN 45 678 901 234
Tax Invoice
Coles Full Cream Milk 3L          $4.65
Hass Avocado Each                 $5.70
  3 @ $1.90 each
Coles Greek Yoghurt 1kg           $5.80
  Promotion                      -$1.00
Coles Wild Rocket 120g            $3.00
Total for 6 items:               $18.15
Mastercard                       $18.15
GST included in total             $0.00
29/09/26 10:15  Store 4521  Lane 1
flybuys 6008 **** **** 1234
`;

const ALDI = `
ALDI STORES
A LIMITED PARTNERSHIP
ABN 23 456 789 012
TAX INVOICE
FARMDALE FULL CREAM MILK 2L       3.19 A
REMANO PENNE PASTA 500G
  2 x 1.19                        2.38 A
BROCCOLI KG
  0.456 kg @ $4.99/kg             2.28 A
COOKED PRAWNS 500G               12.99 A
SUBTOTAL                         20.84
**** TOTAL                       20.84
EFTPOS                           20.84
19.09.26  14:05  0123 04 5678
`;

const COUNTDOWN_NZ = `
COUNTDOWN
Countdown Ponsonby
7 Williamson Ave, Grey Lynn
Ph: 09 360 1234
GST No: 045-903-213
TAX INVOICE
ANCHOR BLUE TOP MILK 2L       4.35
BANANAS KG
  1.020 kg @ $3.49/kg         3.56
TIP TOP BREAD 700G            3.80
PAMS FREE RANGE EGGS 12PK     8.49
  ONECARD PRICE              -1.00
KUMARA KG
  0.750 kg @ $4.99/kg         3.74
5 BALANCE DUE                22.94
EFTPOS                       22.94
GST INCLUDED                  2.99
25/09/2026 16:02  LANE 4  OP 17
`;

const TESCO_UK = `
TESCO
Tesco Express
123 High Street, London SE1 7AB
VAT Number: GB 123 4567 89
TESCO SEMI SKIMMED MILK 4PT     £1.45
BANANAS LOOSE
  0.905 kg @ £0.94/kg           £0.85
TESCO CHICKEN BREAST 650G       £4.75
  Cc Clubcard Price            -£0.75
HEINZ BAKED BEANS 415G
  2 @ £1.40                     £2.80
CARRIER BAG                     £0.10
SUBTOTAL                        £9.20
TOTAL TO PAY                    £9.20
VISA DEBIT                      £9.20
VAT A 0.00%                     £0.00
22 Sep 2026 18:05  STORE 2045  OP 123
CLUBCARD POINTS THIS VISIT         9
`;

const SAINSBURYS_UK = `
Sainsbury's
Sainsbury's Supermarkets Ltd
33 Holborn, London EC1N 2HT
VAT Number: 660 4548 36
SS SEMI SKIMMED MILK 2.27L    £1.45
SS BRITISH CHICKEN THIGHS     £3.50
  NECTAR PRICE SAVING        -£0.75
HOVIS SOFT WHITE 800G         £1.40
  2 @ £1.40                   £2.80
LOOSE ONIONS
  0.412 kg @ £1.10/kg         £0.45
BALANCE DUE                   £7.45
Visa Contactless              £7.45
Nectar card no *******1234
Points earned 7
Sep 21, 2026  11:32
`;

const WALMART_US = `
Walmart
Save money. Live better.
( 479 ) 273 - 4134
MANAGER JOHN SMITH
1234 SE WALTON BLVD
BENTONVILLE AR 72712
ST# 00100 OP# 009044 TE# 44 TR# 01301
BANANAS 000000004011KF        1.24 N
  2.13 lb @ 1 lb /0.58
GV WHL MLK 007874235186 F     3.12 N
EGGS 18CT 007874203151 F      4.26 N
GV BREAD 007874237003 F       1.42 N
DORITOS 002840019914          4.48 X
  2 AT 1 FOR 2.24
SUBTOTAL                     14.52
TAX 1  7.000 %                0.31
TOTAL                        14.83
VISA TEND                    14.83
ACCOUNT # **** **** **** 1234 S
CHANGE DUE                    0.00
# ITEMS SOLD 6
09/12/26  18:45:12
`;

const KROGER_US = `
KROGER
Your Kroger Store Name
123 MAIN ST
CINCINNATI OH 45202
(513) 555-0123
KRO 2% MILK GAL               3.49 B
  2 @ 1.25
KRO FROZEN VEG                2.50 B
  1.87 lb @ 0.59 /lb
WT BANANAS                    1.10 B
PRIVATE SEL BREAD             3.99 B
  SC KROGER SAVINGS           1.00-
TAX                           0.00
**** BALANCE                 10.08
VISA DEBIT                   10.08
CHANGE                        0.00
TOTAL NUMBER OF ITEMS SOLD = 6
TOTAL SAVINGS                 1.00
09/27/26 7:14pm 402 29 108 52
`;

describe("parseReceiptText — Australian receipts", () => {
  it("reads a Woolworths receipt: weighed, multi-quantity and discounted items", () => {
    const parsed = parseReceiptText(WOOLWORTHS, { today: TODAY });
    expect(parsed.store).toBe("Woolworths");
    expect(parsed.purchasedOn).toBe("2026-09-26");
    expect(parsed.total).toBe(28.93);
    expect(parsed.subtotal).toBe(28.93);
    expect(parsed.warnings).toEqual([]);
    expect(items(parsed)).toEqual([
      { description: "W/M FULL CREAM 2L", price: 3.1 },
      { description: "BANANAS", price: 3.28 },
      { description: "WW WHITE BREAD 700G", price: 2.7 },
      { description: "WW FREE RANGE EGGS 12PK", price: 6.2 },
      { description: "SAN REMO SPAGHETTI 500G", price: 4 },
      { description: "MUTTI PASSATA 700G", price: 2.5 },
      { description: "BEGA TASTY CHEESE 500G", price: 7 },
      { description: "CARRY BAG", price: 0.15 },
    ]);
    expect(line(parsed, "BANANAS")).toMatchObject({ weightKg: 0.842, unitPrice: 3.9, quantity: null, raw: "BANANAS KG\n0.842 kg NET @ $3.90/kg           3.28" });
    expect(line(parsed, "SAN REMO SPAGHETTI 500G")).toMatchObject({ quantity: 2, unitPrice: 2, weightKg: null });
    expect(line(parsed, "MUTTI PASSATA 700G").discount).toBe(1);
    // Two discounts on one item accumulate.
    expect(line(parsed, "BEGA TASTY CHEESE 500G").discount).toBe(2);
    expect(sumReceiptLines(parsed.lines)).toBe(28.93);
  });

  it("reads a Coles Express receipt with $ prices, quantity-below lines and a 2-digit year", () => {
    const parsed = parseReceiptText(COLES_EXPRESS, { today: TODAY });
    expect(parsed.store).toBe("Coles");
    expect(parsed.purchasedOn).toBe("2026-09-29");
    expect(parsed.total).toBe(18.15);
    expect(parsed.subtotal).toBeNull();
    expect(items(parsed)).toEqual([
      { description: "Coles Full Cream Milk 3L", price: 4.65 },
      { description: "Hass Avocado Each", price: 5.7 },
      { description: "Coles Greek Yoghurt 1kg", price: 4.8 },
      { description: "Coles Wild Rocket 120g", price: 3 },
    ]);
    // The line total stays; the quantity line adds count and unit price.
    expect(line(parsed, "Hass Avocado Each")).toMatchObject({ quantity: 3, unitPrice: 1.9, price: 5.7 });
    expect(parsed.warnings).toEqual([]);
  });

  it("reads an Aldi receipt with 'x' quantities, trailing GST flags and a dotted date", () => {
    const parsed = parseReceiptText(ALDI, { today: TODAY });
    expect(parsed.store).toBe("Aldi");
    expect(parsed.purchasedOn).toBe("2026-09-19");
    expect(parsed.total).toBe(20.84);
    expect(items(parsed)).toEqual([
      { description: "FARMDALE FULL CREAM MILK 2L", price: 3.19 },
      { description: "REMANO PENNE PASTA 500G", price: 2.38 },
      { description: "BROCCOLI", price: 2.28 },
      { description: "COOKED PRAWNS 500G", price: 12.99 },
    ]);
    expect(line(parsed, "REMANO PENNE PASTA 500G")).toMatchObject({ quantity: 2, unitPrice: 1.19 });
    expect(line(parsed, "BROCCOLI")).toMatchObject({ weightKg: 0.456, unitPrice: 4.99 });
  });
});

describe("parseReceiptText — New Zealand, UK and US receipts", () => {
  it("reads a Countdown (NZ) receipt with BALANCE DUE and a loyalty price", () => {
    const parsed = parseReceiptText(COUNTDOWN_NZ, { today: TODAY });
    expect(parsed.store).toBe("Countdown");
    expect(parsed.purchasedOn).toBe("2026-09-25");
    expect(parsed.total).toBe(22.94);
    expect(items(parsed)).toEqual([
      { description: "ANCHOR BLUE TOP MILK 2L", price: 4.35 },
      { description: "BANANAS", price: 3.56 },
      { description: "TIP TOP BREAD 700G", price: 3.8 },
      { description: "PAMS FREE RANGE EGGS 12PK", price: 7.49 },
      { description: "KUMARA", price: 3.74 },
    ]);
    expect(line(parsed, "KUMARA")).toMatchObject({ weightKg: 0.75, unitPrice: 4.99 });
    expect(parsed.warnings).toEqual([]);
  });

  it("reads a Tesco (UK) receipt with £ prices, a Clubcard price and a textual date", () => {
    const parsed = parseReceiptText(TESCO_UK, { today: TODAY });
    expect(parsed.store).toBe("Tesco");
    expect(parsed.purchasedOn).toBe("2026-09-22");
    expect(parsed.total).toBe(9.2);
    expect(items(parsed)).toEqual([
      { description: "TESCO SEMI SKIMMED MILK 4PT", price: 1.45 },
      { description: "BANANAS LOOSE", price: 0.85 },
      { description: "TESCO CHICKEN BREAST 650G", price: 4 },
      { description: "HEINZ BAKED BEANS 415G", price: 2.8 },
      { description: "CARRIER BAG", price: 0.1 },
    ]);
    expect(line(parsed, "TESCO CHICKEN BREAST 650G").discount).toBe(0.75);
    expect(parsed.warnings).toEqual([]);
  });

  it("reads a Sainsbury's (UK) receipt: the quantity line total replaces the unit price", () => {
    const parsed = parseReceiptText(SAINSBURYS_UK, { today: TODAY });
    expect(parsed.store).toBe("Sainsbury's");
    expect(parsed.purchasedOn).toBe("2026-09-21");
    expect(parsed.total).toBe(7.45);
    expect(line(parsed, "HOVIS SOFT WHITE 800G")).toMatchObject({ quantity: 2, unitPrice: 1.4, price: 2.8 });
    expect(line(parsed, "SS BRITISH CHICKEN THIGHS")).toMatchObject({ price: 2.75, discount: 0.75 });
    expect(line(parsed, "LOOSE ONIONS")).toMatchObject({ weightKg: 0.412, price: 0.45 });
    expect(line(parsed, "SS SEMI SKIMMED MILK 2.27L").price).toBe(1.45);
    expect(parsed.warnings).toEqual([]);
  });

  it("reads a Walmart (US) receipt: barcodes, tax added on top and a month-first date", () => {
    const parsed = parseReceiptText(WALMART_US, { today: TODAY });
    expect(parsed.store).toBe("Walmart");
    // 09/12/26 is 12 September for an American store (it would be 9 December in Australia).
    expect(parsed.purchasedOn).toBe("2026-09-12");
    expect(parsed.subtotal).toBe(14.52);
    expect(parsed.total).toBe(14.83);
    expect(items(parsed)).toEqual([
      { description: "BANANAS", price: 1.24 },
      { description: "GV WHL MLK", price: 3.12 },
      { description: "EGGS 18CT", price: 4.26 },
      { description: "GV BREAD", price: 1.42 },
      { description: "DORITOS", price: 4.48 },
    ]);
    // Pounds are converted: 2.13 lb = 0.966 kg at $0.58/lb = $1.28/kg.
    expect(line(parsed, "BANANAS")).toMatchObject({ weightKg: 0.966, unitPrice: 1.28 });
    expect(line(parsed, "DORITOS")).toMatchObject({ quantity: 2, unitPrice: 2.24 });
    // Items add up to the pre-tax subtotal, so no mismatch is reported.
    expect(parsed.warnings).toEqual([]);
  });

  it("reads a Kroger (US) receipt where quantity and weight lines sit above their item", () => {
    const parsed = parseReceiptText(KROGER_US, { today: TODAY });
    expect(parsed.store).toBe("Kroger");
    expect(parsed.purchasedOn).toBe("2026-09-27");
    expect(parsed.total).toBe(10.08);
    expect(line(parsed, "KRO 2% MILK GAL")).toMatchObject({ quantity: null, price: 3.49 });
    expect(line(parsed, "KRO FROZEN VEG")).toMatchObject({ quantity: 2, unitPrice: 1.25, price: 2.5, raw: "2 @ 1.25\nKRO FROZEN VEG                2.50 B" });
    expect(line(parsed, "BANANAS")).toMatchObject({ weightKg: 0.848, price: 1.1 });
    // "1.00-" is a US-style negative amount.
    expect(line(parsed, "PRIVATE SEL BREAD")).toMatchObject({ price: 2.99, discount: 1 });
    expect(parsed.warnings).toEqual([]);
  });
});

describe("parseReceiptText — OCR noise", () => {
  const NOISY_WOOLWORTHS = `
  W00LWORTHS
Wo0lworths Metro Town Hall
| ABN 12 345 678 901
w/m full cream 2l                  3.1O
bananas kg
  0.842 kg net @ $3.9O/kg          2:28 '
WW WHITE BREAD 700G               S.70 A
ww free range eggs 12pk          6 .20
SAN REMO SPAGHETTI 500G
  2 @ $ 2.00 each                  4.0O
MUTTI PASSATA 700G                 3.50
  less special                   - l.00
CARRY BAG                          O.15 |
SUBT0TAL                         $23.93
T0TAL                            $23.93
EFTP0S                           $23.93
26/O9/2026 17:42 STORE 1234
`;

  it("repairs O/0, S/5, l/1, colon decimals, broken spacing, stray characters and lower case", () => {
    const parsed = parseReceiptText(NOISY_WOOLWORTHS, { today: TODAY });
    expect(parsed.store).toBe("Woolworths");
    expect(parsed.purchasedOn).toBe("2026-09-26");
    expect(parsed.subtotal).toBe(23.93);
    expect(parsed.total).toBe(23.93);
    expect(items(parsed)).toEqual([
      { description: "w/m full cream 2l", price: 3.1 },
      { description: "bananas", price: 2.28 },
      { description: "WW WHITE BREAD 700G", price: 5.7 },
      { description: "ww free range eggs 12pk", price: 6.2 },
      { description: "SAN REMO SPAGHETTI 500G", price: 4 },
      { description: "MUTTI PASSATA 700G", price: 2.5 },
      { description: "CARRY BAG", price: 0.15 },
    ]);
    expect(line(parsed, "bananas").weightKg).toBe(0.842);
    expect(parsed.warnings).toEqual([]);
  });

  it("recognises store names despite OCR errors, and from footers or loyalty programmes", () => {
    expect(parseReceiptText("WOOLWDRTHS SUPERMARKETS\nMILK 2L 3.10").store).toBe("Woolworths");
    expect(parseReceiptText("Woolies Bondi\nMILK 2L 3.10").store).toBe("Woolworths");
    expect(parseReceiptText("ALDI STORES\nMILK 2L 3.10").store).toBe("Aldi");
    expect(parseReceiptText("PAK'nSAVE Albany\nMILK 2L 3.10").store).toBe("Pak'nSave");
    expect(parseReceiptText("PAK N SAVE\nMILK 2L 3.10").store).toBe("Pak'nSave");
    expect(parseReceiptText("Wal-Mart Supercenter\nMILK 3.10").store).toBe("Walmart");
    expect(parseReceiptText("SAINSBURYS LOCAL\nMILK 1.45").store).toBe("Sainsbury's");
    expect(parseReceiptText("TRADER JOES #552\nBANANA 0.29").store).toBe("Trader Joe's");
    const footer = ["TAX INVOICE", "Milk 2L $3.10", "Bread $3.00", "Eggs $6.20", "Butter $5.00", "Cheese $9.00", "Yoghurt $4.00", "Apples $3.00", "Total $33.30", "Thank you for shopping at Coles"];
    expect(parseReceiptText(footer.join("\n")).store).toBe("Coles");
    expect(parseReceiptText("TAX INVOICE\nMILK 2L 3.10\nFLYBUYS 6008 1234").store).toBe("Coles");
    const unknown = parseReceiptText("FRIENDLY GROCER NEWTOWN\nMILK 2L 3.10\nTOTAL 3.10");
    expect(unknown.store).toBeNull();
    expect(unknown.warnings).toContain("no_store");
  });
});

describe("parseReceiptText — dates", () => {
  const withDate = (date: string, header = "WOOLWORTHS") => `${header}\nMILK 2L 3.10\nTOTAL 3.10\n${date}`;
  const dateOf = (date: string, header?: string) => parseReceiptText(withDate(date, header), { today: TODAY }).purchasedOn;

  it("reads day-first, ISO and textual dates", () => {
    expect(dateOf("26/09/2026 17:42")).toBe("2026-09-26");
    expect(dateOf("26-09-2026")).toBe("2026-09-26");
    expect(dateOf("26.09.26 17:42")).toBe("2026-09-26");
    expect(dateOf("2026-09-26T17:42")).toBe("2026-09-26");
    expect(dateOf("12 Mar 2025")).toBe("2025-03-12");
    expect(dateOf("12-MAR-25 10:01")).toBe("2025-03-12");
    expect(dateOf("Date: 3rd September 2026")).toBe("2026-09-03");
    expect(dateOf("Mar 12, 2026")).toBe("2026-03-12");
  });

  it("prefers day-first unless the store is American, and falls back when day-first is impossible", () => {
    expect(dateOf("03/04/2026")).toBe("2026-04-03");
    expect(dateOf("03/04/2026", "WALMART")).toBe("2026-03-04");
    expect(dateOf("09/26/2026")).toBe("2026-09-26");
    // Day-first would be in the future (9 December), month-first is plausible.
    expect(dateOf("09/12/2026")).toBe("2026-09-12");
  });

  it("rejects dates in the future or more than two years old, with a warning", () => {
    const future = parseReceiptText(withDate("12/10/2026 09:00"), { today: TODAY });
    expect(future.purchasedOn).toBeNull();
    expect(future.warnings).toEqual(expect.arrayContaining(["no_date", "date_in_future"]));
    const old = parseReceiptText(withDate("26/09/2023 09:00"), { today: TODAY });
    expect(old.purchasedOn).toBeNull();
    expect(old.warnings).toEqual(expect.arrayContaining(["no_date", "date_too_old"]));
    // Without `today` nothing can be judged, so the printed date is used.
    expect(parseReceiptText(withDate("26/09/2023 09:00")).purchasedOn).toBe("2023-09-26");
  });

  it("prefers the transaction date over promotional 'valid until' dates", () => {
    const text = "COLES\nMILK 2L 3.10\nTOTAL 3.10\nOffer valid until 20/09/2026\n19/09/2026 14:05 Lane 3";
    expect(parseReceiptText(text, { today: TODAY }).purchasedOn).toBe("2026-09-19");
  });

  it("warns when there is no date at all", () => {
    expect(parseReceiptText("COLES\nMILK 2L 3.10\nTOTAL 3.10", { today: TODAY }).warnings).toEqual(["no_date"]);
  });
});

describe("parseReceiptText — lines and totals", () => {
  it("handles inline quantities, leading multipliers and glued prices", () => {
    const parsed = parseReceiptText("COLES\nMILK 2L 2 @ 2.10 4.20\n2 X BREAD 700G 6.00\nCOKE 1.25L3.50\nWATER 1.5L 2 1.20 2.40", { today: TODAY });
    expect(parsed.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.price])).toEqual([
      ["MILK 2L", 2, 2.1, 4.2],
      ["BREAD 700G", 2, 3, 6],
      ["COKE 1.25L", null, null, 3.5],
      ["WATER 1.5L", 2, 1.2, 2.4],
    ]);
  });

  it("never mistakes product names for totals, discounts or register details", () => {
    const text = [
      "WOOLWORTHS",
      "TOTAL GREEK YOGHURT 500G 6.50",
      "SPECIAL K CEREAL 500G 7.00",
      "COKE REG 1.25L 3.50",
      "BALANCE ENERGY BAR 2.00",
      "BIRTHDAY CARD 4.95",
      "SUBTOTAL 23.95",
      "TOTAL 23.95",
    ].join("\n");
    const parsed = parseReceiptText(text, { today: TODAY });
    expect(items(parsed)).toEqual([
      { description: "TOTAL GREEK YOGHURT 500G", price: 6.5 },
      { description: "SPECIAL K CEREAL 500G", price: 7 },
      { description: "COKE REG 1.25L", price: 3.5 },
      { description: "BALANCE ENERGY BAR", price: 2 },
      { description: "BIRTHDAY CARD", price: 4.95 },
    ]);
    expect(parsed.total).toBe(23.95);
  });

  it("ignores discounts with nothing to apply to, and summary savings bigger than the item", () => {
    const parsed = parseReceiptText("WOOLWORTHS\nLESS SPECIAL -1.00\nMILK 2L 3.10\nMULTI BUY SAVING -5.00\nTOTAL 3.10", { today: TODAY });
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]).toMatchObject({ price: 3.1, discount: null });
  });

  it("stops reading items at the total and skips payment, loyalty and footer lines", () => {
    const text = "COLES\nMILK 2L $3.10\nTOTAL $3.10\nEFTPOS $3.10\nCASH $10.00\nCHANGE $6.90\nROUNDING -$0.02\nBREAD 3.00\nflybuys points 3";
    const parsed = parseReceiptText(text, { today: TODAY });
    expect(items(parsed)).toEqual([{ description: "MILK 2L", price: 3.1 }]);
  });

  it("uses the card payment as the total when no total line was read", () => {
    const parsed = parseReceiptText("COLES\nMILK 2L $3.10\nBREAD $3.00\nEFTPOS $6.10\n29/09/2026 10:00", { today: TODAY });
    expect(parsed.total).toBe(6.1);
    expect(parsed.warnings).toEqual([]);
  });

  it("flags a total mismatch beyond 5% but tolerates small differences", () => {
    const missingLine = parseReceiptText("COLES\nMILK 2L $3.10\nBREAD $3.00\nTOTAL $12.10\n29/09/2026 10:00", { today: TODAY });
    expect(missingLine.warnings).toEqual(["total_mismatch"]);
    const rounding = parseReceiptText("COLES\nMILK 2L $3.10\nBREAD $3.00\nTOTAL $6.30\n29/09/2026 10:00", { today: TODAY });
    expect(rounding.warnings).toEqual([]);
  });

  it("reports no items for empty, blank or non-receipt text without throwing", () => {
    for (const text of ["", "   \n\n  ", "The quick brown fox jumps over the lazy dog.\nPage 3 of 7", "ee ae\n|||| ___\n~~"]) {
      const parsed = parseReceiptText(text, { today: TODAY });
      expect(parsed.lines).toEqual([]);
      expect(parsed.warnings).toEqual(["no_items_found", "no_date", "no_store"]);
      expect(parsed.total).toBeNull();
    }
  });

  it("accepts Windows line endings and ignores an invalid `today`", () => {
    const parsed = parseReceiptText("ALDI\r\nMILK 2L 3.19\r\nTOTAL 3.19\r\n26/09/2019", { today: "not-a-date" });
    expect(parsed.store).toBe("Aldi");
    expect(parsed.purchasedOn).toBe("2019-09-26");
    expect(items(parsed)).toEqual([{ description: "MILK 2L", price: 3.19 }]);
  });
});

describe("parseReceiptText — generated sample receipts", () => {
  const manifest = JSON.parse(readFileSync(path.join(FIXTURES, "manifest.json"), "utf8")) as Record<
    string,
    { text: string | null; kind: string; expected: { store: string; purchasedOn: string; total: number; subtotal: number | null; items: unknown[] } | null }
  >;
  const receipts = Object.entries(manifest).filter(([, entry]) => entry.kind === "receipt");

  it("has the four sample receipts", () => {
    expect(receipts.map(([name]) => name)).toEqual(["woolworths-weekly", "coles-topup", "aldi-shop", "tesco-uk"]);
  });

  it.each(receipts)("parses the printed text of %s exactly", (_name, entry) => {
    const parsed = parseReceiptText(readFileSync(path.join(FIXTURES, entry.text ?? ""), "utf8"), { today: TODAY });
    const expected = entry.expected;
    expect(parsed.store).toBe(expected?.store);
    expect(parsed.purchasedOn).toBe(expected?.purchasedOn);
    expect(parsed.total).toBe(expected?.total);
    expect(parsed.lines.map(({ description, price, quantity, weightKg, discount }) => ({ description, price, quantity, weightKg, discount }))).toEqual(expected?.items);
    expect(parsed.warnings).toEqual([]);
  });
});

// ─── Fingerprints ───────────────────────────────────────────────────────────

describe("receiptFingerprint", () => {
  const base = { store: "Woolworths", purchasedOn: "2026-09-26", total: 68.61, linePrices: [3.1, 3.28, 2.7, 6.2] };

  it("implements FNV-1a 64 correctly", () => {
    expect(fnv1a64Hex("")).toBe("cbf29ce484222325");
    expect(fnv1a64Hex("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64Hex("foobar")).toBe("85944171f73967e8");
  });

  it("is a stable 32-hex-character string", () => {
    const fp = receiptFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    expect(receiptFingerprint({ ...base })).toBe(fp);
  });

  it("ignores line order, floating-point noise and store-name formatting", () => {
    const fp = receiptFingerprint(base);
    expect(receiptFingerprint({ ...base, linePrices: [6.2, 2.7, 3.28, 3.1] })).toBe(fp);
    expect(receiptFingerprint({ ...base, total: 68.610000001, linePrices: [3.1000000001, 3.28, 2.7, 6.2] })).toBe(fp);
    expect(receiptFingerprint({ ...base, store: "  WOOLWORTHS " })).toBe(fp);
    expect(receiptFingerprint({ ...base, linePrices: [...base.linePrices, Number.NaN] })).toBe(fp);
  });

  it("changes when the store, date, total or any line price changes", () => {
    const fp = receiptFingerprint(base);
    const variants = [
      { ...base, store: "Coles" },
      { ...base, store: null },
      { ...base, purchasedOn: "2026-09-27" },
      { ...base, total: 68.62 },
      { ...base, linePrices: [3.1, 3.28, 2.7, 6.21] },
      { ...base, linePrices: [3.1, 3.28, 2.7] },
    ];
    const fingerprints = variants.map(receiptFingerprint);
    expect(fingerprints).not.toContain(fp);
    expect(new Set(fingerprints).size).toBe(variants.length);
  });

  it("returns null without a valid date, or without a total and enough line prices", () => {
    expect(receiptFingerprint({ ...base, purchasedOn: null })).toBeNull();
    expect(receiptFingerprint({ ...base, purchasedOn: "26/09/2026" })).toBeNull();
    expect(receiptFingerprint({ ...base, total: null, linePrices: [3.1, 3.28] })).toBeNull();
    expect(receiptFingerprint({ ...base, total: 0, linePrices: [] })).toBeNull();
    const pricesOnly = receiptFingerprint({ ...base, total: null, linePrices: [3.1, 3.28, 2.7].slice(0, FINGERPRINT_MIN_LINE_PRICES) });
    expect(pricesOnly).toMatch(/^[0-9a-f]{32}$/);
    expect(receiptFingerprint({ ...base, total: null, store: null, linePrices: [] })).toBeNull();
  });
});

// ─── Quality ────────────────────────────────────────────────────────────────

describe("assessReceiptQuality", () => {
  const goodText = readFileSync(path.join(FIXTURES, "woolworths-weekly.txt"), "utf8");
  const goodParse = parseReceiptText(goodText, { today: TODAY });
  const input = (overrides: Partial<ReceiptQualityInput> = {}): ReceiptQualityInput => ({
    ocrConfidence: 91,
    text: goodText,
    blurScore: 3000,
    width: 957,
    height: 2000,
    parsed: goodParse,
    ...overrides,
  });

  it("passes a sharp, complete receipt", () => {
    expect(assessReceiptQuality(input())).toEqual({ ok: true, warnings: [], message: null });
  });

  it("asks for a retake when the photo is blurry and the reading is poor", () => {
    const garbled = "W00lwrths Metre Tawn\nWW WHT BRAD 7O0G 2.7O\nTOTAL";
    const result = assessReceiptQuality(input({ blurScore: BLURRY_BELOW - 1, ocrConfidence: 40, text: garbled, parsed: parseReceiptText(garbled, { today: TODAY }) }));
    expect(result.ok).toBe(false);
    expect(result.warnings).toContain("blurry");
    expect(result.message).toBe("This photo looks a bit blurry — try again in better light, holding the phone steady.");
  });

  it("keeps a slightly blurry photo whose items still add up to the total", () => {
    const result = assessReceiptQuality(input({ blurScore: BLURRY_BELOW / 2 }));
    expect(result).toEqual({ ok: true, warnings: ["blurry"], message: RECEIPT_QUALITY_MESSAGES.blurry });
  });

  it("treats low OCR confidence as blur when the image score is unknown", () => {
    const result = assessReceiptQuality(input({ blurScore: null, ocrConfidence: 50, parsed: { ...goodParse, total: null } }));
    expect(result.warnings).toEqual(["blurry", "partial"]);
    expect(result.ok).toBe(false);
  });

  it("reports an empty photo when OCR finds no words", () => {
    const empty = assessReceiptQuality(input({ text: "  2 i a\np  a 3 \n", ocrConfidence: 27, blurScore: 33, parsed: parseReceiptText("", { today: TODAY }) }));
    expect(empty.ok).toBe(false);
    expect(empty.warnings[0]).toBe("empty");
    expect(empty.message).toBe(RECEIPT_QUALITY_MESSAGES.empty);
  });

  it("recognises sharp, readable text that isn't a receipt", () => {
    const prose = "Dear Sam,\nThanks for looking after the dog while we were away.\nThe spare key is under the pot plant near the back door.\nSee you on Sunday!";
    const result = assessReceiptQuality(input({ text: prose, parsed: parseReceiptText(prose, { today: TODAY }) }));
    expect(result).toEqual({ ok: false, warnings: ["not_a_receipt"], message: RECEIPT_QUALITY_MESSAGES.not_a_receipt });
  });

  it("flags a receipt with its total cut off, without blocking review", () => {
    const cut = goodText.split("\n").slice(0, 20).join("\n");
    const result = assessReceiptQuality(input({ text: cut, parsed: parseReceiptText(cut, { today: TODAY }) }));
    expect(result).toEqual({ ok: true, warnings: ["partial"], message: RECEIPT_QUALITY_MESSAGES.partial });
  });

  it("flags small photos, blocking them only when the reading is inconsistent", () => {
    expect(assessReceiptQuality(input({ width: 480, height: 800 }))).toEqual({ ok: true, warnings: ["low_resolution"], message: RECEIPT_QUALITY_MESSAGES.low_resolution });
    const mismatched = { ...goodParse, warnings: ["total_mismatch"] };
    const result = assessReceiptQuality(input({ width: 480, height: 800, parsed: mismatched }));
    expect(result.ok).toBe(false);
    expect(result.warnings).toEqual(["low_resolution", "partial"]);
  });
});

// ─── Photographed receipts ──────────────────────────────────────────────────

/** A phone photo of a receipt on a speckled bench top: junk before each line, junk words after each price. */
const NOISY_PHOTO = `
~~   Woolworths                                       ©
©.   Potato Sweet Gold
CET 0.632 kg NET @ B4.30rkg               3.10     nal
Co #Woolworths Art Bag                     2.00    re,
CT Kiwifruit Gold Imp P/P 500g              5.90 ©]
|    ~~ Inghams Turkey Brst Half Oven Roast Kg          1.92     RAVE
~ +  Don Shredded Ham KG                      0.88     SE
_ f  Dorsogna Streaky Bacon ky                 0.75     SSRN
     © #S/Pots Macadamia Rst/Salt 120g                7.00     Se
  10 SUBTOTAL                          $29.02
`;

describe("parseReceiptText — margin noise from photos", () => {
  const parsed = parseReceiptText(NOISY_PHOTO, { today: TODAY });

  it("strips junk symbols and fragments before a line and junk words after its price", () => {
    expect(items(parsed)).toEqual([
      { description: "Potato Sweet Gold", price: 3.1 },
      { description: "Woolworths Art Bag", price: 2 },
      { description: "Kiwifruit Gold Imp P/P 500g", price: 5.9 },
      { description: "Inghams Turkey Brst Half Oven Roast Kg", price: 1.92 },
      { description: "Don Shredded Ham KG", price: 0.88 },
      { description: "Dorsogna Streaky Bacon kg", price: 0.75 },
      { description: "S/Pots Macadamia Rst/Salt 120g", price: 7 },
    ]);
    expect(parsed.store).toBe("Woolworths");
    expect(parsed.subtotal).toBe(29.02);
  });

  it("keeps the original line text in `raw`", () => {
    expect(parsed.lines[1].raw).toBe("Co #Woolworths Art Bag                     2.00    re,");
  });

  it("keeps a real # marker out of the name and never reads the junk as part of the name", () => {
    for (const l of parsed.lines) expect(l.description).not.toMatch(/^[#~©|_+]|^(?:Co|CT|CET)\b|\b(?:nal|re,|RAVE|SSRN)$/);
  });

  it("attaches a weighed line with a mangled unit price to the description above it", () => {
    expect(parsed.lines[0]).toMatchObject({ description: "Potato Sweet Gold", weightKg: 0.632, price: 3.1 });
    expect(parsed.lines[0].raw).toContain("0.632 kg NET @ B4.30rkg");
  });

  it("changes nothing in text without photo noise", () => {
    const clean = "WOOLWORTHS\nST AGNES BRANDY 29.00\nWW WHITE BREAD 700G 2.70 A\nA2 MILK 2L 4.00 T\nGF PASTA 500G 3.50\nCHK BRST FLT 1KG 12.00\nTOTAL 51.20";
    expect(items(parseReceiptText(clean))).toEqual([
      { description: "ST AGNES BRANDY", price: 29 },
      { description: "WW WHITE BREAD 700G", price: 2.7 },
      { description: "A2 MILK 2L", price: 4 },
      { description: "GF PASTA 500G", price: 3.5 },
      { description: "CHK BRST FLT 1KG", price: 12 },
    ]);
  });

  it("keeps real short words at the start of a line even in noisy text", () => {
    const text = ["© ST AGNES BRANDY     29.00   ", "~~ WW WHITE BREAD 700G     2.70   ", "| GF PASTA 500G    3.50  ", "| CHK BRST FLT 1KG    12.00  ", "TOTAL 47.20"].join("\n");
    expect(items(parseReceiptText(text)).map((i) => i.description)).toEqual(["ST AGNES BRANDY", "WW WHITE BREAD 700G", "GF PASTA 500G", "CHK BRST FLT 1KG"]);
  });

  it("drops two-letter junk before a line only in noisy text", () => {
    expect(items(parseReceiptText("CT MILK 2L 3.10\nTOTAL 3.10"))[0].description).toBe("CT MILK 2L");
    const noisy = "~~ MILK 2L 3.10 ©\n© EGGS 6.00 ~\nCT BREAD 3.00   x\nTOTAL 12.10";
    expect(items(parseReceiptText(noisy)).map((i) => i.description)).toEqual(["MILK 2L", "EGGS", "BREAD"]);
  });

  it("only strips words after a price when they are set apart from it", () => {
    const text = "WOOLWORTHS\nMILK 2L 3.10 A\nBREAD 3.00 T\nSPECIAL OFFER 2.00 EACH\nTOTAL 8.10";
    expect(items(parseReceiptText(text))).toEqual([
      { description: "MILK 2L", price: 3.1 },
      { description: "BREAD", price: 3 },
    ]);
    // A minus sign next to the price is a discount; the same dash far off in the margin is junk.
    expect(parseReceiptText("COLES\nMILK 2L 3.50\nLESS SPECIAL   1.00 -\nTOTAL 2.50").lines[0]).toMatchObject({ price: 2.5, discount: 1 });
    expect(items(parseReceiptText("COLES\nMILK 2L        3.50      -\nTOTAL 3.50"))).toEqual([{ description: "MILK 2L", price: 3.5 }]);
  });

  it("never strips real trailing words from a line without a price", () => {
    const text = "~~ WOOLWORTHS ©\n© BANANAS KG\n  0.842 kg NET @ $3.90/kg      3.28\n| FREE RANGE EGGS LARGE\n  2 @ $3.00 EACH      6.00\nTOTAL 9.28";
    const lines = parseReceiptText(text).lines;
    expect(lines.map((l) => [l.description, l.price])).toEqual([
      ["BANANAS", 3.28],
      ["FREE RANGE EGGS LARGE", 6],
    ]);
  });

  it("does not turn totals, payments, tax or footer lines into items", () => {
    const text = [
      "~~ Woolworths",
      "© Milk 2L                 3.10   re,",
      "CT 1 SUBTOTAL            $3.10",
      "~ TOTAL                  $3.10   x",
      "© Cash                  $5.00  ©",
      "| Change                $1.90  Se",
      "  TOTAL includes GST     $0.28   ",
      "~~ You could have collected at least 30 points   EN",
    ].join("\n");
    const result = parseReceiptText(text, { today: TODAY });
    expect(items(result)).toEqual([{ description: "Milk 2L", price: 3.1 }]);
    expect(result.total).toBe(3.1);
    expect(result.subtotal).toBe(3.1);
  });

  it("reads the photo's printed text from a fixture end to end", () => {
    const real = parseReceiptText(readFileSync(path.join(FIXTURES, "woolworths-phone-photo.txt"), "utf8"), { today: TODAY });
    expect(real.lines).toHaveLength(10);
    expect(real.store).toBe("Woolworths");
  });
});

describe("parseReceiptText — weighed items with a damaged unit price", () => {
  const weighed = (line: string) => parseReceiptText(`WOOLWORTHS\nPotato Sweet Gold\n${line}\nMandarin Loose\n 0.222 kg NET @ $4.90/kg   1.09\nTOTAL 4.19`, { today: TODAY }).lines[0];

  it.each([
    ["0.632 kg NET @ B4.30rkg 3.10", "a letter for the dollar sign and 'r' for the slash"],
    ["0.632 kg NET @ $4.3)/kg 3.10", "a bracket for a digit"],
    ["0.632 kg NET @ $4.xxkg      3.10", "an unreadable rate"],
    ["0.632 KG NET @ S4.9Okg 3.10", "S for $ and O for 0"],
    ["0.632 kq NET @ $4.90/kq 3.10", "q for g"],
    ["0.632 ky NET © $4.90/ky 3.10", "© for @"],
    ["CET 0.632 kg NET @ B4.30rkg 3.10     nal", "margin junk on both sides"],
  ])("takes the right-most price as the total: %s (%s)", (line) => {
    expect(weighed(line)).toMatchObject({ description: "Potato Sweet Gold", weightKg: 0.632, price: 3.1 });
  });

  it("does not price the item as weight × total when the unit price is unreadable", () => {
    // 0.632 × 3.10 = 1.96 was once reported as the price.
    const line = weighed("0.632 kg NET @ $4.3)/kg 3.10");
    expect(line.price).toBe(3.1);
    expect(line.unitPrice).toBeNull();
  });

  it("keeps a unit price that agrees with weight and total, and drops one that doesn't", () => {
    expect(weighed("0.632 kg NET @ S4.9Okg 3.10").unitPrice).toBe(4.9);
    expect(weighed("0.632 kg NET @ B4.30rkg 3.10").unitPrice).toBeNull();
  });

  it("leaves the price empty rather than guessing it when the total is unreadable", () => {
    const text = "WOOLWORTHS\nMandarin Amorette Seedless Loose\n 0.222 kg NET @ $4.30rkg    103   ar\nTotal 4.00";
    const line = parseReceiptText(text, { today: TODAY }).lines[0];
    expect(line).toMatchObject({ description: "Mandarin Amorette Seedless Loose", weightKg: 0.222, price: null, unitPrice: null });
  });

  it("reads clean weight lines as before", () => {
    const line = parseReceiptText("WOOLWORTHS\nBANANAS KG\n 0.842 kg NET @ $3.90/kg   3.28\nTOTAL 3.28", { today: TODAY }).lines[0];
    expect(line).toMatchObject({ description: "BANANAS", weightKg: 0.842, unitPrice: 3.9, price: 3.28 });
  });
});

describe("parseReceiptText — kg misreads on item lines", () => {
  it("reads a trailing 'ky' or 'kq' as kg when the line has a price", () => {
    const parsed = parseReceiptText("WOOLWORTHS\nDorsogna Streaky Bacon ky 0.75\nDON SHREDDED HAM KQ 0.88\nInghams Turkey Roast Kg 1.92\nTOTAL 3.55", { today: TODAY });
    expect(parsed.lines.map((l) => l.description)).toEqual(["Dorsogna Streaky Bacon kg", "DON SHREDDED HAM KG", "Inghams Turkey Roast Kg"]);
  });

  it("leaves other words alone", () => {
    const parsed = parseReceiptText("WOOLWORTHS\nKY JELLY 5.00\nSKY BLUE TEA 3.00\nTOTAL 8.00", { today: TODAY });
    expect(parsed.lines.map((l) => l.description)).toEqual(["KY JELLY", "SKY BLUE TEA"]);
  });
});

describe("parseReceiptText — a total that could not be read", () => {
  const items3 = "WOOLWORTHS\nMILK 2L 3.10\nBREAD 3.00\nEGGS 6.20";

  it("warns 'no_total' when the items run into the end of the text (the receipt may be cut off)", () => {
    expect(parseReceiptText(items3, { today: TODAY }).warnings).toEqual(["no_total", "no_date"]);
  });

  it("warns 'total_unreadable' instead when the receipt carries on below the items", () => {
    const below = `${items3}\nSUBTOT   \nTOTAL includes GS\nYou could have collected at least 30 points`;
    expect(parseReceiptText(below, { today: TODAY }).warnings).toEqual(["total_unreadable", "no_date"]);
    expect(parseReceiptText(`${items3}\nEFTPOS\n`, { today: TODAY }).warnings).toEqual(["total_unreadable", "no_date"]);
    expect(parseReceiptText(`${items3}\n26/09/2026 17:42  STORE 1234`, { today: TODAY }).warnings).toEqual(["total_unreadable"]);
  });

  it("warns 'total_unreadable' when a subtotal was read and matches the items", () => {
    const parsed = parseReceiptText(`${items3}\nSUBTOTAL 12.30`, { today: TODAY });
    expect(parsed.warnings).toEqual(["total_unreadable", "no_date"]);
    expect(parsed.subtotal).toBe(12.3);
  });

  it("warns 'total_mismatch' only when a total was read that the items don't match", () => {
    const parsed = parseReceiptText(`${items3}\nTOTAL 40.00`, { today: TODAY });
    expect(parsed.warnings).toEqual(["total_mismatch", "no_date"]);
  });

  it("says nothing when the items add up to a total that was read", () => {
    expect(parseReceiptText(`${items3}\nTOTAL 12.30\n26/09/2026`, { today: TODAY }).warnings).toEqual([]);
  });
});

describe("assessReceiptQuality — a total that could not be read", () => {
  const photoText = readFileSync(path.join(FIXTURES, "woolworths-phone-photo.txt"), "utf8");
  const photoParse = parseReceiptText(photoText, { today: TODAY });
  const assess = (parsed: ParsedReceipt) =>
    assessReceiptQuality({ ocrConfidence: 80, text: photoText, blurScore: 3000, width: 1500, height: 2000, parsed });

  it("does not claim the receipt is cut off when ten clean items were read and the receipt carries on below them", () => {
    expect(photoParse.lines).toHaveLength(10);
    expect(photoParse.warnings).toContain("total_unreadable");
    const result = assess(photoParse);
    expect(result.warnings).not.toContain("partial");
    expect(result.warnings).toEqual(["unclear"]);
    expect(result.ok).toBe(true);
  });

  it("still says part of the receipt may be missing when the items run into the end of the text", () => {
    const cut = parseReceiptText("WOOLWORTHS\nMILK 2L 3.10\nBREAD 3.00\nEGGS 6.20", { today: TODAY });
    expect(cut.warnings).toContain("no_total");
    expect(assess(cut).warnings).toEqual(["partial"]);
  });

  it("stays quiet when a subtotal that matches the items was read", () => {
    const parsed = parseReceiptText("WOOLWORTHS\nMILK 2L 3.10\nBREAD 3.00\nSUBTOTAL 6.10\n26/09/2026", { today: TODAY });
    expect(assess(parsed).warnings).toEqual([]);
  });
});

describe("parseReceiptText — total lines whose label could not be read", () => {
  const ITEMS = ["Potato Sweet Gold 3.10", "Mandarin Seedless 1.09", "Woolworths Art Bag 2.00", "Kiwifruit Gold 5.90", "Ham off Bone 2.38", "Salada Original 250g 4.00"];
  const text = (...footer: string[]) => ["WOOLWORTHS", ...ITEMS, ...footer].join("\n");

  it("does not turn a garbled subtotal line into an item when its amount is what the items add up to", () => {
    const parsed = parseReceiptText(text("C10 SBIUTAL        $18.47", "TOTAL includes G3     $1.68"), { today: TODAY });
    expect(parsed.lines).toHaveLength(6);
    expect(parsed.subtotal).toBe(18.47);
    expect(parsed.warnings).not.toContain("total_mismatch");
  });

  it("reads a second such amount, within cash rounding, as the total", () => {
    const parsed = parseReceiptText(text("C10 SBIUTAL        $18.47", "IOTAL               $18.45", "Cash $20.00", "Change $1.55"), { today: TODAY });
    expect(parsed.lines).toHaveLength(6);
    expect(parsed.subtotal).toBe(18.47);
    expect(parsed.total).toBe(18.45);
    expect(parsed.warnings).toEqual(["no_date"]);
  });

  it("prefers a total whose label was read over one found by arithmetic", () => {
    const parsed = parseReceiptText(text("C10 SBIUTAL        $18.47", "IOTAL               $18.45", "TOTAL $18.45"), { today: TODAY });
    expect(parsed.total).toBe(18.45);
  });

  it("reads 'TOTAL includes GST' with a mangled last word as tax, not an item", () => {
    for (const label of ["TOTAL includes G3", "TOTAL 1ncludes GS1", "Total lncludes GST", "TOTAL includes GST"]) {
      const parsed = parseReceiptText(text(`SUBTOTAL $18.47`, `TOTAL $18.47`, `${label}   $1.68`), { today: TODAY });
      expect(parsed.lines, label).toHaveLength(6);
      expect(parsed.warnings, label).toEqual(["no_date"]);
    }
  });

  it("leaves an item alone when fewer than four items came before it, or items follow it", () => {
    const few = parseReceiptText("WOOLWORTHS\nMILK 2L 3.10\nBREAD 3.00\nEGGS 6.20\nXQZ 12.30", { today: TODAY });
    expect(few.lines).toHaveLength(4);
    const followed = parseReceiptText("WOOLWORTHS\nGRAPES 1.00\nPEARS 1.00\nPLUMS 1.00\nCHERRIES 1.00\nFRUIT BOX 4.00\nKIWI 2.00\nTOTAL 10.00", { today: TODAY });
    expect(followed.lines.map((l) => l.description)).toEqual(["GRAPES", "PEARS", "PLUMS", "CHERRIES", "FRUIT BOX", "KIWI"]);
  });

  it("is not fooled by an amount unlike the sum", () => {
    const parsed = parseReceiptText(text("MYSTERY CHARGE $9.99"), { today: TODAY });
    expect(parsed.lines).toHaveLength(7);
  });
});
