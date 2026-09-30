import { beforeAll, describe, expect, it } from "vitest";
import type { CatalogProduct } from "@/lib/catalog";
import {
  ACCEPT_MATCH_SCORE,
  aliasKey,
  cleanReceiptText,
  isNonItemLine,
  matchProduct,
  matchProductCandidates,
  normalizeReceiptLine,
  normalizeText,
  productKeyForText,
  sentenceCase,
  singularize,
  singularizePhrase,
} from "@/lib/normalize";
import type { Unit } from "@/lib/units";

// ─── Text ───────────────────────────────────────────────────────────────────

describe("normalizeText", () => {
  it("lower-cases, strips punctuation and collapses whitespace", () => {
    expect(normalizeText("  FREE-RANGE   Eggs!! ")).toBe("free range eggs");
    expect(normalizeText("Sainsbury's Semi-Skimmed")).toBe("sainsburys semi skimmed");
    expect(normalizeText("Crème Fraîche")).toBe("creme fraiche");
    expect(normalizeText("Salt & Vinegar")).toBe("salt and vinegar");
  });

  it("keeps the punctuation that carries meaning", () => {
    expect(normalizeText("MILK 1.5L")).toBe("milk 1.5l");
    expect(normalizeText("GV 2% MILK 1/2 GAL")).toBe("gv 2% milk 1/2 gal");
    // Receipt slash-abbreviations join; ordinary slashes separate.
    expect(normalizeText("W/M FULL CREAM")).toBe("wm full cream");
    expect(normalizeText("S/R FLOUR")).toBe("sr flour");
    expect(normalizeText("SALT/PEPPER")).toBe("salt pepper");
  });
});

describe("singularize", () => {
  it.each([
    ["tomatoes", "tomato"],
    ["potatoes", "potato"],
    ["berries", "berry"],
    ["strawberries", "strawberry"],
    ["leaves", "leaf"],
    ["loaves", "loaf"],
    ["olives", "olive"],
    ["peaches", "peach"],
    ["radishes", "radish"],
    ["boxes", "box"],
    ["glasses", "glass"],
    ["cheeses", "cheese"],
    ["sausages", "sausage"],
    ["nappies", "nappy"],
    ["chillies", "chilli"],
    ["cookies", "cookie"],
    ["quiches", "quiche"],
    ["kiwis", "kiwi"],
    ["chips", "chip"],
    ["eggs", "egg"],
  ])("%s → %s", (plural, singular) => {
    expect(singularize(plural)).toBe(singular);
  });

  it("leaves singular words ending in s alone", () => {
    for (const word of ["hummus", "asparagus", "couscous", "swiss", "citrus", "molasses", "cos", "gas", "12s"]) {
      expect(singularize(word)).toBe(word);
    }
  });

  it("singularises every word of a phrase", () => {
    expect(singularizePhrase("Cherry Tomatoes")).toBe("cherry tomato");
    expect(singularizePhrase("kale chips")).toBe("kale chip");
    expect(singularizePhrase("brussels sprouts")).toBe("brussel sprout");
  });
});

describe("sentenceCase", () => {
  it("capitalises only the first letter and keeps known acronyms", () => {
    expect(sentenceCase("KALE CHIPS")).toBe("Kale chips");
    expect(sentenceCase("  kale   chips ")).toBe("Kale chips");
    expect(sentenceCase("smoky bbq sauce")).toBe("Smoky BBQ sauce");
    expect(sentenceCase("")).toBe("");
  });
});

describe("aliasKey", () => {
  it("is a stable, size-preserving key for exact receipt text", () => {
    expect(aliasKey("W/M FULL CREAM 2L")).toBe("wm full cream 2l");
    expect(aliasKey("w/m   full cream 2L")).toBe(aliasKey("W/M FULL CREAM 2L"));
    expect(aliasKey("W/M FULL CREAM 3L")).not.toBe(aliasKey("W/M FULL CREAM 2L"));
    expect(aliasKey("MILK 1.5L")).not.toBe(aliasKey("MILK 15L"));
    expect(aliasKey("GV 2% MILK")).toMatch(/^[a-z0-9. ]+$/);
  });
});

describe("cleanReceiptText", () => {
  function size(raw: string): { quantity: number; unit: Unit } | null {
    return cleanReceiptText(raw).size;
  }

  it("strips store brands and expands abbreviations", () => {
    const cleaned = cleanReceiptText("W/M FULL CREAM 2L");
    expect(cleaned).toEqual({
      cleaned: "full cream",
      tokens: ["full", "cream"],
      size: { quantity: 2, unit: "l" },
      packCount: null,
      sizeIsTotal: false,
      perKg: false,
      removedBrandTokens: ["wm"],
    });
    expect(cleanReceiptText("CHKN BRST FLLT SKNLS 1KG").cleaned).toBe("chicken breast fillet skinless");
    expect(cleanReceiptText("COLES SIMPLY TOILET TISS 24PK").cleaned).toBe("toilet paper");
    expect(cleanReceiptText("WW SELECT GRK YGHT 1KG").cleaned).toBe("greek yoghurt");
    expect(cleanReceiptText("TESCO FINEST SOURDOUGH").removedBrandTokens).toEqual(["tesco", "finest"]);
    expect(cleanReceiptText("KS ORGANIC EGGS 24CT").cleaned).toBe("organic eggs");
  });

  it("only treats range words as brands at the start of a line", () => {
    expect(cleanReceiptText("GOLD KIWIFRUIT").cleaned).toBe("kiwifruit");
    expect(cleanReceiptText("SWEET POTATO GOLD").cleaned).toBe("sweet potato gold");
  });

  it("never strips a line down to nothing", () => {
    expect(cleanReceiptText("COLES").cleaned).toBe("coles");
  });

  it("reads sizes written every way receipts write them", () => {
    expect(size("MILK 2L")).toEqual({ quantity: 2, unit: "l" });
    expect(size("MILK 2 L")).toEqual({ quantity: 2, unit: "l" });
    expect(size("MILK 1.5LT")).toEqual({ quantity: 1.5, unit: "l" });
    expect(size("RICE 500G")).toEqual({ quantity: 500, unit: "g" });
    expect(size("RICE 500GM")).toEqual({ quantity: 500, unit: "g" });
    expect(size("RICE 1KG")).toEqual({ quantity: 1, unit: "kg" });
    expect(size("COKE 375ML")).toEqual({ quantity: 375, unit: "ml" });
    expect(size("TESCO WHOLE MILK 4 PINTS")).toEqual({ quantity: 2273, unit: "ml" });
    expect(size("BABY SPINACH 5 OZ")).toEqual({ quantity: 142, unit: "g" });
    expect(size("GV WHOLE MILK GAL")).toEqual({ quantity: 3.785, unit: "l" });
    expect(size("GV 2% MILK 1/2 GAL")).toEqual({ quantity: 1.893, unit: "l" });
    expect(size("2 LEMONS")).toBeNull();
  });

  it("reads pack counts", () => {
    const pack = (raw: string) => cleanReceiptText(raw).packCount;
    expect(pack("SOFT DRINK 6PK")).toBe(6);
    expect(pack("SOFT DRINK 6 PACK")).toBe(6);
    expect(pack("SOFT DRINK X6")).toBe(6);
    expect(pack("FREE RANGE EGGS 12S")).toBe(12);
    expect(pack("EGGS DOZEN")).toBe(12);
    expect(pack("HALF DOZEN EGGS")).toBe(6);
    expect(pack("TOILET PAPER 24 ROLL")).toBe(24);
    expect(pack("GV LARGE EGGS 12CT")).toBe(12);
    const multipack = cleanReceiptText("COKE 6X375ML");
    expect(multipack.packCount).toBe(6);
    expect(multipack.size).toEqual({ quantity: 375, unit: "ml" });
    expect(cleanReceiptText("COKE 375ML X 24").packCount).toBe(24);
  });

  it("recognises goods sold by weight and drops each markers", () => {
    expect(cleanReceiptText("BANANAS KG")).toMatchObject({ cleaned: "bananas", perKg: true, size: null });
    expect(cleanReceiptText("BANANAS 0.845KG @ $3.90/KG")).toMatchObject({ cleaned: "bananas", perKg: true, size: { quantity: 0.845, unit: "kg" } });
    expect(cleanReceiptText("AVOCADO HASS EA")).toMatchObject({ cleaned: "avocado hass", perKg: false });
  });

  it("drops product codes, prices and stray numbers", () => {
    expect(cleanReceiptText("HB SPAG 500G 9300633123456").cleaned).toBe("spaghetti");
    expect(cleanReceiptText("GV WHOLE MILK 007874235187 F 3.48").cleaned).toBe("whole milk");
    expect(cleanReceiptText("MAGGI 2 MINUTE NOODLES 5PK").cleaned).toBe("maggi instant noodles");
    expect(cleanReceiptText("4 BEAN MIX 420G").cleaned).toBe("four bean mix");
  });
});

// ─── Matching ───────────────────────────────────────────────────────────────

interface LineCase {
  raw: string;
  slug: string;
  quantity?: number;
  unit?: Unit;
  isFood?: boolean;
}

/** Realistic receipt lines from Australian, UK and US supermarkets. */
const RECEIPT_LINES: LineCase[] = [
  // Woolworths / Coles / Aldi
  { raw: "W/M FULL CREAM 2L", slug: "full-cream-milk", quantity: 2, unit: "l" },
  { raw: "WW FC MILK 3L", slug: "full-cream-milk", quantity: 3, unit: "l" },
  { raw: "PAULS FULL CREAM MILK 2L", slug: "full-cream-milk", quantity: 2, unit: "l" },
  { raw: "DAIRY FARMERS FULL CREAM 3L", slug: "full-cream-milk", quantity: 3, unit: "l" },
  { raw: "FARMDALE LITE MILK 2L", slug: "lite-milk", quantity: 2, unit: "l" },
  { raw: "A2 LIGHT MILK 2L", slug: "lite-milk", quantity: 2, unit: "l" },
  { raw: "ZYMIL FULL CREAM 2L", slug: "lactose-free-milk", quantity: 2, unit: "l" },
  { raw: "DEVONDALE LONG LIFE FULL CREAM 1L", slug: "uht-milk", quantity: 1, unit: "l" },
  { raw: "BANANAS KG", slug: "banana", quantity: 6, unit: "each" },
  { raw: "BANANAS 0.845KG @ $3.90/KG", slug: "banana", quantity: 7, unit: "each" },
  { raw: "CHKN BRST FLLT SKNLS 1KG", slug: "chicken-breast", quantity: 1000, unit: "g" },
  { raw: "CHKN THGH FLLT 500G", slug: "chicken-thigh", quantity: 500, unit: "g" },
  { raw: "COLES AUST BEEF MINCE 3 STAR 500G", slug: "beef-mince", quantity: 500, unit: "g" },
  { raw: "HB SPAG 500G", slug: "spaghetti", quantity: 500, unit: "g" },
  { raw: "REMANO PENNE 500G", slug: "penne", quantity: 500, unit: "g" },
  { raw: "BAKERS LIFE WHOLEMEAL BREAD 700G", slug: "wholemeal-bread", quantity: 1, unit: "loaf" },
  { raw: "TIP TOP WHITE SANDWICH 700G", slug: "white-bread", quantity: 1, unit: "loaf" },
  { raw: "COLES SIMPLY TOILET TISS 24PK", slug: "toilet-paper", quantity: 24, unit: "each", isFood: false },
  { raw: "WW SELECT GRK YGHT 1KG", slug: "greek-yoghurt", quantity: 1000, unit: "g" },
  { raw: "COLES FREE RNG EGGS 12PK", slug: "eggs", quantity: 12, unit: "each" },
  { raw: "TOMS DICED 400G", slug: "diced-tomatoes", quantity: 1, unit: "can" },
  // Priced per piece: one avocado (a "3 @ $1.90 EACH" line multiplies it), not the usual 2-pack.
  { raw: "AVO HASS EA", slug: "avocado", quantity: 1, unit: "each" },
  { raw: "CARROTS EACH", slug: "carrot", quantity: 100, unit: "g" },
  { raw: "CAPS RED", slug: "red-capsicum" },
  { raw: "POTS WASHED 2KG", slug: "potato", quantity: 2000, unit: "g" },
  { raw: "MACRO ORG CARROTS 1KG", slug: "carrot", quantity: 1000, unit: "g" },
  { raw: "CORIANDER BN", slug: "coriander", quantity: 1, unit: "bunch" },
  { raw: "OJ 2L", slug: "orange-juice", quantity: 2, unit: "l" },
  { raw: "DISHW LIQ 500ML", slug: "dishwashing-liquid", quantity: 500, unit: "ml", isFood: false },
  { raw: "LNDRY LIQ 2L", slug: "laundry-detergent", quantity: 2000, unit: "ml", isFood: false },
  { raw: "BIS CHOC 200G", slug: "chocolate-biscuits", quantity: 200, unit: "g" },
  { raw: "ARNOTTS TIM TAM 200G", slug: "chocolate-biscuits" },
  { raw: "SMITHS CHIPS ORIGINAL 170G", slug: "potato-chips", quantity: 170, unit: "g" },
  { raw: "COKE 24X375ML", slug: "cola", quantity: 9, unit: "l" },
  { raw: "BEER 24X375ML", slug: "beer", quantity: 24, unit: "each" },
  { raw: "JOHN WEST TUNA SPRINGWATER 95G", slug: "canned-tuna", quantity: 1, unit: "can" },
  { raw: "TUNA 4X95G", slug: "canned-tuna", quantity: 4, unit: "can" },
  { raw: "MAGGI 2 MINUTE NOODLES CHICKEN 5PK", slug: "instant-noodles", quantity: 5, unit: "each" },
  { raw: "FINISH QUANTUM 46PK", slug: "dishwasher-tablets", quantity: 46, unit: "each", isFood: false },
  { raw: "GLAD WRAP 30M", slug: "cling-wrap", isFood: false },
  { raw: "WHISKAS POUCH 12X85G", slug: "wet-cat-food", quantity: 12, unit: "each", isFood: false },
  { raw: "HUGGIES CRAWLER 54PK", slug: "nappies", quantity: 54, unit: "each", isFood: false },
  // Tesco / Sainsbury's
  { raw: "TESCO SEMI SKIMMED MILK 4 PINTS", slug: "lite-milk", quantity: 2.273, unit: "l" },
  { raw: "TESCO COURGETTES", slug: "zucchini" },
  { raw: "TESCO EASY PEELERS 600G", slug: "mandarin", quantity: 7, unit: "each" },
  { raw: "TESCO KITCHEN ROLL 2 ROLL", slug: "paper-towel", quantity: 2, unit: "each", isFood: false },
  { raw: "TESCO FINEST SOURDOUGH 800G", slug: "sourdough", quantity: 1, unit: "loaf" },
  { raw: "SAINSBURYS ROCKET 60G", slug: "rocket", quantity: 60, unit: "g" },
  // Walmart / Costco
  { raw: "GV WHOLE MILK GAL", slug: "full-cream-milk", quantity: 3.785, unit: "l" },
  { raw: "GV 2% MILK 1/2 GAL", slug: "lite-milk", quantity: 1.893, unit: "l" },
  { raw: "GV LARGE EGGS 12CT", slug: "eggs", quantity: 12, unit: "each" },
  { raw: "MARKETSIDE BABY SPINACH 5 OZ", slug: "baby-spinach", quantity: 142, unit: "g" },
  { raw: "GV SHRED CHEDDAR 8OZ", slug: "grated-cheese", quantity: 227, unit: "g" },
  { raw: "KS ORGANIC EGGS 24CT", slug: "eggs", quantity: 24, unit: "each" },
];

describe("normalizeReceiptLine: real receipt lines", () => {
  beforeAll(() => {
    // Build the lazy indexes once so individual tests measure matching only.
    matchProduct("milk");
  });

  it.each(RECEIPT_LINES)("$raw → $slug", ({ raw, slug, quantity, unit, isFood }) => {
    const line = normalizeReceiptLine(raw);
    expect(line.match?.product.slug).toBe(slug);
    expect(line.confidence).toBeGreaterThanOrEqual(ACCEPT_MATCH_SCORE);
    expect(line.name).toBe(line.match?.product.name);
    if (quantity !== undefined) expect(line.quantity).toBeCloseTo(quantity, 3);
    if (unit !== undefined) expect(line.unit).toBe(unit);
    expect(line.isFood).toBe(isFood ?? true);
    expect(line.rawText).toBe(raw);
    expect(line.aliasKey).toBe(aliasKey(raw));
  });

  it("turns the canonical example into full cream milk", () => {
    expect(normalizeReceiptLine("W/M FULL CREAM 2L")).toMatchObject({
      name: "Full cream milk",
      quantity: 2,
      unit: "l",
      packCount: 1,
      isFood: true,
      aliasKey: "wm full cream 2l",
      match: { product: { slug: "full-cream-milk" } },
    });
  });

  it("reports pack counts and multiplies multipacks out", () => {
    const coke = normalizeReceiptLine("COKE 24X375ML");
    expect(coke.packCount).toBe(24);
    expect(coke.quantity).toBe(9); // 24 × 375 ml, tracked in litres
    const pepsi = normalizeReceiptLine("PEPSI MAX 10X375ML");
    expect(pepsi.match?.product.slug).toBe("diet-cola");
    expect(pepsi.quantity).toBeCloseTo(3.75);
  });

  it("falls back to the product's usual package, then to one each", () => {
    expect(normalizeReceiptLine("TOMATO PASTE")).toMatchObject({ quantity: 140, unit: "g" });
    expect(normalizeReceiptLine("BREAD ROLLS 6PK")).toMatchObject({ quantity: 6, unit: "each" });
    // Not in the catalog: a weak guess may be offered, but it doesn't drive the quantity.
    const dragonFruit = normalizeReceiptLine("DRAGON FRUIT");
    expect(dragonFruit).toMatchObject({ name: "Dragon fruit", quantity: 1, unit: "each" });
    expect(dragonFruit.confidence).toBeLessThan(ACCEPT_MATCH_SCORE);
    expect(normalizeReceiptLine("DRAGON FRUIT 400G")).toMatchObject({ quantity: 400, unit: "g" });
    expect(normalizeReceiptLine("ZXQV WIDGET")).toMatchObject({ match: null, quantity: 1, unit: "each", name: "Zxqv widget" });
  });

  it("maps a receipt's WATER to bottled water, not the tap-water pantry basic", () => {
    expect(normalizeReceiptLine("WATER 600ML")).toMatchObject({ name: "Spring water", quantity: 0.6, unit: "l" });
    expect(matchProduct("water")?.product.slug).toBe("water");
  });
});

describe("matching: grouping spelling variants", () => {
  it("resolves every banana variant to the same product and key", () => {
    const variants = ["Bananas", "BANANA", "BANANAS KG", "bananas", "BANANAS CAVENDISH", "CAVENDISH BANANAS 1KG", "BANANAS 0.845KG @ $3.90/KG"];
    for (const v of variants) expect(matchProduct(v)?.product.slug, v).toBe("banana");
    expect(new Set(variants.map((v) => productKeyForText(v)))).toEqual(new Set(["slug:banana"]));
  });

  it("groups unmatched items by their cleaned, singular name", () => {
    expect(productKeyForText("Kale chips")).toBe("name:kale chip");
    expect(productKeyForText("KALE CHIPS")).toBe("name:kale chip");
    expect(productKeyForText("WW KALE CHIPS 50G")).toBe("name:kale chip");
    const line = normalizeReceiptLine("WW KALE CHIPS 50G");
    expect(line.name).toBe("Kale chips");
    expect(line.confidence).toBeLessThan(ACCEPT_MATCH_SCORE);
    expect(line).toMatchObject({ quantity: 50, unit: "g", isFood: true });
  });

  it("forgives truncated and misspelt words", () => {
    expect(matchProduct("STRAWBERRI 250G")?.product.slug).toBe("strawberries");
    expect(matchProduct("BLUEBERR 125G")?.product.slug).toBe("blueberries");
    expect(matchProduct("MOZZARE SHRED 500G")?.product.slug).toBe("mozzarella");
    expect(matchProduct("ZUCHINI")?.product.slug).toBe("zucchini");
    expect(matchProduct("BROCOLLI")?.product.slug).toBe("broccoli");
    expect(matchProduct("CORNFLKS")?.product.slug).toBe("breakfast-cereal");
    for (const raw of ["STRAWBERRI 250G", "ZUCHINI"]) expect(matchProduct(raw)?.score, raw).toBeGreaterThanOrEqual(ACCEPT_MATCH_SCORE);
  });

  it("understands UK and US names", () => {
    expect(matchProduct("aubergine")?.product.slug).toBe("eggplant");
    expect(matchProduct("cilantro")?.product.slug).toBe("coriander");
    expect(matchProduct("ground beef")?.product.slug).toBe("beef-mince");
    expect(matchProduct("shrimp")?.product.slug).toBe("raw-prawns");
    expect(matchProduct("arugula")?.product.slug).toBe("rocket");
    expect(matchProduct("red bell pepper")?.product.slug).toBe("red-capsicum");
  });
});

describe("matching: head nouns and ambiguity", () => {
  const slugOf = (raw: string) => matchProduct(raw)?.product.slug;

  it("uses the head noun to separate look-alike phrases", () => {
    expect(slugOf("MILK CHOC 200G")).toBe("milk-chocolate");
    expect(slugOf("CHOC MILK 600ML")).toBe("flavoured-milk");
    expect(slugOf("CADBURY DAIRY MILK 180G")).toBe("milk-chocolate");
    expect(slugOf("CHICKEN STOCK 1L")).toBe("chicken-stock");
    expect(slugOf("TOMATO PASTE 140G")).toBe("tomato-paste");
    expect(slugOf("PEANUT BUTTER CRUNCHY 375G")).toBe("peanut-butter");
    expect(slugOf("BUTTER LETTUCE")).toBe("butter-lettuce");
    expect(slugOf("CHICKEN CHIPS 170G")).toBe("potato-chips");
    expect(slugOf("BAKED BEANS TOMATO SCE 420G")).toBe("baked-beans");
    expect(slugOf("BANANA BOAT SPF50 200ML")).toBe("sunscreen");
    expect(slugOf("MILK LACTOSE FREE 2L")).toBe("lactose-free-milk");
    expect(slugOf("WHITE BREAD GLUTEN FREE")).toBe("gluten-free-bread");
    expect(slugOf("MINCE BEEF 500G")).toBe("beef-mince");
  });

  it("does not force compound foods onto a product that only shares one word", () => {
    for (const raw of ["APPLE PIE", "BANANA BREAD", "KALE CHIPS"]) {
      const match = matchProduct(raw);
      expect(match?.score ?? 0, raw).toBeLessThan(ACCEPT_MATCH_SCORE);
      expect(normalizeReceiptLine(raw).name, raw).toBe(sentenceCase(raw));
    }
  });

  it("keeps near-ties between unrelated products below the trusted range", () => {
    for (const raw of ["BEANS", "CHICK", "WINE 750ML"]) {
      expect(matchProduct(raw)?.score ?? 0, raw).toBeLessThan(ACCEPT_MATCH_SCORE);
      expect(productKeyForText(raw), raw).toMatch(/^name:/);
    }
    const chick = matchProductCandidates("CHICK").map((m) => m.product.slug);
    expect(chick.slice(0, 2).sort()).toEqual(["chicken-breast", "chickpeas"]);
  });

  it("still prefers the plain default for one-word staples", () => {
    expect(slugOf("MILK")).toBe("full-cream-milk");
    expect(slugOf("CHEESE")).toBe("tasty-cheese");
    expect(slugOf("CREAM")).toBe("thickened-cream");
    expect(slugOf("BREAD")).toBe("white-bread");
    expect(slugOf("ONION")).toBe("brown-onion");
  });

  it("ranks candidates best first, one per product", () => {
    const candidates = matchProductCandidates("MILK", undefined, 4);
    expect(candidates).toHaveLength(4);
    expect(candidates[0]).toMatchObject({ product: { slug: "full-cream-milk" }, method: "alias" });
    const scores = candidates.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(candidates.map((c) => c.product.slug)).size).toBe(4);
    expect(matchProductCandidates("MILK", undefined, 0)).toEqual([]);
  });

  it("reports how each match was made", () => {
    expect(matchProduct("Baby spinach")).toMatchObject({ method: "exact", score: 0.97 });
    expect(matchProduct("courgettes")).toMatchObject({ method: "alias", score: 0.96 });
    expect(matchProduct("COLES AUST BEEF MINCE 3 STAR 500G")?.method).toBe("fuzzy");
    expect(matchProduct("")).toBeNull();
    expect(matchProduct("123456")).toBeNull();
  });
});

describe("non-product lines", () => {
  it.each(["CARRY BAG", "BAG", "REUSABLE BAG 15C", "BOTTLE DEPOSIT", "CONTAINER DEPOSIT 10C", "GIFT CARD", "WOOLWORTHS GIFT CARD 50.00"])(
    "%s is not food and matches nothing",
    (raw) => {
      expect(isNonItemLine(raw)).toBe(true);
      const line = normalizeReceiptLine(raw);
      expect(line).toMatchObject({ match: null, isFood: false, quantity: 1, unit: "each" });
      expect(line.confidence).toBeGreaterThan(0.8);
      expect(matchProduct(raw)).toBeNull();
    },
  );

  it("still recognises bags that are products", () => {
    expect(isNonItemLine("BIN BAGS 30")).toBe(false);
    expect(normalizeReceiptLine("BIN BAGS 30")).toMatchObject({ isFood: false, match: { product: { slug: "bin-bags" } } });
    expect(normalizeReceiptLine("TEA BAGS 100PK")).toMatchObject({ isFood: true, quantity: 100, match: { product: { slug: "black-tea" } } });
    expect(isNonItemLine("COLGATE TOTAL TOOTHPASTE")).toBe(false);
  });
});

describe("household knowledge", () => {
  const kaleChips: CatalogProduct = {
    slug: "household-kale-chips",
    name: "Kale chips",
    aisle: "snacks",
    location: "pantry",
    unit: "g",
    packageQuantity: 50,
    shelfLifeDays: 90,
    perishable: false,
    aliases: ["kale crisps"],
  };

  it("lets a remembered household mapping override the catalog", () => {
    const householdAliases = new Map([[aliasKey("W/M FULL CREAM 2L"), "lactose-free-milk"]]);
    const line = normalizeReceiptLine("W/M FULL CREAM 2L", { householdAliases });
    expect(line.match).toMatchObject({ product: { slug: "lactose-free-milk" }, score: 0.99, method: "household_alias" });
    expect(line.name).toBe("Lactose free milk");
    // Only that exact text: other milk lines still use the catalog.
    expect(matchProduct("W/M FULL CREAM 3L", { householdAliases })?.product.slug).toBe("full-cream-milk");
  });

  it("ignores household mappings to products that no longer exist", () => {
    const householdAliases = new Map([[aliasKey("OJ 2L"), "deleted-product"]]);
    expect(matchProduct("OJ 2L", { householdAliases })?.product.slug).toBe("orange-juice");
  });

  it("searches the household's own products alongside the catalog", () => {
    const extraProducts = [kaleChips];
    const line = normalizeReceiptLine("WW KALE CHIPS 50G", { extraProducts });
    expect(line.match).toMatchObject({ product: { slug: "household-kale-chips" }, method: "exact" });
    expect(line).toMatchObject({ name: "Kale chips", quantity: 50, unit: "g" });
    expect(productKeyForText("KALE CRISPS", { extraProducts })).toBe("slug:household-kale-chips");
    // Catalog products are still there.
    expect(matchProduct("BANANAS", { extraProducts })?.product.slug).toBe("banana");
  });

  it("can map receipt text to a household product", () => {
    const householdAliases = new Map([[aliasKey("CC KALE CHIPS"), "household-kale-chips"]]);
    const match = matchProduct("CC KALE CHIPS", { householdAliases, extraProducts: [kaleChips] });
    expect(match).toMatchObject({ product: { slug: "household-kale-chips" }, method: "household_alias" });
  });
});

describe("performance", () => {
  it("normalises a 50-line receipt in well under 50 ms once indexes exist", () => {
    matchProduct("warm up");
    const lines = Array.from({ length: 50 }, (_, i) => `${RECEIPT_LINES[i % RECEIPT_LINES.length].raw} ${i}`);
    const started = performance.now();
    const results = lines.map((raw) => normalizeReceiptLine(raw));
    const elapsed = performance.now() - started;
    expect(results.filter((r) => r.match !== null)).toHaveLength(50);
    expect(elapsed).toBeLessThan(50);
  });
});
