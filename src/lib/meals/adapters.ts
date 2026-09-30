/**
 * Adapters from Plenty's static data (recipe library, catalog) into the
 * shapes the meal engines consume.
 *
 * At runtime product ids are database ids, so callers pass a resolver from
 * catalog slug to id. Tests and seeding can use the slug itself as the id
 * (the default everywhere here).
 *
 * Pure and deterministic.
 */

import { CATALOG, productInfoFromCatalog, type ProductInfo } from "@/lib/catalog";
import { RECIPES, recipeContains, type Recipe, type RecipeIngredient } from "@/lib/recipes";
import type { MealIngredientInput, PlannableMeal } from "@/lib/meals/types";

/** Resolves a catalog slug to the product id used at runtime, or null when unknown. */
export type ProductIdResolver = (slug: string) => string | null;

/** Uses the catalog slug itself as the product id (tests, seeding, demo data). */
export const slugAsProductId: ProductIdResolver = (slug) => slug;

function toMealIngredient(ingredient: RecipeIngredient, resolveProductId: ProductIdResolver): MealIngredientInput {
  return {
    name: ingredient.name,
    productId: ingredient.product ? resolveProductId(ingredient.product) : null,
    quantity: ingredient.quantity ?? null,
    unit: ingredient.unit ?? null,
    optional: ingredient.optional ?? false,
  };
}

/**
 * A library recipe as a plannable meal. Ingredient products are mapped
 * through `resolveProductId` (unresolvable slugs become free text, still
 * matched by name); `contains` is derived from the catalog via
 * `recipeContains`, so diet and allergen facts are never hand-labelled.
 * `id` defaults to the recipe slug.
 */
export function recipeToPlannableMeal(recipe: Recipe, resolveProductId: ProductIdResolver = slugAsProductId, id: string = recipe.slug): PlannableMeal {
  return {
    id,
    slug: recipe.slug,
    name: recipe.name,
    cuisine: recipe.cuisine,
    timeMinutes: recipe.timeMinutes,
    difficulty: recipe.difficulty,
    servings: recipe.servings,
    mainIngredient: recipe.mainIngredient,
    tags: [...recipe.tags],
    contains: recipeContains(recipe),
    ingredients: recipe.ingredients.map((ingredient) => toMealIngredient(ingredient, resolveProductId)),
    source: "library",
  };
}

/**
 * Every library recipe as a plannable meal, in library order, with ids equal
 * to slugs. Convenient for tests, seeding and the demo household.
 */
export function libraryPlannableMeals(resolveProductId: ProductIdResolver = slugAsProductId): PlannableMeal[] {
  return RECIPES.map((recipe) => recipeToPlannableMeal(recipe, resolveProductId));
}

/**
 * Runtime product knowledge for the whole catalog, keyed by product id.
 * `ids` maps a slug to its id (default: the slug), so the map lines up with
 * meals built by `recipeToPlannableMeal` using the same mapping.
 */
export function catalogProductMap(ids: (slug: string) => string = (slug) => slug): ReadonlyMap<string, ProductInfo> {
  const map = new Map<string, ProductInfo>();
  for (const product of CATALOG) {
    const id = ids(product.slug);
    map.set(id, productInfoFromCatalog(product, id));
  }
  return map;
}

let slugKeyedCatalog: ReadonlyMap<string, ProductInfo> | null = null;

/** The catalog keyed by slug, built once on first use. */
export function slugKeyedCatalogProducts(): ReadonlyMap<string, ProductInfo> {
  slugKeyedCatalog ??= catalogProductMap();
  return slugKeyedCatalog;
}
