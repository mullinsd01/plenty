/**
 * Plenty's built-in recipe library and the deterministic lookups built on it.
 *
 * Diet and allergen facts are derived, never hand-labelled: a recipe contains
 * whatever its catalog ingredients contain, so the catalog stays the single
 * source of truth for what is in a dish.
 */

import { getCatalogProduct } from "@/lib/catalog";
import { CONTAINS_FLAGS, DIET_EXCLUDES, DIETS, type ContainsFlag, type Diet } from "@/lib/domain";
import { RECIPES } from "@/lib/recipes/library";
import type { Recipe } from "@/lib/recipes/types";

export { RECIPES } from "@/lib/recipes/library";
export type { Recipe, RecipeIngredient } from "@/lib/recipes/types";

// ─── Tags ───────────────────────────────────────────────────────────────────

/** The descriptive tags library recipes may carry. */
export const RECIPE_TAGS = [
  "quick",
  "kid_friendly",
  "one_pot",
  "freezer_friendly",
  "comfort",
  "light",
  "weekend",
  "pantry",
  "budget",
  "spicy",
] as const;
export type RecipeTag = (typeof RECIPE_TAGS)[number];

export const RECIPE_TAG_LABELS: Record<RecipeTag, string> = {
  quick: "Quick",
  kid_friendly: "Kid friendly",
  one_pot: "One pot",
  freezer_friendly: "Freezes well",
  comfort: "Comfort food",
  light: "Light",
  weekend: "Weekend cook",
  pantry: "From the pantry",
  budget: "Budget",
  spicy: "Spicy",
};

/** Recipes ready in this many minutes or fewer carry the "quick" tag. */
export const QUICK_MAX_MINUTES = 30;

/** Recipes taking at least this many minutes carry the "weekend" tag. */
export const WEEKEND_MIN_MINUTES = 60;

/** Whether `value` is one of the library's recipe tags. */
export function isRecipeTag(value: unknown): value is RecipeTag {
  return typeof value === "string" && (RECIPE_TAGS as readonly string[]).includes(value);
}

// ─── Lookups ────────────────────────────────────────────────────────────────

/** Every library recipe keyed by slug. */
export const RECIPES_BY_SLUG: ReadonlyMap<string, Recipe> = new Map(RECIPES.map((recipe) => [recipe.slug, recipe]));

/** The library recipe with this slug, or undefined. */
export function getRecipe(slug: string): Recipe | undefined {
  return RECIPES_BY_SLUG.get(slug);
}

// ─── Diet and allergens ─────────────────────────────────────────────────────

/**
 * Everything a recipe contains: the union of the catalog `contains` flags of
 * its ingredients, in `CONTAINS_FLAGS` order.
 *
 * Optional ingredients count too, so allergen answers stay conservative (the
 * library guarantees optional extras never add a flag the dish doesn't
 * already carry). Free-text ingredients and slugs missing from the catalog
 * contribute nothing.
 */
export function recipeContains(recipe: Pick<Recipe, "ingredients">): ContainsFlag[] {
  const flags = new Set<ContainsFlag>();
  for (const ingredient of recipe.ingredients) {
    if (!ingredient.product) continue;
    for (const flag of getCatalogProduct(ingredient.product)?.contains ?? []) flags.add(flag);
  }
  return CONTAINS_FLAGS.filter((flag) => flags.has(flag));
}

/** True when nothing the recipe contains is excluded by `diet` (per `DIET_EXCLUDES`). */
export function isRecipeCompatibleWithDiet(recipe: Pick<Recipe, "ingredients">, diet: Diet): boolean {
  const contains = new Set(recipeContains(recipe));
  return !DIET_EXCLUDES[diet].some((flag) => contains.has(flag));
}

/** Every diet the recipe suits, in `DIETS` order (e.g. ["vegetarian", "pescatarian", "halal", …]). */
export function recipeDiets(recipe: Pick<Recipe, "ingredients">): Diet[] {
  const contains = new Set(recipeContains(recipe));
  return DIETS.filter((diet) => !DIET_EXCLUDES[diet].some((flag) => contains.has(flag)));
}
