import { describe, expect, it } from "vitest";
import {
  CATALOG,
  CATALOG_BY_SLUG,
  catalogGroups,
  catalogProductsInGroup,
  getCatalogProduct,
  productInfoFromCatalog,
  type CatalogProduct,
} from "@/lib/catalog";
import { AISLES, CONTAINS_FLAGS, STORAGE_LOCATIONS } from "@/lib/domain";
import { matchProduct } from "@/lib/normalize";
import { cleanReceiptText, singularizePhrase } from "@/lib/normalize/text";
import { convert, isUnit, unitDimension } from "@/lib/units";

const food = CATALOG.filter((p) => !p.nonFood);

function product(slug: string): CatalogProduct {
  const p = getCatalogProduct(slug);
  if (!p) throw new Error(`missing catalog product ${slug}`);
  return p;
}

/** How long one package lasts `people` adult-equivalents, from the prior. */
function daysPerPackage(slug: string, people: number): number {
  const p = product(slug);
  return p.packageQuantity / ((p.dailyUsePerPerson ?? Number.NaN) * people);
}

describe("catalog integrity", () => {
  it("has a few hundred products with unique kebab-case slugs", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(300);
    const slugs = CATALOG.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("uses sentence-case names that are unique", () => {
    const names = CATALOG.map((p) => p.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const { name } of CATALOG) {
      expect(name.charAt(0)).toBe(name.charAt(0).toUpperCase());
      // Only the first letter is capitalised, apart from acronyms such as "BBQ".
      const rest = name.replace(/\bBBQ\b/g, "bbq").slice(1);
      expect(rest, name).toBe(rest.toLowerCase());
    }
  });

  it("only uses valid aisles, locations, units and contains flags", () => {
    for (const p of CATALOG) {
      expect(AISLES).toContain(p.aisle);
      expect(STORAGE_LOCATIONS).toContain(p.location);
      expect(isUnit(p.unit)).toBe(true);
      for (const flag of p.contains ?? []) expect(CONTAINS_FLAGS).toContain(flag);
      expect(new Set(p.contains ?? []).size).toBe((p.contains ?? []).length);
    }
  });

  it("keeps numbers in realistic ranges", () => {
    for (const p of CATALOG) {
      expect(p.packageQuantity, p.slug).toBeGreaterThan(0);
      if (p.shelfLifeDays !== undefined) expect(p.shelfLifeDays, p.slug).toBeGreaterThanOrEqual(1);
      if (p.shelfLifeDays !== undefined) expect(p.shelfLifeDays, p.slug).toBeLessThanOrEqual(3650);
      if (p.eachWeightG !== undefined) expect(p.eachWeightG, p.slug).toBeGreaterThan(0);
      if (p.eachWeightG !== undefined) expect(p.eachWeightG, p.slug).toBeLessThanOrEqual(5000);
      if (p.densityGPerMl !== undefined) expect(p.densityGPerMl, p.slug).toBeGreaterThan(0.3);
      if (p.densityGPerMl !== undefined) expect(p.densityGPerMl, p.slug).toBeLessThan(2);
      if (p.freezerShelfLifeDays !== undefined && p.shelfLifeDays !== undefined && p.location !== "freezer") {
        // Freezing only ever extends life.
        expect(p.freezerShelfLifeDays, p.slug).toBeGreaterThan(p.shelfLifeDays);
      }
    }
  });

  it("marks perishables consistently with their shelf life", () => {
    for (const p of food) {
      if (p.shelfLifeDays === undefined || p.location === "freezer") continue;
      expect(p.perishable, `${p.slug} (${p.shelfLifeDays} days)`).toBe(p.shelfLifeDays <= 14);
    }
    expect(product("full-cream-milk").perishable).toBe(true);
    expect(product("chicken-breast").perishable).toBe(true);
    expect(product("spaghetti").perishable).toBe(false);
    expect(product("frozen-peas").perishable).toBe(false);
  });

  it("gives counted food a weight or volume so gram and ml recipes can be matched", () => {
    for (const p of food) {
      if (unitDimension(p.unit) !== "count" || p.pantryBasic) continue;
      expect(p.eachWeightG ?? p.eachVolumeMl, p.slug).toBeDefined();
    }
    // A 400 g can of tomatoes, a 650 g loaf, a 120 g banana.
    expect(convert(2, "can", "g", product("diced-tomatoes"))).toBe(800);
    expect(convert(1, "loaf", "g", product("white-bread"))).toBe(650);
    expect(convert(600, "g", "each", product("banana"))).toBe(5);
  });

  it("gives liquids tracked by volume a density", () => {
    for (const p of food) {
      if (unitDimension(p.unit) === "volume") expect(p.densityGPerMl, p.slug).toBeDefined();
    }
    expect(product("full-cream-milk").densityGPerMl).toBeCloseTo(1.03);
    expect(convert(750, "ml", "g", product("olive-oil"))).toBeCloseTo(690);
  });

  it("matches the documented reference products", () => {
    expect(product("full-cream-milk")).toMatchObject({ unit: "l", packageQuantity: 2, shelfLifeDays: 10 });
    expect(product("eggs")).toMatchObject({ unit: "each", packageQuantity: 12, shelfLifeDays: 28 });
    expect(product("beef-mince")).toMatchObject({ unit: "g", packageQuantity: 500 });
    expect(product("white-bread")).toMatchObject({ unit: "loaf", packageQuantity: 1, eachWeightG: 650, shelfLifeDays: 6 });
    expect(product("baby-spinach")).toMatchObject({ unit: "g", packageQuantity: 120, shelfLifeDays: 5 });
    expect(product("diced-tomatoes")).toMatchObject({ unit: "can", packageQuantity: 1, eachWeightG: 400 });
    expect(product("olive-oil")).toMatchObject({ unit: "ml", packageQuantity: 750, densityGPerMl: 0.92 });
    expect(product("chicken-breast").shelfLifeDays).toBe(3);
    expect(product("spaghetti").shelfLifeDays).toBe(700);
  });
});

describe("consumption priors", () => {
  it("are calibrated to how a two-adult household actually uses staples", () => {
    expect(daysPerPackage("full-cream-milk", 2)).toBeGreaterThanOrEqual(4);
    expect(daysPerPackage("full-cream-milk", 2)).toBeLessThanOrEqual(5.5);
    expect(daysPerPackage("white-bread", 2)).toBeGreaterThanOrEqual(3.5);
    expect(daysPerPackage("white-bread", 2)).toBeLessThanOrEqual(5);
    expect(daysPerPackage("eggs", 2)).toBeGreaterThanOrEqual(12);
    expect(daysPerPackage("eggs", 2)).toBeLessThanOrEqual(16);
  });

  it("make one package last a single person a plausible time", () => {
    for (const p of CATALOG) {
      if (p.dailyUsePerPerson === undefined) continue;
      expect(p.dailyUsePerPerson, p.slug).toBeGreaterThan(0);
      const days = daysPerPackage(p.slug, 1);
      expect(days, p.slug).toBeGreaterThanOrEqual(4);
      expect(days, p.slug).toBeLessThanOrEqual(400);
    }
  });

  it("only exist for continuously consumed products", () => {
    for (const slug of ["full-cream-milk", "white-bread", "eggs", "butter", "natural-yoghurt", "tasty-cheese", "banana", "apple", "instant-coffee", "black-tea", "breakfast-cereal", "orange-juice", "toilet-paper"]) {
      expect(product(slug).dailyUsePerPerson, slug).toBeGreaterThan(0);
    }
    for (const slug of ["coriander", "fish-sauce", "ground-cumin", "paprika", "aluminium-foil", "salt", "chicken-breast", "spaghetti", "nappies", "dry-dog-food"]) {
      expect(product(slug).dailyUsePerPerson, slug).toBeUndefined();
    }
  });
});

describe("flags", () => {
  it("records allergens and diet-relevant contents accurately", () => {
    expect(product("white-bread").contains).toContain("gluten");
    expect(product("spaghetti").contains).toContain("gluten");
    expect(product("egg-noodles").contains).toEqual(expect.arrayContaining(["gluten", "egg"]));
    expect(product("soy-sauce").contains).toEqual(expect.arrayContaining(["soy", "gluten"]));
    expect(product("tamari").contains).not.toContain("gluten");
    expect(product("cheddar-cheese").contains).toContain("dairy");
    expect(product("pesto").contains).toEqual(expect.arrayContaining(["dairy", "tree_nuts"]));
    expect(product("chicken-thigh").contains).toEqual(["poultry"]);
    expect(product("bacon").contains).toContain("pork");
    expect(product("beer").contains).toEqual(expect.arrayContaining(["gluten", "alcohol"]));
    expect(product("peanut-butter").contains).toEqual(["peanuts"]);
    expect(product("raw-prawns").contains).toEqual(["shellfish"]);
    expect(product("hummus").contains).toContain("sesame");
    expect(product("honey").contains).toEqual(["honey"]);
    expect(product("oat-milk").contains).not.toContain("dairy");
    expect(product("gluten-free-bread").contains ?? []).not.toContain("gluten");
    for (const slug of ["banana", "baby-spinach", "white-rice", "olive-oil", "chickpeas"]) {
      expect(product(slug).contains ?? [], slug).toEqual([]);
    }
  });

  it("assumes only salt, pepper and water are always on hand", () => {
    const basics = CATALOG.filter((p) => p.pantryBasic).map((p) => p.slug);
    expect(basics.sort()).toEqual(["black-pepper", "salt", "water"]);
  });

  it("seeds around 25 common staples, all of them food or toilet paper", () => {
    const staples = CATALOG.filter((p) => p.commonStaple);
    expect(staples.length).toBeGreaterThanOrEqual(20);
    expect(staples.length).toBeLessThanOrEqual(32);
    for (const slug of ["full-cream-milk", "white-bread", "eggs", "banana", "brown-onion", "toilet-paper"]) {
      expect(product(slug).commonStaple, slug).toBe(true);
    }
  });

  it("marks household, personal care and pet products as non-food", () => {
    for (const p of CATALOG) {
      if (p.aisle === "household" || p.aisle === "personal_care" || p.aisle === "pet") expect(p.nonFood, p.slug).toBe(true);
      if (["produce", "dairy", "meat", "seafood", "bakery", "pantry", "frozen"].includes(p.aisle)) expect(p.nonFood ?? false, p.slug).toBe(false);
    }
    expect(product("nappies").nonFood).toBe(true);
    expect(product("infant-formula").nonFood ?? false).toBe(false);
    expect(product("wet-cat-food").nonFood).toBe(true);
  });
});

describe("substitution groups", () => {
  it("never leaves a group with a single member", () => {
    for (const group of catalogGroups()) {
      expect(catalogProductsInGroup(group).length, group).toBeGreaterThanOrEqual(2);
    }
  });

  it("groups interchangeable families and keeps non-substitutes apart", () => {
    const slugs = (group: string) => catalogProductsInGroup(group).map((p) => p.slug);
    expect(slugs("milk")).toEqual(expect.arrayContaining(["full-cream-milk", "lite-milk", "skim-milk", "lactose-free-milk", "oat-milk", "almond-milk", "soy-milk"]));
    expect(slugs("pasta")).toEqual(expect.arrayContaining(["spaghetti", "penne", "fusilli"]));
    expect(slugs("rice")).toEqual(expect.arrayContaining(["white-rice", "basmati-rice", "jasmine-rice"]));
    expect(slugs("chicken")).toEqual(expect.arrayContaining(["chicken-breast", "chicken-thigh"]));
    expect(slugs("onion")).toEqual(["brown-onion", "red-onion", "white-onion"]);
    expect(slugs("bread")).toEqual(expect.arrayContaining(["white-bread", "wholemeal-bread", "multigrain-bread", "sourdough"]));
    expect(slugs("cheddar")).toEqual(expect.arrayContaining(["cheddar-cheese", "tasty-cheese"]));
    expect(slugs("lettuce")).toEqual(expect.arrayContaining(["iceberg-lettuce", "cos-lettuce"]));
    // Not substitutes: flavoured milk, coconut milk, spring onion, arborio, tomato paste.
    expect(product("flavoured-milk").group).toBeUndefined();
    expect(product("coconut-milk").group).not.toBe("milk");
    expect(product("spring-onion").group).toBeUndefined();
    expect(product("arborio-rice").group).toBeUndefined();
    expect(product("tomato-paste").group).toBeUndefined();
  });
});

describe("aliases", () => {
  it("are lower-case, non-empty and not repeated within a product", () => {
    for (const p of CATALOG) {
      expect(p.aliases.length, p.slug).toBeGreaterThan(0);
      expect(new Set(p.aliases).size, p.slug).toBe(p.aliases.length);
      for (const alias of p.aliases) {
        expect(alias, p.slug).toBe(alias.toLowerCase());
        expect(alias.trim(), p.slug).toBe(alias);
        expect(alias.length, p.slug).toBeGreaterThan(1);
      }
    }
  });

  it("never mean two different products once normalised", () => {
    const owners = new Map<string, Set<string>>();
    for (const p of CATALOG) {
      for (const phrase of [p.name, ...p.aliases]) {
        const key = singularizePhrase(cleanReceiptText(phrase, { stripBrands: false }).cleaned);
        const set = owners.get(key) ?? new Set<string>();
        set.add(p.slug);
        owners.set(key, set);
      }
    }
    const collisions = [...owners].filter(([, set]) => set.size > 1).map(([key, set]) => `${key}: ${[...set].join(", ")}`);
    expect(collisions).toEqual([]);
  });

  it("each lead back to their own product when matched", () => {
    const misses: string[] = [];
    for (const p of CATALOG) {
      for (const phrase of [p.name, ...p.aliases]) {
        const match = matchProduct(phrase);
        if (match?.product.slug !== p.slug || match.score < 0.9) {
          misses.push(`${phrase} → ${match ? `${match.product.slug} (${match.score})` : "nothing"} (expected ${p.slug})`);
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it("cover Australian, UK and US names for the same thing", () => {
    const pairs: Array<[string, string]> = [
      ["courgette", "zucchini"],
      ["aubergine", "eggplant"],
      ["cilantro", "coriander"],
      ["shrimp", "raw-prawns"],
      ["ground beef", "beef-mince"],
      ["bell pepper", "red-capsicum"],
      ["arugula", "rocket"],
      ["scallions", "spring-onion"],
      ["cling film", "cling-wrap"],
      ["diapers", "nappies"],
      ["crisps", "potato-chips"],
      ["semi skimmed milk", "lite-milk"],
    ];
    for (const [alias, slug] of pairs) expect(product(slug).aliases, slug).toContain(alias);
  });
});

describe("lookups", () => {
  it("finds products by slug", () => {
    expect(getCatalogProduct("full-cream-milk")?.name).toBe("Full cream milk");
    expect(getCatalogProduct("unicorn-steak")).toBeUndefined();
    expect(CATALOG_BY_SLUG.size).toBe(CATALOG.length);
    expect(CATALOG_BY_SLUG.get("banana")).toBe(product("banana"));
  });

  it("lists group members in catalog order and returns a fresh array", () => {
    const berries = catalogProductsInGroup("berry");
    expect(berries.map((p) => p.slug)).toEqual(["strawberries", "blueberries", "raspberries"]);
    berries.pop();
    expect(catalogProductsInGroup("berry")).toHaveLength(3);
    expect(catalogProductsInGroup("no-such-group")).toEqual([]);
  });

  it("converts to runtime product info with defaults filled in", () => {
    const info = productInfoFromCatalog(product("banana"));
    expect(info).toMatchObject({ id: "banana", slug: "banana", unit: "each", eachWeightG: 120, pantryBasic: false, nonFood: false });
    expect(info.contains).toEqual([]);
  });
});
