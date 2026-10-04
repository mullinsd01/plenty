import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACCEPT_MATCH_SCORE, matchProduct, normalizeReceiptLine } from "@/lib/normalize";
import { parseReceiptText } from "@/lib/receipts/parse";

const FIXTURES = path.resolve(__dirname, "../fixtures/receipts");

/** What a receipt line resolves to: the product's slug when trusted, "plausible:<slug>" when it's only a suggestion, null otherwise. */
function resolve(raw: string): string | null {
  const line = normalizeReceiptLine(raw);
  if (!line.isFood) return "non-food";
  if (!line.match) return null;
  return line.match.score >= ACCEPT_MATCH_SCORE ? line.match.product.slug : `plausible:${line.match.product.slug}`;
}

describe("receipt lines from a Woolworths photo, as printed", () => {
  it.each([
    ["Potato Sweet Gold", "sweet-potato"],
    ["Mandarin Amorette Seedless Loose", "mandarin"],
    ["Woolworths Art Bag", "non-food"],
    ["Kiwifruit Gold Imp P/P 500g", "kiwifruit"],
    ["Bertocchi Australian Db Smkd Ham off Bone", "sliced-ham"],
    ["Arnotts Salada Original 250g", "crackers"],
    ["Inghams Turkey Brst Half Oven Roast Kg", "turkey-breast"],
    ["Don Shredded Ham KG", "sliced-ham"],
    ["Dorsogna Streaky Bacon kg", "streaky-bacon"],
    ["S/Pots Macadamia Rst/Salt 120g", "macadamias"],
  ])("%s → %s", (raw, expected) => {
    expect(resolve(raw)).toBe(expected);
  });
});

describe("the same lines as OCR read them", () => {
  it.each([
    ["Potato Sweet Goid", "sweet-potato"],
    ["Mandarin Amorette Sascless Loos", "mandarin"],
    ["Mandarin Amoretts Saecless Loos", "mandarin"],
    ["Woolwerths Art Bag", "non-food"],
    ["Woolvorths Art Bag", "non-food"],
    ["HWoolvorths Art Bag", "non-food"],
    ["Bertoconi Australiandy Swed Ham off Bone", "sliced-ham"],
    ["fHArnotts Salada Original 230g", "crackers"],
    ["5/Pots Macadamia Rst/talt 1209", "macadamias"],
    ["#5/Pots Macadamia Rst/Salt 120g", "macadamias"],
  ])("%s → %s", (raw, expected) => {
    expect(resolve(raw)).toBe(expected);
  });

  it("is not sure about a name too damaged to trust, rather than confidently wrong", () => {
    for (const raw of [
      "Kawitrait Gold Tap 27 5))g",
      "Kiwitrait Gold Imp P/F 5))g",
      "Don Shredded Han KG",
      "Inghams Turkey Brst Half van Ruast Kg",
      "Dorsogna Streaky Basor kg",
    ]) {
      const got = resolve(raw);
      expect(
        got === null || got.startsWith("plausible:") || ["kiwifruit", "sliced-ham", "turkey-breast", "streaky-bacon"].includes(got),
        raw,
      ).toBe(true);
      expect(String(got), raw).not.toMatch(/potato|grated-cheese|chicken/);
    }
  });
});

describe("heads and modifiers", () => {
  it("reads 'shredded' as a modifier: shredded ham is ham, shredded cheese is still cheese", () => {
    for (const raw of ["Don Shredded Ham KG", "Shredded Ham 200g", "WW Shredded Ham", "ham shredded"])
      expect(resolve(raw), raw).toBe("sliced-ham");
    expect(resolve("Shredded Tasty Cheese 500g")).toBe("grated-cheese");
    expect(resolve("Grated Parmesan 100g")).toBe("parmesan");
    expect(resolve("Shredded Mozzarella 250g")).toBe("mozzarella");
  });

  it("never reads shredded anything-with-an-unknown-word as grated cheese", () => {
    for (const raw of ["Don Shredded Han KG", "Shredded Zorg 200g", "Grated Zorg"])
      expect(String(resolve(raw)), raw).not.toMatch(/grated-cheese/);
  });

  it("only reads 'pots' as potatoes when nothing else says what the line is", () => {
    expect(resolve("POTS WASHED 2KG")).toBe("potato");
    expect(resolve("WW Pots Brushed 2kg")).toBe("potato");
    expect(resolve("Pots 2kg")).toBe("potato");
    for (const raw of ["#S/Pots Macadamia Rst/Salt 120g", "S/Pots Cashew Nuts 120g", "Snack Pots Almonds 150g", "S/Pots Zorg Mix 120g"]) {
      expect(normalizeReceiptLine(raw).name.toLowerCase(), raw).not.toContain("potato");
      expect(String(resolve(raw)), raw).not.toMatch(/potato/);
    }
    expect(resolve("S/Pots Cashew Nuts 120g")).toBe("cashews");
    expect(resolve("S/Pots Truffle Chips 120g")).toBe("potato-chips");
  });

  it("reads a descriptor cut off at the end of the line as the descriptor, not a rare word", () => {
    expect(resolve("Mandarin Loos")).toBe("mandarin");
    expect(resolve("Bananas Fres")).toBe("banana");
  });

  it("treats a known food that only some cuts of are stocked as that cut only", () => {
    expect(resolve("turkey breast")).toBe("turkey-breast");
    expect(resolve("Turkey Breast Fillets 500g")).toBe("turkey-breast");
    for (const raw of ["turkey mince", "turkey drumsticks", "turkey thigh", "turkey stuffing", "whole turkey"]) {
      const got = resolve(raw);
      expect(got === null || got.startsWith("plausible:"), `${raw} → ${got}`).toBe(true);
      expect(String(got), raw).not.toMatch(/chicken|beef|pork|lamb/);
    }
  });
});

describe("carrier bags are not food", () => {
  it.each([
    "Woolworths Art Bag",
    "#Woolworths Art Bag",
    "Woolwerths Art Bag",
    "HWoolvorths Art Bag",
    "Coles Reusable Bag",
    "Eco Tote Bag",
    "CARRY BAG",
    "Jute Bag",
  ])("%s", (raw) => {
    const line = normalizeReceiptLine(raw);
    expect(line.isFood).toBe(false);
    expect(line.match).toBeNull();
  });

  it("still matches bags that are products", () => {
    expect(resolve("Bin Bags 30pk")).toBe("non-food");
    expect(matchProduct("Bin Bags 30pk")?.product.slug).toBe("bin-bags");
    expect(resolve("Tea Bags 100pk")).not.toBe("non-food");
  });
});

describe("new catalog entries", () => {
  it.each([
    ["Macadamias 250g", "macadamias"],
    ["Roasted Salted Macadamias", "macadamias"],
    ["Macadamia Nuts", "macadamias"],
    ["Salada Crackers", "crackers"],
    ["Arnotts Salada", "crackers"],
    ["Shredded Ham", "sliced-ham"],
    ["Ham off the bone", "sliced-ham"],
    ["Oven Roast Turkey", "turkey-breast"],
    ["Deli Turkey Slices", "turkey-breast"],
  ])("%s → %s", (raw, expected) => {
    expect(resolve(raw)).toBe(expected);
  });

  it("does not let the new words capture unrelated lines", () => {
    expect(resolve("Salad Mix 120g")).not.toBe("crackers");
    expect(resolve("Mixed Salad Leaves 120g")).toMatch(/salad/);
    expect(resolve("Hazelnut Spread 400g")).toBe("hazelnut-spread");
    expect(resolve("Almonds 400g")).toBe("almonds");
  });
});

describe("the phone photo's OCR text (fixture), end to end", () => {
  const manifest = JSON.parse(readFileSync(path.join(FIXTURES, "manifest.json"), "utf8")) as Record<
    string,
    { text: string; expected: { items: Array<{ description: string; product: string | null; isFood?: boolean }> } }
  >;
  const entry = manifest["woolworths-phone-photo"];
  const lines = parseReceiptText(readFileSync(path.join(FIXTURES, entry.text), "utf8"), { today: "2026-10-04" }).lines;

  it("never confidently matches a line to a product that isn't the one on the receipt", () => {
    const allowed = new Set(entry.expected.items.map((i) => i.product).filter((p): p is string => Boolean(p)));
    for (const line of lines) {
      const n = normalizeReceiptLine(line.description);
      if (n.isFood && n.match && n.match.score >= ACCEPT_MATCH_SCORE)
        expect(allowed.has(n.match.product.slug), `${line.description} → ${n.match.product.slug}`).toBe(true);
      expect(n.match?.product.slug ?? "", line.description).not.toMatch(/^potato$|grated-cheese|baby-potatoes/);
    }
  });

  it("resolves at least eight of the ten lines to the right product (or to non-food), the rest to 'not sure'", () => {
    const right = entry.expected.items.filter((item, i) => {
      const n = normalizeReceiptLine(lines[i].description);
      return item.isFood === false ? !n.isFood : n.match?.product.slug === item.product && n.match.score >= 0.55;
    });
    expect(right.length).toBeGreaterThanOrEqual(8);
    entry.expected.items.forEach((item, i) => {
      const n = normalizeReceiptLine(lines[i].description);
      if (item.isFood !== false && !(n.match?.product.slug === item.product && n.match.score >= 0.55)) {
        expect(n.match === null || n.match.score < ACCEPT_MATCH_SCORE, `${lines[i].description} should be 'not sure'`).toBe(true);
      }
    });
  });

  it("treats the carrier bag as not food", () => {
    const bag = lines.find((l) => /bag/i.test(l.description));
    expect(bag).toBeDefined();
    expect(normalizeReceiptLine(bag?.description ?? "").isFood).toBe(false);
  });
});
