import { describe, expect, it } from "vitest";
import { DIETS, type Allergen, type Diet } from "@/lib/domain";
import {
  catalogProductMap,
  ingredientsToOmit,
  isMealAllowed,
  libraryPlannableMeals,
  nameMatchesDislike,
  requiredContains,
  withoutOmittedIngredients,
  type DietPreferences,
  type MealIngredientInput,
  type PlannableMeal,
} from "@/lib/meals";
import { RECIPES, isRecipeCompatibleWithDiet, recipeContains } from "@/lib/recipes";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PRODUCTS = catalogProductMap();
const MEALS = libraryPlannableMeals();
const MEALS_BY_SLUG = new Map(MEALS.map((meal) => [meal.slug, meal]));

function meal(slug: string): PlannableMeal {
  const found = MEALS_BY_SLUG.get(slug);
  if (!found) throw new Error(`No library meal ${slug}`);
  return found;
}

function productWithId(slug: string, id: string) {
  const found = PRODUCTS.get(slug);
  if (!found) throw new Error(`No catalog product ${slug}`);
  return { ...found, id };
}

function prefs(overrides: Partial<DietPreferences> = {}): DietPreferences {
  return { diets: [], allergies: [], dislikedIngredients: [], ...overrides };
}

function allergic(...allergies: Allergen[]): DietPreferences {
  return prefs({ allergies });
}

function onDiet(...diets: Diet[]): DietPreferences {
  return prefs({ diets });
}

function dislikes(...dislikedIngredients: string[]): DietPreferences {
  return prefs({ dislikedIngredients });
}

function ing(name: string, productId: string | null, optional = false): MealIngredientInput {
  return { name, productId, quantity: null, unit: null, optional };
}

/** A household or AI meal, with `contains` derived from catalog slugs the way the adapters do. */
function customMeal(name: string, ingredients: MealIngredientInput[], mainIngredient: string, contains?: PlannableMeal["contains"]): PlannableMeal {
  const slug = name.toLowerCase().replace(/\s+/g, "-");
  return {
    id: slug,
    slug,
    name,
    cuisine: "other",
    timeMinutes: 20,
    difficulty: "easy",
    servings: 2,
    mainIngredient,
    tags: [],
    contains: contains ?? recipeContains({ ingredients: ingredients.map((i) => ({ product: i.productId, name: i.name, optional: i.optional })) }),
    ingredients,
    source: "user",
  };
}

// A weeknight noodle bowl whose only peanuts are an optional garnish.
const NOODLE_BOWL = customMeal(
  "Sesame noodle bowl",
  [
    ing("rice noodles", "rice-noodles"),
    ing("bok choy", "bok-choy"),
    ing("garlic", "garlic"),
    ing("vegetable oil", "vegetable-oil"),
    ing("crushed peanuts", "peanuts", true),
    ing("long red chilli", "chilli", true),
  ],
  "noodles",
);

// ─── Allergies ──────────────────────────────────────────────────────────────

describe("isMealAllowed — allergies", () => {
  it("rules out meals whose required ingredients carry the allergen, in plain language", () => {
    expect(isMealAllowed(meal("prawn-pad-thai"), allergic("peanuts"))).toEqual({ allowed: false, reason: "Contains peanuts" });
    expect(isMealAllowed(meal("tofu-rice-paper-rolls"), allergic("peanuts"))).toEqual({ allowed: false, reason: "Contains peanuts" });
    expect(isMealAllowed(meal("chicken-curry"), allergic("peanuts"))).toEqual({ allowed: true, reason: null });
  });

  it("catches hidden allergens that come from sauces, not the headline ingredient", () => {
    // Oyster sauce makes a chicken stir-fry a shellfish dish.
    expect(isMealAllowed(meal("chicken-stir-fry"), allergic("shellfish"))).toEqual({ allowed: false, reason: "Contains shellfish" });
    // Fish sauce in a Thai curry.
    expect(isMealAllowed(meal("thai-green-chicken-curry"), allergic("fish")).reason).toBe("Contains fish");
    // Soy sauce carries gluten.
    expect(isMealAllowed(meal("egg-fried-rice"), allergic("gluten")).reason).toBe("Contains gluten");
  });

  it("uses friendly allergen labels", () => {
    expect(isMealAllowed(meal("spanish-tortilla"), allergic("egg")).reason).toBe("Contains eggs");
    expect(isMealAllowed(meal("teriyaki-salmon-with-greens"), allergic("sesame")).reason).toBe("Contains sesame");
  });

  it("reports allergies before diets and dislikes", () => {
    const everything: DietPreferences = { allergies: ["peanuts"], diets: ["vegetarian"], dislikedIngredients: ["prawns"] };
    expect(isMealAllowed(meal("prawn-pad-thai"), everything).reason).toBe("Contains peanuts");
  });

  it("lets a meal through when the allergen is only in an optional garnish, and says to leave it out", () => {
    expect(NOODLE_BOWL.contains).toContain("peanuts");
    expect(isMealAllowed(NOODLE_BOWL, allergic("peanuts"))).toEqual({ allowed: true, reason: null });
    expect(ingredientsToOmit(NOODLE_BOWL, allergic("peanuts"))).toEqual([{ name: "crushed peanuts", productId: "peanuts", reason: "Contains peanuts" }]);
  });

  it("stays strict when a required ingredient's contents are unknown", () => {
    const withMysterySauce = customMeal("Mystery noodles", [...NOODLE_BOWL.ingredients, ing("house satay sauce", null)], "noodles");
    expect(isMealAllowed(withMysterySauce, allergic("peanuts"))).toEqual({ allowed: false, reason: "Contains peanuts" });
  });

  it("trusts flags an AI or household meal declares even without catalog products", () => {
    const aiMeal = customMeal("Garlic butter prawns", [ing("king prawns", null), ing("butter", null), ing("salt", null)], "prawns", ["shellfish", "dairy"]);
    expect(isMealAllowed(aiMeal, allergic("shellfish")).reason).toBe("Contains shellfish");
  });

  it("adds flags from required catalog products even when the meal's own label missed them", () => {
    const mislabelled = customMeal("Satay toast", [ing("peanut butter", "peanut-butter"), ing("sourdough", "sourdough")], "peanut butter", []);
    expect(requiredContains(mislabelled)).toEqual(expect.arrayContaining(["peanuts", "gluten"]));
    expect(isMealAllowed(mislabelled, allergic("peanuts")).allowed).toBe(false);
  });

  it("uses the supplied product map for runtime (database) ids", () => {
    const products = new Map([
      ["p-101", productWithId("peanuts", "p-101")],
      ["p-102", productWithId("rice-noodles", "p-102")],
    ]);
    const dbMeal = customMeal("Noodles", [ing("rice noodles", "p-102"), ing("peanuts", "p-101", true)], "noodles", ["peanuts"]);
    expect(isMealAllowed(dbMeal, allergic("peanuts"), products).allowed).toBe(true);
    // Without the map the ids can't be resolved, so the declared flag stands.
    expect(isMealAllowed(dbMeal, allergic("peanuts")).allowed).toBe(false);
  });
});

// ─── Diets ──────────────────────────────────────────────────────────────────

describe("isMealAllowed — diets", () => {
  it("explains each diet conflict", () => {
    expect(isMealAllowed(meal("beef-tacos"), onDiet("vegetarian")).reason).toBe("Not vegetarian");
    expect(isMealAllowed(meal("shakshuka"), onDiet("vegan")).reason).toBe("Not vegan");
    expect(isMealAllowed(meal("chicken-curry"), onDiet("pescatarian")).reason).toBe("Not pescatarian");
    expect(isMealAllowed(meal("spaghetti-bolognese"), onDiet("gluten_free")).reason).toBe("Not gluten free");
    expect(isMealAllowed(meal("butter-chicken"), onDiet("dairy_free")).reason).toBe("Not dairy free");
    expect(isMealAllowed(meal("chicken-and-chorizo-paella"), onDiet("halal")).reason).toBe("Not halal");
    expect(isMealAllowed(meal("bangers-and-mash"), onDiet("no_pork")).reason).toBe("Contains pork");
    expect(isMealAllowed(meal("lamb-keema-with-peas"), onDiet("no_red_meat")).reason).toBe("Contains red meat");
  });

  it("keeps meals that suit the diet", () => {
    expect(isMealAllowed(meal("red-lentil-dal"), onDiet("vegan")).allowed).toBe(true);
    expect(isMealAllowed(meal("baked-fish-with-cherry-tomatoes-and-olives"), onDiet("pescatarian")).allowed).toBe(true);
    expect(isMealAllowed(meal("chicken-curry"), onDiet("no_red_meat", "no_pork")).allowed).toBe(true);
  });

  it("treats fish sauce as fish for vegetarians", () => {
    expect(isMealAllowed(meal("lemongrass-chicken-rice-bowls"), onDiet("pescatarian")).reason).toBe("Not pescatarian");
    expect(isMealAllowed(meal("thai-green-chicken-curry"), onDiet("vegetarian")).reason).toBe("Not vegetarian");
  });

  it("agrees with the recipe library's own diet facts for every recipe and diet", () => {
    for (const recipe of RECIPES) {
      for (const diet of DIETS) {
        expect(isMealAllowed(meal(recipe.slug), onDiet(diet)).allowed, `${recipe.slug} / ${diet}`).toBe(isRecipeCompatibleWithDiet(recipe, diet));
      }
    }
  });

  it("drops optional ingredients that break the diet instead of the whole meal", () => {
    const tacoNight = customMeal(
      "Bean tacos",
      [ing("black beans", "black-beans"), ing("corn tortillas", "corn-tortillas"), ing("sour cream", "sour-cream", true)],
      "black beans",
    );
    expect(isMealAllowed(tacoNight, onDiet("vegan")).allowed).toBe(true);
    expect(ingredientsToOmit(tacoNight, onDiet("vegan"))).toEqual([{ name: "sour cream", productId: "sour-cream", reason: "Not vegan" }]);
  });
});

// ─── Dislikes ───────────────────────────────────────────────────────────────

describe("isMealAllowed — dislikes", () => {
  it("matches whole words in singular form", () => {
    expect(isMealAllowed(meal("mushroom-risotto"), dislikes("mushroom"))).toEqual({ allowed: false, reason: "Contains mushroom, which you don't like" });
    expect(isMealAllowed(meal("pork-san-choy-bow"), dislikes("Mushrooms")).reason).toBe("Contains mushrooms, which you don't like");
    const buttonMushrooms = customMeal("Mushroom toast", [ing("button mushrooms", null), ing("sourdough", "sourdough")], "bread");
    expect(isMealAllowed(buttonMushrooms, dislikes("mushroom")).allowed).toBe(false);
  });

  it("never confuses eggplant with egg", () => {
    expect(isMealAllowed(meal("miso-glazed-eggplant-and-tofu"), dislikes("egg")).allowed).toBe(true);
    expect(isMealAllowed(meal("ratatouille"), dislikes("eggs")).allowed).toBe(true);
    expect(isMealAllowed(meal("shakshuka"), dislikes("egg")).allowed).toBe(false);
    expect(isMealAllowed(meal("ratatouille"), dislikes("eggplant")).reason).toBe("Contains eggplant, which you don't like");
  });

  it("understands UK and US names for Australian ingredients", () => {
    expect(isMealAllowed(meal("ratatouille"), dislikes("aubergine")).allowed).toBe(false);
    expect(isMealAllowed(meal("korean-zucchini-pancakes"), dislikes("courgettes")).allowed).toBe(false);
    expect(isMealAllowed(meal("chicken-curry"), dislikes("cilantro")).allowed).toBe(false);
    expect(isMealAllowed(meal("chicken-fajitas"), dislikes("bell peppers")).allowed).toBe(false);
    expect(isMealAllowed(meal("garlic-prawns"), dislikes("shrimp")).allowed).toBe(false);
  });

  it("checks the main ingredient as well as the ingredient list", () => {
    expect(isMealAllowed(meal("teriyaki-salmon-with-greens"), dislikes("salmon")).allowed).toBe(false);
    // An umbrella word covers the fish people actually mean.
    expect(isMealAllowed(meal("teriyaki-salmon-with-greens"), dislikes("fish")).allowed).toBe(false);
    expect(isMealAllowed(meal("prawn-tacos-with-lime-slaw"), dislikes("seafood")).allowed).toBe(false);
  });

  it("doesn't treat a flavouring made from a food as the food itself", () => {
    // Fish sauce seasons the curry; there's no fish in it.
    expect(isMealAllowed(meal("thai-green-chicken-curry"), dislikes("fish")).allowed).toBe(true);
    // Chicken stock in a lamb roast isn't chicken.
    expect(isMealAllowed(meal("greek-roast-lamb-with-lemon-potatoes"), dislikes("chicken")).allowed).toBe(true);
  });

  it("tells the herb from the spice for coriander", () => {
    // Ground coriander seed only.
    expect(isMealAllowed(meal("lamb-kofta-with-herbed-couscous"), dislikes("coriander")).allowed).toBe(true);
    // Fresh coriander is a required ingredient.
    expect(isMealAllowed(meal("chicken-curry"), dislikes("coriander")).reason).toBe("Contains coriander, which you don't like");
  });

  it("leaves out an optional disliked ingredient rather than ruling out the meal", () => {
    const butterChicken = meal("butter-chicken");
    expect(isMealAllowed(butterChicken, dislikes("coriander")).allowed).toBe(true);
    const omitted = ingredientsToOmit(butterChicken, dislikes("coriander"));
    expect(omitted).toEqual([{ name: "coriander", productId: "coriander", reason: "You don't like coriander" }]);
    const trimmed = withoutOmittedIngredients(butterChicken, omitted);
    expect(trimmed.ingredients.map((i) => i.name)).not.toContain("coriander");
    expect(trimmed.ingredients).toHaveLength(butterChicken.ingredients.length - 1);
  });

  it("ignores blank dislikes", () => {
    expect(isMealAllowed(meal("mushroom-risotto"), dislikes("", "   ")).allowed).toBe(true);
  });
});

describe("ingredientsToOmit", () => {
  it("lists every conflicting optional ingredient in recipe order with its reason", () => {
    const household: DietPreferences = { allergies: ["peanuts"], diets: [], dislikedIngredients: ["chilli"] };
    expect(ingredientsToOmit(NOODLE_BOWL, household)).toEqual([
      { name: "crushed peanuts", productId: "peanuts", reason: "Contains peanuts" },
      { name: "long red chilli", productId: "chilli", reason: "You don't like chilli" },
    ]);
  });

  it("is empty when nothing needs leaving out", () => {
    expect(ingredientsToOmit(meal("thai-green-chicken-curry"), prefs())).toEqual([]);
    expect(ingredientsToOmit(meal("prawn-pad-thai"), allergic("shellfish"))).toEqual([]);
  });

  it("never lists required ingredients", () => {
    expect(ingredientsToOmit(meal("chicken-curry"), dislikes("chilli"))).toEqual([{ name: "long green chilli", productId: "chilli", reason: "You don't like chilli" }]);
    // …but the required chilli powder still rules the curry out.
    expect(isMealAllowed(meal("chicken-curry"), dislikes("chilli")).allowed).toBe(false);
  });
});

describe("nameMatchesDislike", () => {
  it.each([
    ["Button mushrooms", "mushroom", true],
    ["eggplant", "egg", false],
    ["free range eggs", "egg", true],
    ["egg noodles", "egg", false],
    ["full cream milk", "milk", true],
    ["coconut milk", "milk", false],
    ["coconut milk", "coconut milk", true],
    ["peanut butter", "peanuts", true],
    ["peanut butter", "butter", false],
    ["butter beans", "butter", false],
    ["spring onions", "scallions", true],
    ["coriander", "cilantro", true],
    ["ground coriander", "coriander", false],
    ["ground coriander", "ground coriander", true],
    ["salmon fillets", "fish", true],
    ["fish sauce", "fish", false],
    ["fish sauce", "fish sauce", true],
    ["raw king prawns", "seafood", true],
    ["chicken thigh fillets", "chicken", true],
    ["chicken stock", "chicken", false],
    ["blue cheese", "blue cheese", true],
    ["cheddar cheese", "blue cheese", false],
  ])("%s vs dislike %s → %s", (name, dislike, expected) => {
    expect(nameMatchesDislike(name, dislike)).toBe(expected);
  });
});
