/**
 * Cross-module consistency: the catalog, the receipt normaliser, the recipe
 * library and the requirement maths must agree with each other.
 *
 * - Recipes (the library's, and AI-written ones that arrive as free text)
 *   must resolve to the products Plenty stocks, with the same diet and
 *   allergen facts, and never mistake an unstocked food for a stocked one.
 * - What the receipt normaliser puts in the kitchen must be in units the
 *   requirement maths can net recipe quantities against.
 * - The receipt fixtures must parse and normalise to the right products.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, getCatalogProduct, productInfoFromCatalog, type ProductInfo } from "@/lib/catalog";
import { convertForProduct } from "@/lib/meals";
import { ACCEPT_MATCH_SCORE, matchProduct, normalizeReceiptLine } from "@/lib/normalize";
import { parseReceiptText } from "@/lib/receipts/parse";
import { RECIPES, recipeAllergens, recipeContains, type Recipe } from "@/lib/recipes";
import { toBaseUnit, productBaseUnit, type Unit } from "@/lib/units";

const PRODUCTS: ReadonlyMap<string, ProductInfo> = new Map(CATALOG.map((p) => [p.slug, productInfoFromCatalog(p)]));

function product(slug: string): ProductInfo {
  const found = PRODUCTS.get(slug);
  if (!found) throw new Error(`No catalog product ${slug}`);
  return found;
}

/** The product free text confidently resolves to, or null. */
function resolve(text: string): string | null {
  const match = matchProduct(text);
  return match && match.score >= ACCEPT_MATCH_SCORE ? match.product.slug : null;
}

/** Library ingredients that name a catalog product. */
const LINKED_INGREDIENTS = RECIPES.flatMap((recipe) =>
  recipe.ingredients.flatMap((ingredient) => (ingredient.product ? [{ recipe: recipe.slug, name: ingredient.name, product: ingredient.product }] : [])),
);

/** The recipe as an AI would hand it over: names only, resolved the way Plenty resolves free text. */
function asFreeText(recipe: Recipe): Recipe {
  return { ...recipe, ingredients: recipe.ingredients.map((ingredient) => ({ ...ingredient, product: resolve(ingredient.name) })) };
}

// ─── Recipes ↔ catalog ──────────────────────────────────────────────────────

describe("recipe ingredient names resolve to the catalog", () => {
  it("finds the intended product for at least 95% of library ingredients, and a substitute for the rest", () => {
    const misses = LINKED_INGREDIENTS.filter((i) => resolve(i.name) !== i.product);
    const rate = 1 - misses.length / LINKED_INGREDIENTS.length;
    expect(LINKED_INGREDIENTS.length).toBeGreaterThan(500);
    expect(rate, misses.map((m) => `${m.recipe}: "${m.name}" → ${resolve(m.name)} (want ${m.product})`).join("\n")).toBeGreaterThanOrEqual(0.95);
    // A miss may pick a sibling ("short-grain or jasmine rice" → white rice) but never an unrelated product.
    for (const miss of misses) {
      const got = resolve(miss.name);
      const group = getCatalogProduct(miss.product)?.group;
      expect(got && group ? getCatalogProduct(got)?.group : null, `${miss.recipe}: ${miss.name} → ${got}`).toBe(group);
    }
  });

  it("gives every recipe written as free text the same diet and allergen facts as the library", () => {
    for (const recipe of RECIPES) {
      const free = asFreeText(recipe);
      expect(recipeContains(free).sort(), recipe.slug).toEqual(recipeContains(recipe).sort());
      expect(recipeAllergens(free).sort(), recipe.slug).toEqual(recipeAllergens(recipe).sort());
    }
  });

  it("understands everyday Australian, UK and US ingredient wording", () => {
    const cases: Array<[string, string]> = [
      ["baby spinach", "baby-spinach"],
      ["fresh baby spinach leaves", "baby-spinach"],
      ["brown onion", "brown-onion"],
      ["yellow onion", "brown-onion"],
      ["red onion", "red-onion"],
      ["spring onions", "spring-onion"],
      ["scallions", "spring-onion"],
      ["green onions", "spring-onion"],
      ["garlic cloves", "garlic"],
      ["fresh ginger", "ginger"],
      ["red capsicum", "red-capsicum"],
      ["red bell pepper", "red-capsicum"],
      ["green bell pepper", "green-capsicum"],
      ["courgettes", "zucchini"],
      ["aubergine", "eggplant"],
      ["fresh coriander", "coriander"],
      ["cilantro", "coriander"],
      ["coriander leaves", "coriander"],
      ["flat-leaf parsley", "parsley"],
      ["arugula", "rocket"],
      ["cherry tomatoes", "cherry-tomatoes"],
      ["ripe tomatoes", "tomato"],
      ["celery stalks", "celery"],
      ["broccoli florets", "broccoli"],
      ["button mushrooms", "mushrooms"],
      ["lemon juice", "lemon"],
      ["lime juice", "lime"],
      ["lemon zest", "lemon"],
      ["butternut squash", "butternut-pumpkin"],
      ["pak choi", "bok-choy"],
      ["whole milk", "full-cream-milk"],
      ["large eggs", "eggs"],
      ["egg whites", "eggs"],
      ["egg yolks", "eggs"],
      ["unsalted butter", "unsalted-butter"],
      ["heavy cream", "thickened-cream"],
      ["double cream", "thickened-cream"],
      ["greek yogurt", "greek-yoghurt"],
      ["plain yogurt", "natural-yoghurt"],
      ["parmigiano reggiano", "parmesan"],
      ["shredded cheese", "grated-cheese"],
      ["halloumi", "haloumi"],
      ["boneless skinless chicken breasts", "chicken-breast"],
      ["boneless chicken thigh fillets", "chicken-thigh"],
      ["ground beef", "beef-mince"],
      ["lean beef mince", "beef-mince"],
      ["ground pork", "pork-mince"],
      ["bacon rashers", "bacon"],
      ["skinless salmon fillets", "salmon-fillets"],
      ["shrimp", "raw-prawns"],
      ["peeled raw prawns", "raw-prawns"],
      ["tinned tuna", "canned-tuna"],
      ["firm tofu", "tofu"],
      ["garbanzo beans", "chickpeas"],
      ["red lentils", "red-lentils"],
      ["cannellini beans", "cannellini-beans"],
      ["penne pasta", "penne"],
      ["lasagna sheets", "lasagne-sheets"],
      ["jasmine rice", "jasmine-rice"],
      ["long-grain rice", "white-rice"],
      ["all-purpose flour", "plain-flour"],
      ["self-rising flour", "self-raising-flour"],
      ["cornstarch", "cornflour"],
      ["superfine sugar", "caster-sugar"],
      ["powdered sugar", "icing-sugar"],
      ["baking soda", "bicarb-soda"],
      ["bicarbonate of soda", "bicarb-soda"],
      ["extra virgin olive oil", "extra-virgin-olive-oil"],
      ["light soy sauce", "soy-sauce"],
      ["sriracha", "chilli-sauce"],
      ["tomato passata", "passata"],
      ["canned diced tomatoes", "diced-tomatoes"],
      ["chicken broth", "chicken-stock"],
      ["mayo", "mayonnaise"],
      ["freshly ground black pepper", "black-pepper"],
      ["cumin", "ground-cumin"],
      ["red pepper flakes", "chilli-flakes"],
      ["chili powder", "chilli-powder"],
      ["boiling water", "water"],
      ["flour tortillas", "wraps"],
      ["naan bread", "naan"],
      ["panko breadcrumbs", "breadcrumbs"],
      ["frozen puff pastry sheets", "puff-pastry"],
      ["dry white wine", "white-wine"],
      ["kalamata olives", "olives"],
      ["long red chilli", "chilli"],
      ["bird's eye chilli", "chilli"],
      ["raisins", "sultanas"],
      ["ground almonds", "almond-meal"],
    ];
    const misses = cases.filter(([text, slug]) => resolve(text) !== slug).map(([text, slug]) => `${text} → ${resolve(text)} (want ${slug})`);
    expect(misses).toEqual([]);
  });

  it("never confidently mistakes a food Plenty doesn't stock for one it does", () => {
    // Each of these once resolved to the wrong product (scallops → spring onion lost a shellfish
    // allergen; turkey mince → beef mince; brandy → lollies).
    const unstocked = [
      "duck breast",
      "turkey mince",
      "turkey breast",
      "kangaroo fillet",
      "lamb shanks",
      "beef brisket",
      "ham hock",
      "scallops",
      "mussels",
      "calamari",
      "capers",
      "fennel",
      "brandy",
      "marsala",
      "paneer",
      "tempeh",
      "cream of tartar",
      "tapioca flour",
      "nutritional yeast",
      "artichoke hearts",
      "saffron threads",
      "sumac",
      "tamarind purée",
      "kaffir lime leaves",
      "curry leaves",
      "water chestnuts",
    ];
    const confident = unstocked.flatMap((text) => {
      const match = matchProduct(text);
      return match && match.score >= ACCEPT_MATCH_SCORE ? [`${text} → ${match.product.slug} (${match.score})`] : [];
    });
    expect(confident).toEqual([]);
  });

  it("ignores a recipe's preparation note after a comma, but not a list", () => {
    expect(resolve("brown onion, finely diced")).toBe("brown-onion");
    expect(resolve("onions, diced")).toBe("brown-onion");
    expect(resolve("ginger, grated")).toBe("ginger");
    expect(resolve("carrot, peeled and grated")).toBe("carrot");
    expect(resolve("chicken thighs, cut into 3cm pieces")).toBe("chicken-thigh");
    expect(resolve("coriander, leaves picked, to serve")).toBe("coriander");
    expect(resolve("salt, to taste")).toBe("salt");
    // Not a preparation note: the comma separates two products, so it's matched as written.
    expect(matchProduct("salt, pepper")).toEqual(matchProduct("salt pepper"));
  });
});

// ─── Receipts ↔ requirements: units ─────────────────────────────────────────

describe("normalised receipt amounts and recipe quantities share units", () => {
  it("converts every library recipe quantity into its product's tracking unit", () => {
    const unconvertible = RECIPES.flatMap((recipe) =>
      recipe.ingredients.flatMap((i) => {
        if (!i.product || i.quantity === undefined || !i.unit) return [];
        const p = product(i.product);
        return convertForProduct(i.quantity, i.unit, p.unit, p) === null ? [`${recipe.slug}: ${i.quantity} ${i.unit} ${i.name} → ${p.unit}`] : [];
      }),
    );
    expect(unconvertible).toEqual([]);
  });

  it("normalises a catalog package printed on a receipt back to the product, in its tracking unit", () => {
    const sizeFor = (p: ProductInfo): string => {
      const printed: Partial<Record<Unit, string>> = { l: "L", ml: "ML", g: "G", kg: "KG" };
      if (printed[p.unit]) return `${p.packageQuantity}${printed[p.unit]}`;
      return p.unit === "each" && p.packageQuantity > 1 ? `${p.packageQuantity}PK` : "";
    };
    const failures = CATALOG.filter((p) => !p.pantryBasic).flatMap((catalogProduct) => {
      const p = product(catalogProduct.slug);
      const line = `${p.name.toUpperCase()} ${sizeFor(p)}`.trim();
      const n = normalizeReceiptLine(line);
      const ok = n.match?.product.slug === p.slug && n.unit === p.unit && Math.abs(n.quantity - p.packageQuantity) < 1e-9;
      return ok ? [] : [`${line} → ${n.match?.product.slug ?? "nothing"} ${n.quantity} ${n.unit}`];
    });
    expect(failures).toEqual([]);
  });

  it("puts everything a receipt line adds in units the requirement maths can net off", () => {
    const lines = [
      "W/M FULL CREAM 2L",
      "MUTTI PASSATA 700G",
      "WW BABY SPINACH 120G",
      "BROWN ONIONS 2KG",
      "HASS AVOCADO EACH",
      "CARROTS EACH",
      "CORIANDER BUNCH",
      "SAN REMO SPAGHETTI 500G",
      "TESCO SEMI SKIMMED MILK 4PT",
      "HEINZ BAKED BEANS 415G",
      "WW FREE RANGE EGGS 12PK",
    ];
    for (const raw of lines) {
      const n = normalizeReceiptLine(raw);
      const p = product(n.match?.product.slug ?? "");
      expect(n.unit, raw).toBe(p.unit);
      expect(toBaseUnit(n.quantity, n.unit, productBaseUnit(p, p.unit), p), raw).not.toBeNull();
    }
    // Sold by the piece: one of it, not the usual pack.
    expect(normalizeReceiptLine("HASS AVOCADO EACH")).toMatchObject({ quantity: 1, unit: "each" });
    expect(normalizeReceiptLine("CARROTS EACH")).toMatchObject({ quantity: 100, unit: "g" });
    // 2 kg of 150 g onions, 4 UK pints of milk.
    expect(normalizeReceiptLine("BROWN ONIONS 2KG")).toMatchObject({ quantity: 13, unit: "each" });
    expect(normalizeReceiptLine("TESCO SEMI SKIMMED MILK 4PT").quantity).toBeCloseTo(2.273, 3);
  });
});

// ─── Receipt fixtures ───────────────────────────────────────────────────────

interface ManifestEntry {
  text: string | null;
  kind: string;
  expected: {
    store: string;
    purchasedOn: string;
    total: number;
    items: Array<{ description: string; price: number }>;
  } | null;
}

const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/receipts");
const MANIFEST = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf8")) as Record<string, ManifestEntry>;

/** What each fixture line should normalise to; null for bags. */
const EXPECTED_PRODUCTS: Record<string, Array<string | null>> = {
  "woolworths-weekly": [
    "full-cream-milk",
    "banana",
    "white-bread",
    "eggs",
    "chicken-breast",
    "baby-spinach",
    "spaghetti",
    "passata",
    "red-capsicum",
    "zucchini",
    "beef-mince",
    "coriander",
    "spring-onion",
    "natural-yoghurt",
    "tasty-cheese",
    null,
  ],
  "coles-topup": ["full-cream-milk", "white-bread", "avocado", "chicken-thigh", "lebanese-cucumber", "greek-yoghurt", "rocket", "chocolate-biscuits"],
  "aldi-shop": [
    "full-cream-milk",
    "wholemeal-bread",
    "eggs",
    "penne",
    "broccoli",
    "carrot",
    "brown-onion",
    "beef-mince",
    "cooked-prawns",
    "tasty-cheese",
    "zucchini",
    "natural-yoghurt",
  ],
  "tesco-uk": ["lite-milk", "wholemeal-bread", "banana", "eggs", "chicken-breast", "baked-beans", "cheddar-cheese", null],
};

const RECEIPT_FIXTURES = Object.entries(MANIFEST).filter(
  (entry): entry is [string, ManifestEntry & { text: string; expected: NonNullable<ManifestEntry["expected"]> }] =>
    entry[1].kind === "receipt" && entry[1].text !== null && entry[1].expected !== null,
);

function readFixture(file: string): string {
  return readFileSync(path.join(FIXTURE_DIR, file), "utf8");
}

describe("receipt fixtures parse and normalise to the right products", () => {
  it("covers every receipt fixture in the manifest", () => {
    expect(RECEIPT_FIXTURES.map(([name]) => name).sort()).toEqual(Object.keys(EXPECTED_PRODUCTS).sort());
  });

  it.each(RECEIPT_FIXTURES)("%s", (name, entry) => {
    const parsed = parseReceiptText(readFixture(entry.text), { today: "2026-09-30" });
    expect(parsed).toMatchObject({ store: entry.expected.store, purchasedOn: entry.expected.purchasedOn, total: entry.expected.total });
    expect(parsed.lines.map((l) => [l.description, l.price])).toEqual(entry.expected.items.map((i) => [i.description, i.price]));

    const expected = EXPECTED_PRODUCTS[name];
    const got = parsed.lines.map((line) => {
      const n = normalizeReceiptLine(line.description);
      if (!n.isFood) return null;
      return n.match && n.match.score >= ACCEPT_MATCH_SCORE ? n.match.product.slug : `unmatched: ${n.name}`;
    });
    expect(got).toEqual(expected);
  });

  it("normalises every fixture line correctly (the match rate is 100%)", () => {
    let lines = 0;
    let correct = 0;
    for (const [name, entry] of RECEIPT_FIXTURES) {
      const parsed = parseReceiptText(readFixture(entry.text), { today: "2026-09-30" });
      parsed.lines.forEach((line, i) => {
        lines += 1;
        const n = normalizeReceiptLine(line.description);
        const slug = n.isFood && n.match && n.match.score >= ACCEPT_MATCH_SCORE ? n.match.product.slug : null;
        if (slug === EXPECTED_PRODUCTS[name][i] && n.isFood === (slug !== null)) correct += 1;
      });
    }
    expect(lines).toBe(44);
    expect(correct / lines).toBe(1);
  });
});
