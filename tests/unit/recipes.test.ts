import { describe, expect, it } from "vitest";
import { getCatalogProduct, type CatalogProduct } from "@/lib/catalog";
import { CONTAINS_FLAGS, CUISINES, DIETS, DIFFICULTIES, type Cuisine, type Diet } from "@/lib/domain";
import {
  QUICK_MAX_MINUTES,
  RECIPES,
  RECIPES_BY_SLUG,
  RECIPE_TAGS,
  WEEKEND_MIN_MINUTES,
  getRecipe,
  isRecipeCompatibleWithDiet,
  isRecipeTag,
  recipeAllergens,
  recipeContains,
  recipeDiets,
  recipesUsingProduct,
  type Recipe,
  type RecipeIngredient,
} from "@/lib/recipes";
import { convert, isContainerUnit, isUnit, unitDimension } from "@/lib/units";

// ─── Helpers ────────────────────────────────────────────────────────────────

function recipe(slug: string): Recipe {
  const r = getRecipe(slug);
  if (!r) throw new Error(`missing recipe ${slug}`);
  return r;
}

function product(slug: string): CatalogProduct {
  const p = getCatalogProduct(slug);
  if (!p) throw new Error(`missing catalog product ${slug}`);
  return p;
}

/** Catalog slugs a recipe genuinely needs (optional extras excluded). */
function requiredSlugs(r: Recipe): Set<string> {
  return new Set(r.ingredients.filter((i) => i.product !== null && !i.optional).map((i) => i.product as string));
}

function usesAny(r: Recipe, slugs: readonly string[]): boolean {
  const needed = requiredSlugs(r);
  return slugs.some((slug) => needed.has(slug));
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).filter(Boolean);
}

/** Every piece of prose a cook reads for a recipe, lower-cased. */
function prose(r: Recipe): string {
  return [r.name, r.description, ...r.steps, ...r.ingredients.map((i) => `${i.name} ${i.note ?? ""}`)].join(" ").toLowerCase();
}

/** The ingredient's quantity in its catalog product's tracking unit, or null when not convertible. */
function inTrackingUnit(ingredient: RecipeIngredient): number | null {
  if (!ingredient.product || ingredient.quantity === undefined || !ingredient.unit) return null;
  const p = product(ingredient.product);
  return convert(ingredient.quantity, ingredient.unit, p.unit, p);
}

const forDiet = (diet: Diet) => RECIPES.filter((r) => isRecipeCompatibleWithDiet(r, diet));
const quick = RECIPES.filter((r) => r.timeMinutes <= QUICK_MAX_MINUTES);

/** Specialist items the catalog doesn't stock yet; each was reviewed to carry no diet or allergen flag. */
const REVIEWED_FREE_TEXT = new Set(["tamarind purée", "rice paper sheets", "sumac", "capers", "saffron threads"]);

const ANIMAL_WORDS =
  /\b(chicken|beef|pork|lamb|veal|bacon|ham|prosciutto|pancetta|chorizo|salami|sausages?|mince|steak|prawns?|shrimp|fish|salmon|tuna|anchov\w*|oyster|worcestershire|gelatine|lard)\b/;

// ─── Integrity ──────────────────────────────────────────────────────────────

describe("recipe library integrity", () => {
  it("has 64 recipes with unique kebab-case slugs, all indexed", () => {
    expect(RECIPES).toHaveLength(64);
    const slugs = RECIPES.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(RECIPES_BY_SLUG.size).toBe(RECIPES.length);
    const names = RECIPES.map((r) => r.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every recipe a real cuisine, difficulty, cooking time and serving count", () => {
    for (const r of RECIPES) {
      expect(CUISINES, r.slug).toContain(r.cuisine);
      expect(r.cuisine, r.slug).not.toBe("other");
      expect(DIFFICULTIES, r.slug).toContain(r.difficulty);
      expect(Number.isInteger(r.timeMinutes), r.slug).toBe(true);
      expect(r.timeMinutes, r.slug).toBeGreaterThanOrEqual(10);
      expect(r.timeMinutes, r.slug).toBeLessThanOrEqual(120);
      expect(Number.isInteger(r.servings), r.slug).toBe(true);
      expect(r.servings, r.slug).toBeGreaterThanOrEqual(2);
      expect(r.servings, r.slug).toBeLessThanOrEqual(8);
    }
    expect(RECIPES.filter((r) => r.servings === 4).length).toBeGreaterThanOrEqual(50);
  });

  it("describes each dish in one specific sentence without marketing clichés", () => {
    const cliches = /\b(delicious|yummy|scrumptious|delectable|amazing|perfect|ultimate|best[- ]ever|mouth-?watering|irresistible|to die for|game[- ]changer|crowd[- ]pleaser)\b/i;
    for (const r of RECIPES) {
      expect(sentences(r.description), r.slug).toHaveLength(1);
      expect(r.description, r.slug).toMatch(/^[A-Z].*\.$/);
      expect(r.description.length, r.slug).toBeLessThanOrEqual(200);
      expect(r.description, r.slug).not.toMatch(cliches);
    }
  });

  it("has 4–8 concrete steps of one or two sentences each", () => {
    for (const r of RECIPES) {
      expect(r.steps.length, r.slug).toBeGreaterThanOrEqual(4);
      expect(r.steps.length, r.slug).toBeLessThanOrEqual(8);
      expect(new Set(r.steps).size, r.slug).toBe(r.steps.length);
      for (const step of r.steps) {
        expect(step, r.slug).toMatch(/^[A-Z].*[.!]$/);
        expect(sentences(step).length, `${r.slug}: ${step}`).toBeLessThanOrEqual(2);
        expect(step.length, `${r.slug}: ${step}`).toBeLessThanOrEqual(300);
      }
    }
  });

  it("is written in Australian English with metric measures", () => {
    const foreign =
      /\b(cilantro|bell peppers?|scallions?|green onions?|shrimp|arugula|ground (beef|pork|lamb|meat)|yogurt|flavor|color|center|broil|skillet|all-purpose|heavy cream|powdered sugar|fahrenheit|ounces?|oz|lbs?|cups? of)\b|°f\b/;
    for (const r of RECIPES) expect(prose(r), r.slug).not.toMatch(foreign);
    // Oven temperatures give the fan-forced equivalent too.
    for (const r of RECIPES) {
      for (const step of r.steps.filter((s) => /\d+°C/.test(s) && /preheat/i.test(s))) expect(step, r.slug).toMatch(/fan-forced/);
    }
  });

  it("uses only library tags, and quick/weekend agree with the cooking time", () => {
    for (const r of RECIPES) {
      expect(new Set(r.tags).size, r.slug).toBe(r.tags.length);
      for (const tag of r.tags) expect(isRecipeTag(tag), `${r.slug}: ${tag}`).toBe(true);
      expect(r.tags.includes("quick"), r.slug).toBe(r.timeMinutes <= QUICK_MAX_MINUTES);
      expect(r.tags.includes("weekend"), r.slug).toBe(r.timeMinutes >= WEEKEND_MIN_MINUTES);
    }
    // Every tag is actually used somewhere, so filters never come up empty.
    for (const tag of RECIPE_TAGS) expect(RECIPES.some((r) => r.tags.includes(tag)), tag).toBe(true);
  });

  it("names a simple lowercase hero ingredient that the recipe really contains", () => {
    const heroAliases: Record<string, string[]> = { beef: ["steak"], pasta: ["macaroni", "spaghetti", "penne"] };
    for (const r of RECIPES) {
      expect(r.mainIngredient, r.slug).toMatch(/^[a-z]+(?: [a-z]+)?$/);
      const words = [r.mainIngredient, ...(heroAliases[r.mainIngredient] ?? [])];
      const text = r.ingredients.map((i) => `${i.name} ${i.product ?? ""}`.toLowerCase()).join(" | ");
      expect(words.some((w) => text.includes(w) || text.includes(w.replace(/s$/, ""))), r.slug).toBe(true);
    }
  });
});

// ─── Ingredients against the catalog ───────────────────────────────────────

describe("recipe ingredients resolve to the catalog", () => {
  it("references only catalog food products by slug", () => {
    const unknown: string[] = [];
    for (const r of RECIPES) {
      for (const i of r.ingredients) {
        if (i.product === null) continue;
        const p = getCatalogProduct(i.product);
        if (!p) unknown.push(`${r.slug}: ${i.product}`);
        else expect(p.nonFood ?? false, `${r.slug}: ${i.product}`).toBe(false);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("keeps free-text ingredients to a reviewed handful, at most one per recipe", () => {
    for (const r of RECIPES) {
      const freeText = r.ingredients.filter((i) => i.product === null);
      expect(freeText.length, r.slug).toBeLessThanOrEqual(1);
      for (const i of freeText) {
        expect(REVIEWED_FREE_TEXT.has(i.name), `${r.slug}: ${i.name}`).toBe(true);
        expect(i.quantity, `${r.slug}: ${i.name}`).toBeGreaterThan(0);
        expect(i.unit && isUnit(i.unit), `${r.slug}: ${i.name}`).toBe(true);
      }
    }
  });

  it("leaves pantry basics unquantified and quantifies everything else", () => {
    for (const r of RECIPES) {
      for (const i of r.ingredients) {
        const label = `${r.slug}: ${i.name}`;
        if (i.product && product(i.product).pantryBasic) {
          expect(i.quantity, label).toBeUndefined();
          expect(i.unit, label).toBeUndefined();
          continue;
        }
        expect(i.quantity, label).toBeDefined();
        expect(Number.isFinite(i.quantity) && (i.quantity ?? 0) > 0, label).toBe(true);
        expect(isUnit(i.unit), label).toBe(true);
      }
      // The same product isn't listed twice (steps split shared amounts instead).
      const slugs = r.ingredients.filter((i) => i.product !== null).map((i) => i.product);
      expect(new Set(slugs).size, r.slug).toBe(slugs.length);
    }
  });

  it("gives every quantity in a unit that converts to the product's tracking unit", () => {
    const unconvertible: string[] = [];
    for (const r of RECIPES) {
      for (const i of r.ingredients) {
        if (!i.product || i.quantity === undefined || !i.unit) continue;
        if (inTrackingUnit(i) === null) {
          const p = product(i.product);
          unconvertible.push(`${r.slug}: ${i.quantity} ${i.unit} ${i.product} → ${p.unit}`);
        }
      }
    }
    expect(unconvertible).toEqual([]);
  });

  it("never counts a container unit as a different kind of count", () => {
    // convert() treats every count unit 1:1, so "2 cloves" of a product tracked
    // in whole bulbs would read as 2 bulbs. Container units must match the
    // product's own unit unless the product is weighed or measured.
    const mismatched: string[] = [];
    for (const r of RECIPES) {
      for (const i of r.ingredients) {
        if (!i.product || !i.unit || !isContainerUnit(i.unit)) continue;
        const p = product(i.product);
        if (unitDimension(p.unit) === "count" && p.unit !== i.unit) mismatched.push(`${r.slug}: ${i.unit} of ${i.product} (tracked in ${p.unit})`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("asks for realistic amounts: no ingredient needs more than four packages", () => {
    for (const r of RECIPES) {
      for (const i of r.ingredients) {
        const amount = inTrackingUnit(i);
        if (amount === null || !i.product) continue;
        const packages = amount / product(i.product).packageQuantity;
        expect(packages, `${r.slug}: ${i.quantity} ${i.unit} ${i.product}`).toBeLessThanOrEqual(4);
      }
    }
  });

  it("portions meat and seafood at 100–350 g per serving", () => {
    for (const r of RECIPES) {
      let grams = 0;
      for (const i of r.ingredients) {
        if (!i.product || i.quantity === undefined || !i.unit) continue;
        const p = product(i.product);
        if (p.aisle !== "meat" && p.aisle !== "seafood") continue;
        grams += convert(i.quantity, i.unit, "g", p) ?? Number.NaN;
      }
      if (grams === 0) continue;
      const perServing = grams / r.servings;
      expect(perServing, r.slug).toBeGreaterThanOrEqual(100);
      expect(perServing, r.slug).toBeLessThanOrEqual(350);
    }
  });
});

// ─── Coverage ───────────────────────────────────────────────────────────────

describe("recipe library coverage", () => {
  it("spans every cuisine Plenty offers", () => {
    const counts = new Map<Cuisine, number>();
    for (const r of RECIPES) counts.set(r.cuisine, (counts.get(r.cuisine) ?? 0) + 1);
    for (const cuisine of CUISINES.filter((c) => c !== "other")) expect(counts.get(cuisine) ?? 0, cuisine).toBeGreaterThanOrEqual(2);
  });

  it("meets the dietary targets, derived from ingredients rather than labels", () => {
    const vegetarian = forDiet("vegetarian");
    const vegan = forDiet("vegan");
    expect(vegetarian.length).toBeGreaterThanOrEqual(22);
    expect(vegan.length).toBeGreaterThanOrEqual(8);
    expect(forDiet("gluten_free").length).toBeGreaterThanOrEqual(12);
    expect(forDiet("dairy_free").length).toBeGreaterThanOrEqual(12);
    // Households with a vegetarian can still eat quickly on a weeknight.
    expect(vegetarian.filter((r) => r.timeMinutes <= QUICK_MAX_MINUTES).length).toBeGreaterThanOrEqual(12);
  });

  it("has plenty of quick and kid-friendly dinners plus a few slower weekend cooks", () => {
    expect(quick.length).toBeGreaterThanOrEqual(30);
    expect(RECIPES.filter((r) => r.tags.includes("kid_friendly")).length).toBeGreaterThanOrEqual(10);
    const weekend = RECIPES.filter((r) => r.timeMinutes >= WEEKEND_MIN_MINUTES);
    expect(weekend.length).toBeGreaterThanOrEqual(3);
    for (const r of weekend) expect(r.timeMinutes, r.slug).toBeLessThanOrEqual(120);
  });

  it("spreads the protein across meat, seafood, eggs, tofu and legumes", () => {
    const heroes: Record<string, string[]> = {
      chicken: ["chicken"],
      beef: ["beef"],
      pork: ["pork", "sausages"],
      lamb: ["lamb"],
      fish: ["fish", "salmon"],
      prawns: ["prawns"],
      eggs: ["eggs"],
      tofu: ["tofu"],
      legumes: ["chickpeas", "lentils", "black beans", "butter beans"],
    };
    for (const [protein, mains] of Object.entries(heroes)) {
      expect(RECIPES.filter((r) => mains.includes(r.mainIngredient)).length, protein).toBeGreaterThanOrEqual(2);
    }
    // No single hero dominates the week.
    const byMain = new Map<string, number>();
    for (const r of RECIPES) byMain.set(r.mainIngredient, (byMain.get(r.mainIngredient) ?? 0) + 1);
    for (const [main, count] of byMain) expect(count / RECIPES.length, main).toBeLessThanOrEqual(0.2);
  });

  it("gives commonly wasted perishables at least three homes each", () => {
    const perishables: Record<string, string[]> = {
      spinach: ["baby-spinach"],
      herbs: ["coriander", "parsley", "basil", "mint", "dill", "thyme", "rosemary"],
      capsicum: ["red-capsicum", "green-capsicum", "yellow-capsicum"],
      zucchini: ["zucchini"],
      mushrooms: ["mushrooms"],
      broccoli: ["broccoli", "broccolini"],
      cream: ["thickened-cream", "sour-cream"],
      yoghurt: ["natural-yoghurt", "greek-yoghurt"],
      tomatoes: ["tomato", "cherry-tomatoes"],
      bread: ["white-bread", "sourdough", "pita-bread", "baguette"],
    };
    for (const [kind, slugs] of Object.entries(perishables)) {
      expect(RECIPES.filter((r) => usesAny(r, slugs)).length, kind).toBeGreaterThanOrEqual(3);
    }
  });

  it("offers pantry-first dinners for a near-empty fridge", () => {
    const pantryDinners = [
      "spaghetti-aglio-e-olio",
      "pasta-e-ceci",
      "egg-fried-rice",
      "chickpea-and-spinach-curry",
      "red-lentil-dal",
      "shakshuka",
      "spinach-capsicum-and-feta-frittata",
    ];
    for (const slug of pantryDinners) expect(recipe(slug).tags, slug).toContain("pantry");
    expect(RECIPES.filter((r) => r.tags.includes("pantry")).length).toBeGreaterThanOrEqual(10);
  });
});

describe("must-have recipes", () => {
  it("has a chicken stir-fry on the table in about 24 minutes", () => {
    const r = recipe("chicken-stir-fry");
    expect(r.cuisine).toBe("chinese");
    expect(r.timeMinutes).toBeGreaterThanOrEqual(20);
    expect(r.timeMinutes).toBeLessThanOrEqual(QUICK_MAX_MINUTES);
    expect(r.tags).toContain("quick");
    expect(usesAny(r, ["chicken-breast", "chicken-thigh"])).toBe(true);
    expect(usesAny(r, ["broccoli", "red-capsicum", "snow-peas"])).toBe(true);
  });

  it("has a chicken curry", () => {
    const r = recipe("chicken-curry");
    expect(r.cuisine).toBe("indian");
    expect(r.mainIngredient).toBe("chicken");
    expect(usesAny(r, ["chicken-thigh", "chicken-breast"])).toBe(true);
  });

  it("has spaghetti bolognese, beef tacos and pasta with tomato sauce", () => {
    const bolognese = recipe("spaghetti-bolognese");
    expect(usesAny(bolognese, ["beef-mince"]) && usesAny(bolognese, ["spaghetti"])).toBe(true);

    const tacos = recipe("beef-tacos");
    expect(tacos.cuisine).toBe("mexican");
    expect(usesAny(tacos, ["beef-mince"]) && usesAny(tacos, ["taco-shells"])).toBe(true);

    const tomatoPasta = recipe("pasta-with-tomato-sauce");
    expect(isRecipeCompatibleWithDiet(tomatoPasta, "vegetarian")).toBe(true);
    expect(usesAny(tomatoPasta, ["whole-peeled-tomatoes", "crushed-tomatoes", "diced-tomatoes", "passata"])).toBe(true);
  });

  it("has a vegetarian spinach and ricotta dish", () => {
    const r = recipe("spinach-and-ricotta-lasagne");
    expect(usesAny(r, ["baby-spinach"]) && usesAny(r, ["ricotta"])).toBe(true);
    expect(isRecipeCompatibleWithDiet(r, "vegetarian")).toBe(true);
  });
});

// ─── Derived diet and allergen facts ────────────────────────────────────────

describe("recipeContains", () => {
  it("is the union of the catalog flags of the ingredients, in CONTAINS_FLAGS order", () => {
    // Oyster sauce quietly makes a chicken stir-fry a shellfish dish.
    expect(recipeContains(recipe("chicken-stir-fry"))).toEqual(["poultry", "shellfish", "gluten", "soy", "sesame"]);
    expect(recipeContains(recipe("spaghetti-bolognese"))).toEqual(["meat", "dairy", "gluten"]);
    expect(recipeContains(recipe("prawn-pad-thai"))).toEqual(["fish", "shellfish", "egg", "peanuts"]);
    expect(recipeContains(recipe("red-lentil-dal"))).toEqual([]);
    for (const r of RECIPES) {
      const flags = recipeContains(r);
      const order = flags.map((f) => CONTAINS_FLAGS.indexOf(f));
      expect(order, r.slug).toEqual([...order].sort((a, b) => a - b));
      expect(new Set(flags).size, r.slug).toBe(flags.length);
    }
  });

  it("ignores free-text and unknown products and collapses repeats", () => {
    const flags = recipeContains({
      ingredients: [
        { product: "soy-sauce", name: "soy sauce", quantity: 1, unit: "tbsp" },
        { product: "tamari", name: "tamari", quantity: 1, unit: "tbsp" },
        { product: null, name: "capers", quantity: 1, unit: "tbsp" },
        { product: "not-a-real-product", name: "mystery", quantity: 1, unit: "each" },
      ],
    });
    expect(flags).toContain("soy");
    expect(flags).not.toContain("fish");
    expect(flags.filter((f) => f === "soy")).toHaveLength(1);
    expect(recipeContains({ ingredients: [] })).toEqual([]);
  });

  it("gives the same answer with or without optional extras for every library recipe", () => {
    for (const r of RECIPES) {
      const required = { ingredients: r.ingredients.filter((i) => !i.optional) };
      expect(recipeContains(r), r.slug).toEqual(recipeContains(required));
    }
  });
});

describe("diet compatibility", () => {
  it("applies DIET_EXCLUDES to what a dish contains", () => {
    expect(recipeDiets(recipe("chickpea-and-spinach-curry"))).toEqual([...DIETS]);
    expect(recipeDiets(recipe("spaghetti-bolognese"))).toEqual(["halal", "no_pork"]);
    // Chorizo rules paella out for halal and no-pork households but not for no-red-meat ones.
    const paella = recipe("chicken-and-chorizo-paella");
    expect(isRecipeCompatibleWithDiet(paella, "halal")).toBe(false);
    expect(isRecipeCompatibleWithDiet(paella, "no_pork")).toBe(false);
    expect(isRecipeCompatibleWithDiet(paella, "no_red_meat")).toBe(true);
    expect(isRecipeCompatibleWithDiet(paella, "gluten_free")).toBe(true);
    // Prawns suit pescatarians, not vegetarians.
    const prawnTacos = recipe("prawn-tacos-with-lime-slaw");
    expect(isRecipeCompatibleWithDiet(prawnTacos, "pescatarian")).toBe(true);
    expect(isRecipeCompatibleWithDiet(prawnTacos, "vegetarian")).toBe(false);
  });

  it("catches hidden animal products in otherwise meat-free ingredient lists", () => {
    const caesarStyle = {
      ingredients: [
        { product: "cos-lettuce", name: "cos lettuce", quantity: 1, unit: "each" as const },
        { product: "parmesan", name: "parmesan", quantity: 40, unit: "g" as const },
        { product: "worcestershire-sauce", name: "Worcestershire sauce", quantity: 1, unit: "tsp" as const },
      ],
    };
    expect(isRecipeCompatibleWithDiet(caesarStyle, "vegetarian")).toBe(false);
    expect(isRecipeCompatibleWithDiet(caesarStyle, "pescatarian")).toBe(true);
    expect(isRecipeCompatibleWithDiet(recipe("thai-green-chicken-curry"), "pescatarian")).toBe(false);
  });

  it("agrees with recipeDiets, and vegan ⊂ vegetarian ⊂ pescatarian, across the library", () => {
    for (const r of RECIPES) {
      const diets = recipeDiets(r);
      for (const diet of DIETS) expect(diets.includes(diet), `${r.slug}: ${diet}`).toBe(isRecipeCompatibleWithDiet(r, diet));
      if (diets.includes("vegan")) expect(diets, r.slug).toContain("vegetarian");
      if (diets.includes("vegetarian")) expect(diets, r.slug).toContain("pescatarian");
    }
  });

  it("reports allergens in ALLERGENS order", () => {
    expect(recipeAllergens(recipe("chicken-stir-fry"))).toEqual(["gluten", "soy", "shellfish", "sesame"]);
    expect(recipeAllergens(recipe("prawn-pad-thai"))).toEqual(["peanuts", "egg", "fish", "shellfish"]);
    // Poultry and pork are diet flags, not allergens.
    expect(recipeAllergens(recipe("chicken-and-chorizo-paella"))).toEqual([]);
  });
});

describe("vegetarian labelling is safe", () => {
  it("never marks a dish vegetarian when it uses meat, poultry or seafood", () => {
    for (const r of forDiet("vegetarian")) {
      for (const i of r.ingredients) {
        const label = `${r.slug}: ${i.name}`;
        expect(i.name.toLowerCase(), label).not.toMatch(ANIMAL_WORDS);
        if (!i.product) continue;
        expect(i.product, label).not.toMatch(ANIMAL_WORDS);
        expect(["meat", "seafood"], label).not.toContain(product(i.product).aisle);
        if (/stock/.test(i.product)) expect(i.product, label).toBe("vegetable-stock");
      }
    }
  });

  it("keeps every meat or seafood dish out of vegetarian plans", () => {
    const animalHeroes = new Set(["chicken", "beef", "pork", "sausages", "lamb", "fish", "salmon", "prawns"]);
    for (const r of RECIPES) {
      const usesAnimal = r.ingredients.some((i) => i.product !== null && ["meat", "seafood"].includes(product(i.product).aisle));
      if (animalHeroes.has(r.mainIngredient) || usesAnimal) expect(isRecipeCompatibleWithDiet(r, "vegetarian"), r.slug).toBe(false);
    }
  });

  it("keeps dairy, eggs and honey out of vegan dishes", () => {
    for (const r of forDiet("vegan")) {
      for (const i of r.ingredients) {
        if (!i.product) continue;
        expect(product(i.product).aisle, `${r.slug}: ${i.product}`).not.toBe("dairy");
        expect(["honey", "mayonnaise"], `${r.slug}: ${i.product}`).not.toContain(i.product);
      }
    }
  });
});

// ─── Lookups ────────────────────────────────────────────────────────────────

describe("lookups", () => {
  it("finds recipes by slug", () => {
    expect(getRecipe("shakshuka")?.name).toBe("Shakshuka");
    expect(getRecipe("shakshuka")).toBe(RECIPES_BY_SLUG.get("shakshuka"));
    expect(getRecipe("does-not-exist")).toBeUndefined();
  });

  it("recognises library tags only", () => {
    expect(isRecipeTag("quick")).toBe(true);
    expect(isRecipeTag("vegetarian")).toBe(false);
    expect(isRecipeTag(42)).toBe(false);
  });

  it("finds dinners that use up a product, in library order", () => {
    const spinach = recipesUsingProduct("baby-spinach").map((r) => r.slug);
    expect(spinach).toEqual(expect.arrayContaining(["spinach-and-ricotta-lasagne", "chickpea-and-spinach-curry", "spinach-and-feta-pie"]));
    const positions = spinach.map((slug) => RECIPES.findIndex((r) => r.slug === slug));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("widens to interchangeable products unless told not to", () => {
    const withGroup = recipesUsingProduct("cherry-tomatoes").map((r) => r.slug);
    const exact = recipesUsingProduct("cherry-tomatoes", { includeGroup: false });
    // Cherry tomatoes can stand in for the ordinary tomatoes in a dal.
    expect(withGroup).toContain("red-lentil-dal");
    expect(exact.map((r) => r.slug)).not.toContain("red-lentil-dal");
    for (const r of exact) expect(requiredSlugs(r).has("cherry-tomatoes"), r.slug).toBe(true);
    expect(withGroup.length).toBeGreaterThan(exact.length);
  });

  it("skips optional garnishes unless asked", () => {
    // Avocado is optional on beef tacos but essential in the burrito bowls.
    expect(recipesUsingProduct("avocado").map((r) => r.slug)).not.toContain("beef-tacos");
    expect(recipesUsingProduct("avocado").map((r) => r.slug)).toContain("black-bean-burrito-bowls");
    expect(recipesUsingProduct("avocado", { includeOptional: true }).map((r) => r.slug)).toContain("beef-tacos");
    expect(recipesUsingProduct("not-a-real-product")).toEqual([]);
  });
});
