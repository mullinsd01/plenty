/**
 * Diet, allergy and dislike filtering for meals.
 *
 * Allergies and diets are decided from `contains` flags, which come from the
 * catalog — never guessed from names. A flag carried only by optional
 * ingredients doesn't rule a meal out: those ingredients are left out
 * instead (`ingredientsToOmit`). When Plenty can't tell which ingredient a
 * flag comes from, the flag counts, so an unknown can only make filtering
 * stricter, never looser.
 *
 * Dislikes are personal and free text ("mushrooms", "coriander"), so they
 * are matched against ingredient names by whole, singular words: "mushroom"
 * finds "button mushrooms", "egg" does not find "eggplant". Flavourings made
 * from a disliked food ("fish sauce", "chicken stock") and a few compounds
 * that are a different thing altogether ("coconut milk", "ground coriander")
 * don't count.
 *
 * Pure and deterministic.
 */

import type { ProductInfo } from "@/lib/catalog/types";
import { ALLERGEN_LABELS, CONTAINS_FLAGS, DIET_EXCLUDES, type Allergen, type ContainsFlag, type Diet } from "@/lib/domain";
import { slugKeyedCatalogProducts } from "@/lib/meals/adapters";
import { isAssumedAvailable, singularIngredientWord } from "@/lib/meals/matching";
import type { MealIngredientInput, PlannableMeal, PlannerPreferences } from "@/lib/meals/types";
import { normalizeText } from "@/lib/normalize";

export type DietPreferences = Pick<PlannerPreferences, "diets" | "allergies" | "dislikedIngredients">;

export interface MealAllowance {
  allowed: boolean;
  /** Why not, in plain language ("Contains peanuts", "Not vegetarian"); null when allowed. */
  reason: string | null;
}

export interface OmittedIngredient {
  name: string;
  productId: string | null;
  /** Why to leave it out ("Contains peanuts", "Not vegan", "You don't like chilli"). */
  reason: string;
}

/** How a diet conflict reads on a card. */
export const DIET_CONFLICT_REASONS: Record<Diet, string> = {
  vegetarian: "Not vegetarian",
  vegan: "Not vegan",
  pescatarian: "Not pescatarian",
  gluten_free: "Not gluten free",
  dairy_free: "Not dairy free",
  halal: "Not halal",
  no_pork: "Contains pork",
  no_red_meat: "Contains red meat",
};

// ─── Dislike vocabulary ─────────────────────────────────────────────────────

/** Regional names rewritten to Plenty's Australian vocabulary (applied to singular text). */
const DISLIKE_SYNONYMS: ReadonlyArray<readonly [RegExp, string]> = [
  // "bell capsicum" is "bell peppers" after the plural rewrite below.
  [/\bbell (?:pepper|capsicum)\b/g, "capsicum"],
  [/\baubergine\b/g, "eggplant"],
  [/\bcourgette\b/g, "zucchini"],
  [/\bcilantro\b/g, "coriander"],
  [/\bscallion\b/g, "spring onion"],
  [/\bgreen onion\b/g, "spring onion"],
  [/\barugula\b/g, "rocket"],
  [/\bshrimp\b/g, "prawn"],
  [/\bground (beef|pork|chicken|lamb|turkey)\b/g, "$1 mince"],
  [/\byogurt\b/g, "yoghurt"],
  [/\bchili\b/g, "chilli"],
  [/\bgarbanzo\b/g, "chickpea"],
];

/**
 * Words that, straight after a disliked food, make it a flavouring rather
 * than the food itself: someone who doesn't like fish can still have a Thai
 * curry seasoned with fish sauce.
 */
const FLAVOURING_SUFFIXES: ReadonlySet<string> = new Set(["sauce", "stock", "broth"]);

/**
 * Compounds that are a different ingredient from one word inside them
 * (singular form): a dislike of milk doesn't rule out coconut milk, and a
 * dislike of the herb coriander doesn't rule out the ground seed. The
 * compound still counts for its other words ("peanut butter" is peanut).
 */
const DISTINCT_COMPOUNDS: ReadonlyArray<{ compound: readonly string[]; isNot: string }> = [
  { compound: ["coconut", "milk"], isNot: "milk" },
  { compound: ["coconut", "cream"], isNot: "cream" },
  { compound: ["ice", "cream"], isNot: "cream" },
  { compound: ["cream", "cheese"], isNot: "cream" },
  { compound: ["peanut", "butter"], isNot: "butter" },
  { compound: ["butter", "bean"], isNot: "butter" },
  { compound: ["butter", "lettuce"], isNot: "butter" },
  { compound: ["ground", "coriander"], isNot: "coriander" },
  { compound: ["coriander", "seed"], isNot: "coriander" },
  { compound: ["egg", "noodle"], isNot: "egg" },
];

const FISH_TERMS = ["salmon", "tuna", "barramundi", "snapper", "cod", "basa", "hoki", "flathead", "trout", "sardine", "anchovy", "mackerel", "white fish"];
const SHELLFISH_TERMS = ["prawn", "squid", "calamari", "mussel", "oyster", "scallop", "crab", "lobster", "clam"];

/** Umbrella dislikes that also cover the specific foods people mean by them. */
const DISLIKE_CATEGORY_TERMS: Readonly<Record<string, readonly string[]>> = {
  fish: FISH_TERMS,
  shellfish: SHELLFISH_TERMS,
  seafood: ["fish", ...FISH_TERMS, ...SHELLFISH_TERMS],
};

/** Normalised, singular word tokens with regional synonyms rewritten. */
export function dislikeTokens(text: string): string[] {
  let joined = normalizeText(text)
    .split(" ")
    .filter((word) => word && !/\d/.test(word))
    .map(singularIngredientWord)
    .join(" ");
  for (const [pattern, replacement] of DISLIKE_SYNONYMS) joined = joined.replace(pattern, replacement);
  return joined.split(" ").filter(Boolean);
}

function startsAt(haystack: readonly string[], needle: readonly string[], index: number): boolean {
  if (index < 0 || index + needle.length > haystack.length) return false;
  return needle.every((token, offset) => haystack[index + offset] === token);
}

/** True when the occurrence at [start, end) sits inside a compound that is a different ingredient from the dislike. */
function insideDistinctCompound(tokens: readonly string[], start: number, end: number, dislike: readonly string[]): boolean {
  const phrase = dislike.join(" ");
  return DISTINCT_COMPOUNDS.some(({ compound, isNot }) => {
    if (isNot !== phrase) return false;
    for (let s = Math.max(0, end - compound.length); s <= start; s++) {
      if (startsAt(tokens, compound, s)) return true;
    }
    return false;
  });
}

function isFlavouringOccurrence(tokens: readonly string[], end: number, dislike: readonly string[]): boolean {
  const next = tokens[end];
  return next !== undefined && FLAVOURING_SUFFIXES.has(next) && !dislike.includes(next);
}

/** Whether the phrase `dislike` (already tokenised) names the thing in `tokens`. */
function tokensMatchDislike(tokens: readonly string[], dislike: readonly string[]): boolean {
  if (dislike.length === 0) return false;
  for (let start = 0; start + dislike.length <= tokens.length; start++) {
    if (!startsAt(tokens, dislike, start)) continue;
    const end = start + dislike.length;
    if (isFlavouringOccurrence(tokens, end, dislike)) continue;
    if (insideDistinctCompound(tokens, start, end, dislike)) continue;
    return true;
  }
  return false;
}

/** The token phrases a dislike covers: itself plus any umbrella expansion ("seafood" → prawn, salmon…). */
function dislikePhrases(dislike: string): string[][] {
  const tokens = dislikeTokens(dislike);
  if (tokens.length === 0) return [];
  const expansion = DISLIKE_CATEGORY_TERMS[tokens.join(" ")] ?? [];
  return [tokens, ...expansion.map((term) => term.split(" "))];
}

/**
 * Whether a free-text name (ingredient, product or main ingredient) is
 * something the household said it doesn't like. Whole singular words only:
 * "mushroom" matches "Button mushrooms"; "egg" doesn't match "eggplant";
 * "fish" matches "salmon fillets" but not "fish sauce".
 */
export function nameMatchesDislike(name: string, dislike: string): boolean {
  const tokens = dislikeTokens(name);
  if (tokens.length === 0) return false;
  return dislikePhrases(dislike).some((phrase) => tokensMatchDislike(tokens, phrase));
}

function cleanDislikes(dislikes: readonly string[]): string[] {
  return dislikes.map((d) => d.trim().replace(/\s+/g, " ")).filter((d) => dislikeTokens(d).length > 0);
}

function lookupProduct(ingredient: MealIngredientInput, products: ReadonlyMap<string, ProductInfo>): ProductInfo | undefined {
  return ingredient.productId ? products.get(ingredient.productId) : undefined;
}

function ingredientNames(ingredient: MealIngredientInput, products: ReadonlyMap<string, ProductInfo>): string[] {
  const product = lookupProduct(ingredient, products);
  return product && product.name !== ingredient.name ? [ingredient.name, product.name] : [ingredient.name];
}

/** The first dislike (as the household wrote it) that `names` match, or null. */
function matchingDislike(names: readonly string[], dislikes: readonly string[]): string | null {
  for (const dislike of dislikes) {
    if (names.some((name) => nameMatchesDislike(name, dislike))) return dislike;
  }
  return null;
}

// ─── Contains flags ─────────────────────────────────────────────────────────

function productFlags(ingredient: MealIngredientInput, products: ReadonlyMap<string, ProductInfo>): readonly ContainsFlag[] {
  return ingredient.productId ? products.get(ingredient.productId)?.contains ?? [] : [];
}

/** A required ingredient whose contents Plenty can't see: free text or an unknown product, other than salt-and-water basics. */
function isUnattributable(ingredient: MealIngredientInput, products: ReadonlyMap<string, ProductInfo>): boolean {
  if (ingredient.optional) return false;
  const product = ingredient.productId ? products.get(ingredient.productId) : undefined;
  return product === undefined && !isAssumedAvailable(ingredient);
}

/**
 * The flags a meal carries once optional ingredients are left out, in
 * `CONTAINS_FLAGS` order.
 *
 * Starts from `meal.contains` plus every required ingredient's catalog flags,
 * and removes only flags traced to an optional ingredient and to no required
 * one. If any required ingredient's contents are unknown (free text, a
 * product missing from `products`), nothing is removed — an unknown can only
 * make allergy filtering stricter.
 */
export function requiredContains(
  meal: Pick<PlannableMeal, "contains" | "ingredients">,
  products: ReadonlyMap<string, ProductInfo> = slugKeyedCatalogProducts(),
): ContainsFlag[] {
  const required = new Set<ContainsFlag>();
  const fromOptional = new Set<ContainsFlag>();
  for (const ingredient of meal.ingredients) {
    for (const flag of productFlags(ingredient, products)) (ingredient.optional ? fromOptional : required).add(flag);
  }
  const canTrimOptional = !meal.ingredients.some((ingredient) => isUnattributable(ingredient, products));
  const declared = new Set(meal.contains);
  return CONTAINS_FLAGS.filter((flag) => required.has(flag) || (declared.has(flag) && !(canTrimOptional && fromOptional.has(flag))));
}

function allergenReason(allergen: Allergen): string {
  return `Contains ${ALLERGEN_LABELS[allergen].toLowerCase()}`;
}

/** The first allergy or diet conflict for a set of flags, allergies first. */
function flagConflict(flags: ReadonlySet<ContainsFlag>, prefs: DietPreferences): string | null {
  for (const allergen of prefs.allergies) {
    // Allergen values are ContainsFlag names by design.
    if (flags.has(allergen)) return allergenReason(allergen);
  }
  for (const diet of prefs.diets) {
    if (DIET_EXCLUDES[diet].some((flag) => flags.has(flag))) return DIET_CONFLICT_REASONS[diet];
  }
  return null;
}

// ─── Entry points ───────────────────────────────────────────────────────────

/**
 * Whether a meal suits the household, and if not, the first reason why:
 * allergies ("Contains peanuts"), then diets ("Not vegetarian"), then
 * dislikes ("Contains mushroom, which you don't like"). Only required
 * ingredients and the meal's main ingredient count — optional ones that
 * conflict are left out instead (see `ingredientsToOmit`) — and dislikes
 * ignore to-taste basics (salt, black pepper, water), so "peppers" doesn't
 * rule out every dish seasoned with pepper. `products` resolves ingredient
 * product ids for flag attribution; it defaults to the catalog keyed by slug.
 */
export function isMealAllowed(
  meal: PlannableMeal,
  prefs: DietPreferences,
  products: ReadonlyMap<string, ProductInfo> = slugKeyedCatalogProducts(),
): MealAllowance {
  const conflict = flagConflict(new Set(requiredContains(meal, products)), prefs);
  if (conflict) return { allowed: false, reason: conflict };

  const dislikes = cleanDislikes(prefs.dislikedIngredients);
  if (dislikes.length > 0) {
    const mainDislike = matchingDislike([meal.mainIngredient], dislikes);
    if (mainDislike) return { allowed: false, reason: dislikeReason(mainDislike) };
    for (const ingredient of meal.ingredients) {
      // To-taste seasonings (salt, black pepper, water) never define a dish: "peppers" means capsicum.
      if (ingredient.optional || isAssumedAvailable(ingredient, lookupProduct(ingredient, products))) continue;
      const dislike = matchingDislike(ingredientNames(ingredient, products), dislikes);
      if (dislike) return { allowed: false, reason: dislikeReason(dislike) };
    }
  }
  return { allowed: true, reason: null };
}

function dislikeReason(dislike: string): string {
  return `Contains ${dislike.toLowerCase()}, which you don't like`;
}

/**
 * Optional ingredients the household should leave out: those carrying an
 * allergen they avoid, a flag their diet excludes, or something they don't
 * like. In recipe order, each with a plain-language reason.
 */
export function ingredientsToOmit(
  meal: PlannableMeal,
  prefs: DietPreferences,
  products: ReadonlyMap<string, ProductInfo> = slugKeyedCatalogProducts(),
): OmittedIngredient[] {
  const dislikes = cleanDislikes(prefs.dislikedIngredients);
  const omitted: OmittedIngredient[] = [];
  for (const ingredient of meal.ingredients) {
    if (!ingredient.optional) continue;
    const conflict = flagConflict(new Set(productFlags(ingredient, products)), prefs);
    const dislike = conflict ? null : matchingDislike(ingredientNames(ingredient, products), dislikes);
    const reason = conflict ?? (dislike ? `You don't like ${dislike.toLowerCase()}` : null);
    if (reason) omitted.push({ name: ingredient.name, productId: ingredient.productId, reason });
  }
  return omitted;
}

/** The meal with the ingredients `ingredientsToOmit` lists removed (same object when nothing is left out). */
export function withoutOmittedIngredients(meal: PlannableMeal, omitted: readonly OmittedIngredient[]): PlannableMeal {
  if (omitted.length === 0) return meal;
  const names = new Set(omitted.map((o) => o.name));
  return { ...meal, ingredients: meal.ingredients.filter((i) => !(i.optional && names.has(i.name))) };
}
