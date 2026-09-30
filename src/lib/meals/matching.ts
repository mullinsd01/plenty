/**
 * Ingredient ↔ inventory matching.
 *
 * Decides which kitchen lots can satisfy a recipe ingredient, how much of the
 * need they cover, and whether an ingredient can simply be assumed (salt,
 * water). Matching is by catalog product first — the same product is an exact
 * match, another member of its substitution group ("milk", "chicken") is a
 * substitute — and falls back to comparing normalised names when either side
 * is free text.
 *
 * Name matching is deliberately conservative: a false "you have this" leaves
 * the household short on the night, which is worse than one extra item on the
 * list. Two names match only when their head nouns agree and every word that
 * differs is a harmless descriptor ("baby spinach" ↔ "spinach", "red onion" ↔
 * "brown onion"), never one that changes what the thing is ("coconut milk",
 * "sweet potato", "chicken stock").
 *
 * Pure and deterministic.
 */

import type { ProductInfo } from "@/lib/catalog/types";
import { daysBetweenDates } from "@/lib/dates";
import type { ContainsFlag } from "@/lib/domain";
import type { IngredientAvailability, IngredientStatus, InventoryLot, MealIngredientInput, PlannableMeal } from "@/lib/meals/types";
import { normalizeText, singularize } from "@/lib/normalize";
import { convert, type ProductUnitInfo, type Unit } from "@/lib/units";

// ─── Thresholds ─────────────────────────────────────────────────────────────

/** Lots at or below this fraction remaining are treated as finished. */
export const MIN_USABLE_FRACTION = 0.02;
/** Covering at least this share of an ingredient's need counts as having it. */
export const HAVE_COVERAGE_RATIO = 0.75;
/** A lot expiring within this many days of the meal date should be used soon. */
export const USE_SOON_DAYS = 3;
/** Amounts below this are float noise, not food. */
const EPSILON = 1e-9;
/** Quantities are reported to this many decimal places. */
const QUANTITY_DECIMALS = 3;

// ─── Units ──────────────────────────────────────────────────────────────────

/** Conversion knowledge for a product, in the shape `convert()` expects. */
export function productUnitInfo(product: ProductInfo | null | undefined): ProductUnitInfo | null {
  if (!product) return null;
  return {
    unit: product.unit,
    eachWeightG: product.eachWeightG ?? null,
    eachVolumeMl: product.eachVolumeMl ?? null,
    densityGPerMl: product.densityGPerMl ?? null,
  };
}

/**
 * Units that are a portion of a whole ("3 cloves" of a garlic bulb, "2 slices"
 * of a loaf). `convert()` would treat them 1:1 with other counts and weigh
 * them with the whole item's `eachWeightG`, so they only convert when the
 * product itself is tracked in that portion unit.
 */
const PORTION_UNITS: ReadonlySet<Unit> = new Set<Unit>(["clove", "slice"]);

/**
 * Convert an amount of a product between units. Beyond `convert()`, a "pack"
 * of a product tracked in some other unit is one catalog package (1 pack of
 * beef mince = 500 g), and portion units (clove, slice) never convert unless
 * the product is tracked in them. Returns null when not convertible.
 */
export function convertForProduct(amount: number, from: Unit, to: Unit, product?: ProductInfo | null): number | null {
  if (from === to) return amount;
  const portion = PORTION_UNITS.has(from) ? from : PORTION_UNITS.has(to) ? to : null;
  if (portion !== null && product?.unit !== portion) return null;
  if (product && product.unit !== "pack" && product.packageQuantity > 0) {
    if (from === "pack") return convertForProduct(amount * product.packageQuantity, product.unit, to, product);
    if (to === "pack") {
      const inProductUnit = convert(amount, from, product.unit, productUnitInfo(product));
      return inProductUnit === null ? null : inProductUnit / product.packageQuantity;
    }
  }
  return convert(amount, from, to, productUnitInfo(product));
}

/** Round away float noise for reporting (3 decimal places). */
export function roundQuantity(value: number): number {
  const factor = 10 ** QUANTITY_DECIMALS;
  return Math.round(value * factor) / factor;
}

function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}

/**
 * Amount left in a lot (quantity × remaining fraction), expressed in
 * `targetUnit` using the lot's product knowledge. Null when the lot's unit
 * can't be converted to `targetUnit` (e.g. grams of paste vs tablespoons with
 * no known density).
 */
export function lotRemaining(lot: InventoryLot, targetUnit: Unit, product?: ProductInfo | null): number | null {
  const amount = Math.max(0, lot.quantity) * clampFraction(lot.remainingFraction);
  return convertForProduct(amount, lot.unit, targetUnit, product);
}

// ─── Name matching ──────────────────────────────────────────────────────────

/**
 * Regional synonyms rewritten to Plenty's Australian vocabulary, applied to
 * singularised text so "cilantro" finds coriander and "ground beef" finds mince.
 */
const SYNONYM_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfull cream\b/g, "full"],
  [/\bwhole milk\b/g, "full milk"],
  // "bell capsicum" is "bell peppers" after the plural rewrite.
  [/\bbell (?:pepper|capsicum)\b/g, "capsicum"],
  [/\baubergine\b/g, "eggplant"],
  [/\bcourgette\b/g, "zucchini"],
  [/\bcilantro\b/g, "coriander"],
  [/\bscallion\b/g, "spring onion"],
  [/\bgreen onion\b/g, "spring onion"],
  [/\barugula\b/g, "rocket"],
  [/\bshrimp\b/g, "prawn"],
  [/\bground (beef|pork|chicken|lamb|turkey)\b/g, "$1 mince"],
  [/\bminced (beef|pork|chicken|lamb|turkey)\b/g, "$1 mince"],
  [/\byogurt\b/g, "yoghurt"],
  [/\bchili\b/g, "chilli"],
  [/\bgarbanzo\b/g, "chickpea"],
  [/\bcornstarch\b/g, "cornflour"],
  [/\ball purpose flour\b/g, "plain flour"],
  [/\bmangetout\b/g, "snow pea"],
];

/**
 * Plurals that name something other than their singular: "peppers" are
 * capsicums (UK, US, NZ), while "pepper" alone is the seasoning.
 */
const PLURAL_SYNONYMS: Readonly<Record<string, string>> = { peppers: "capsicum" };

/** Singular form of one lower-case ingredient word, reading plurals like "peppers" (capsicum) by what they name. */
export function singularIngredientWord(word: string): string {
  return PLURAL_SYNONYMS[word] ?? singularize(word);
}

/** Filler words that carry no identity. */
const STOP_WORDS = new Set(["a", "an", "and", "of", "or", "the", "for", "to", "with", "in", "on", "taste", "serve", "serving", "optional", "some", "plus"]);

/** How an ingredient is portioned, not what it is ("garlic cloves", "chicken thigh fillets"). */
const FORM_WORDS = new Set([
  "fillet",
  "clove",
  "bulb",
  "leaf",
  "sprig",
  "stalk",
  "stick",
  "head",
  "bunch",
  "piece",
  "floret",
  "chunk",
  "wedge",
  "pack",
  "packet",
  "punnet",
  "bag",
  "tin",
  "can",
  "jar",
  "bottle",
  "tub",
  "carton",
  "box",
]);

/**
 * Words that describe a variety, size, colour, fat level or preparation
 * without changing what the product is. Two names that differ only in these
 * still match. Anything not listed ("coconut", "sweet", "spring", "ground",
 * "chicken") is treated as identity-changing. Singular forms.
 */
const DESCRIPTOR_WORDS = new Set([
  // Size, quality, provenance
  "baby",
  "fresh",
  "organic",
  "large",
  "small",
  "medium",
  "big",
  "jumbo",
  "mini",
  "long",
  "short",
  "whole",
  "free",
  "range",
  "cage",
  "barn",
  "laid",
  "raw",
  "frozen",
  "chilled",
  "loose",
  "premium",
  "select",
  "australian",
  "local",
  "value",
  "family",
  "classic",
  "original",
  "regular",
  "everyday",
  // Colour
  "red",
  "green",
  "yellow",
  "brown",
  "white",
  "purple",
  "black",
  // Produce varieties
  "cherry",
  "roma",
  "truss",
  "heirloom",
  "vine",
  "english",
  "continental",
  "lebanese",
  "cos",
  "iceberg",
  "butternut",
  "kent",
  "jap",
  "royal",
  "gala",
  "granny",
  "smith",
  "pink",
  "lady",
  "fuji",
  "cavendish",
  "desiree",
  "kipfler",
  "sebago",
  "dutch",
  "navel",
  "valencia",
  "hass",
  // Dairy
  "full",
  "lite",
  "light",
  "skim",
  "skinny",
  "trim",
  "low",
  "fat",
  "reduced",
  "lactose",
  "thickened",
  "pure",
  "double",
  "single",
  "heavy",
  "whipping",
  "natural",
  "plain",
  "greek",
  "unsalted",
  "salted",
  "tasty",
  "cheddar",
  "vintage",
  "mild",
  "sharp",
  "aged",
  // Meat and oil
  "lean",
  "extra",
  "virgin",
  "boneless",
  "skinless",
  "skin",
  "bone",
  // Preparation
  "grated",
  "shredded",
  "sliced",
  "shaved",
  "chopped",
  "finely",
  "roughly",
  "thinly",
  "trimmed",
  "halved",
  "quartered",
  "washed",
]);

interface NameShape {
  /** The noun that says what the thing is ("spinach" in "baby spinach"). */
  head: string;
  /** Every other meaningful word. */
  modifiers: ReadonlySet<string>;
}

type NameMatch = "exact" | "similar";

const SHAPE_CACHE_LIMIT = 5000;
const shapeCache = new Map<string, NameShape | null>();

function computeNameShape(name: string): NameShape | null {
  let text = normalizeText(name)
    .split(" ")
    .filter((word) => word && !/\d/.test(word))
    .map(singularIngredientWord)
    .join(" ");
  for (const [pattern, replacement] of SYNONYM_REWRITES) text = text.replace(pattern, replacement);
  const words = text.split(" ").filter((word) => word && !STOP_WORDS.has(word));
  const withoutForms = words.filter((word) => !FORM_WORDS.has(word));
  const tokens = withoutForms.length > 0 ? withoutForms : words;
  if (tokens.length === 0) return null;
  let headIndex = tokens.length - 1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!DESCRIPTOR_WORDS.has(tokens[i])) {
      headIndex = i;
      break;
    }
  }
  const head = tokens[headIndex];
  const modifiers = new Set(tokens.filter((token, i) => i !== headIndex && token !== head));
  return { head, modifiers };
}

/** Head noun and modifiers of a product or ingredient name (memoised). */
function nameShape(name: string): NameShape | null {
  const cached = shapeCache.get(name);
  if (cached !== undefined) return cached;
  const shape = computeNameShape(name);
  if (shapeCache.size >= SHAPE_CACHE_LIMIT) shapeCache.clear();
  shapeCache.set(name, shape);
  return shape;
}

/** Colour descriptors (see DESCRIPTOR_WORDS). */
const COLOUR_WORDS: ReadonlySet<string> = new Set(["red", "green", "yellow", "brown", "white", "purple", "black"]);

/**
 * Head nouns whose colour says what the thing is: green beans are a
 * vegetable, black beans a legume; black pepper is a spice, red pepper a
 * capsicum; green and black tea differ. Two names with different colours on
 * these never match.
 */
const COLOUR_IS_IDENTITY_HEADS: ReadonlySet<string> = new Set(["bean", "pepper", "peppercorn", "tea"]);

function compareShapes(a: NameShape, b: NameShape): NameMatch | null {
  if (a.head !== b.head) return null;
  const onlyA = [...a.modifiers].filter((m) => !b.modifiers.has(m));
  const onlyB = [...b.modifiers].filter((m) => !a.modifiers.has(m));
  if ([...onlyA, ...onlyB].some((m) => !DESCRIPTOR_WORDS.has(m))) return null;
  if (COLOUR_IS_IDENTITY_HEADS.has(a.head) && onlyA.some((m) => COLOUR_WORDS.has(m)) && onlyB.some((m) => COLOUR_WORDS.has(m))) return null;
  // One name is a plainer form of the other ("spinach" / "baby spinach"): same thing.
  if (onlyA.length === 0 || onlyB.length === 0) return "exact";
  // Both carry their own descriptors ("red onion" / "brown onion"): interchangeable.
  return "similar";
}

/**
 * Compare two free-text names. "exact" when one is the same thing or a
 * plainer form of the other ("spinach" ↔ "baby spinach"); "similar" when they
 * are sibling varieties ("red onion" ↔ "brown onion"); null otherwise
 * ("chicken stock" ↔ "chicken breast", "tomato paste" ↔ "tomatoes", and
 * colours that change the food: "green beans" ↔ "black beans").
 */
export function matchNames(a: string, b: string): NameMatch | null {
  const shapeA = nameShape(a);
  const shapeB = nameShape(b);
  if (!shapeA || !shapeB) return null;
  return compareShapes(shapeA, shapeB);
}

function bestNameMatch(left: readonly string[], right: readonly string[]): NameMatch | null {
  let best: NameMatch | null = null;
  for (const a of left) {
    for (const b of right) {
      const match = matchNames(a, b);
      if (match === "exact") return match;
      if (match === "similar") best = match;
    }
  }
  return best;
}

// ─── Assumed basics ─────────────────────────────────────────────────────────

/** Free-text ingredients every kitchen has (compared after normalising and singularising). */
const ASSUMED_NAMES = new Set([
  "water",
  "cold water",
  "boiling water",
  "hot water",
  "warm water",
  "iced water",
  "tap water",
  "salt",
  "sea salt",
  "table salt",
  "kosher salt",
  "flaky salt",
  "salt flake",
  "sea salt flake",
  "cooking salt",
  "fine salt",
  "rock salt",
  "pepper",
  "black pepper",
  "white pepper",
  "cracked pepper",
  "cracked black pepper",
  "ground pepper",
  "ground black pepper",
  "ground white pepper",
  "freshly ground pepper",
  "freshly ground black pepper",
  "freshly cracked black pepper",
  "salt and pepper",
  "salt and black pepper",
  "sea salt and black pepper",
  "ice",
  "ice cube",
  "crushed ice",
]);

function assumedNameKey(name: string): string {
  return normalizeText(name)
    .split(" ")
    .filter(Boolean)
    .map(singularize)
    .join(" ");
}

/**
 * Whether an ingredient can be assumed to be in any kitchen without checking
 * inventory: catalog pantry basics (salt, pepper, water) and the free-text
 * equivalents ("cracked black pepper", "ice cubes"). "Red pepper", "ice
 * cream" and "coconut water" are real purchases and are not assumed.
 */
export function isAssumedAvailable(
  ingredient: Pick<MealIngredientInput, "name" | "productId">,
  product?: ProductInfo | null,
): boolean {
  if (product?.pantryBasic) return true;
  return ASSUMED_NAMES.has(assumedNameKey(ingredient.name));
}

// ─── Lot matching ───────────────────────────────────────────────────────────

export interface MatchingLots {
  /** Lots of the same product (or, for free text, the same thing by name), soonest expiry first. */
  exact: InventoryLot[];
  /** Interchangeable lots: same substitution group, or a sibling variety by name. Soonest expiry first. */
  substitutes: InventoryLot[];
}

type LotMatchKind = "exact" | "substitute";

function lookupProduct(products: ReadonlyMap<string, ProductInfo>, productId: string | null): ProductInfo | null {
  return productId ? products.get(productId) ?? null : null;
}

function candidateNames(name: string, product: ProductInfo | null): string[] {
  return product && product.name !== name ? [name, product.name] : [name];
}

function classifyLot(
  ingredient: Pick<MealIngredientInput, "name" | "productId">,
  ingredientProduct: ProductInfo | null,
  lot: InventoryLot,
  lotProduct: ProductInfo | null,
): LotMatchKind | null {
  if (lotProduct?.nonFood) return null;
  if (ingredient.productId && lot.productId) {
    if (ingredient.productId === lot.productId) return "exact";
    const group = ingredientProduct?.group ?? null;
    return group && lotProduct?.group === group ? "substitute" : null;
  }
  const match = bestNameMatch(candidateNames(ingredient.name, ingredientProduct), candidateNames(lot.name, lotProduct));
  if (match === "exact") return "exact";
  return match === "similar" ? "substitute" : null;
}

/** Soonest expiry first; lots without an expiry last; otherwise input order. */
function byExpiry(lots: readonly InventoryLot[]): InventoryLot[] {
  return lots
    .map((lot, index) => ({ lot, index }))
    .sort((a, b) => {
      const ea = a.lot.expiresOn;
      const eb = b.lot.expiresOn;
      if (ea !== eb) {
        if (ea === null) return 1;
        if (eb === null) return -1;
        return ea < eb ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.lot);
}

/**
 * Inventory lots that could satisfy an ingredient.
 *
 * `exact`: the same productId. `substitutes`: lots whose product shares the
 * ingredient product's (non-null) substitution group. When either side has no
 * productId, names are compared instead (normalised, singular, head noun must
 * agree — see `matchNames`). Finished lots (≤ 2% left) and non-food products
 * never match. Each list is ordered soonest-expiring first.
 */
export function findMatchingLots(
  ingredient: Pick<MealIngredientInput, "name" | "productId">,
  lots: readonly InventoryLot[],
  products: ReadonlyMap<string, ProductInfo>,
): MatchingLots {
  const ingredientProduct = lookupProduct(products, ingredient.productId);
  const exact: InventoryLot[] = [];
  const substitutes: InventoryLot[] = [];
  for (const lot of lots) {
    if (!(lot.remainingFraction > MIN_USABLE_FRACTION) || !(lot.quantity > 0)) continue;
    const kind = classifyLot(ingredient, ingredientProduct, lot, lookupProduct(products, lot.productId));
    if (kind === "exact") exact.push(lot);
    else if (kind === "substitute") substitutes.push(lot);
  }
  return { exact: byExpiry(exact), substitutes: byExpiry(substitutes) };
}

// ─── Allocation ─────────────────────────────────────────────────────────────

/**
 * Working fraction remaining per lot id while meals claim inventory. Lots not
 * in the map are at their original `remainingFraction`.
 */
export type LotBalances = Map<string, number>;

export interface AllocationOptions {
  /** Servings being cooked; quantities scale by servings / meal.servings. */
  servings: number;
  /** Meal date, YYYY-MM-DD. Lots that expire before it are not used. */
  date: string;
}

/** One ingredient after allocation: what the UI shows, plus what's left to buy. */
export interface IngredientAllocation {
  ingredient: MealIngredientInput;
  product: ProductInfo | null;
  availability: IngredientAvailability;
  /** True when this ingredient should generate a shopping line (required, not assumed, short). */
  needsPurchase: boolean;
  /** Amount still needed in `availability.unit`; null when the quantity is unknown. */
  shortfallQuantity: number | null;
}

interface CandidateLot {
  lot: InventoryLot;
  product: ProductInfo | null;
  substitute: boolean;
}

function withBalance(lot: InventoryLot, balances: LotBalances): InventoryLot {
  const balance = balances.get(lot.id);
  return balance === undefined ? lot : { ...lot, remainingFraction: balance };
}

function expiresSoon(lot: InventoryLot, date: string): boolean {
  return lot.expiresOn !== null && daysBetweenDates(date, lot.expiresOn) <= USE_SOON_DAYS;
}

/**
 * What a meal's required ingredients contain, from their catalog products.
 * A stand-in may only bring in these flags: chicken stock can't quietly
 * replace vegetable stock in a vegetarian risotto, or wheat wraps the corn
 * tortillas in a gluten-free taco night. Free-text ingredients add nothing,
 * which only makes stand-ins rarer.
 */
function requiredFlags(meal: PlannableMeal, products: ReadonlyMap<string, ProductInfo>): ReadonlySet<ContainsFlag> {
  const flags = new Set<ContainsFlag>();
  for (const ingredient of meal.ingredients) {
    if (ingredient.optional) continue;
    for (const flag of lookupProduct(products, ingredient.productId)?.contains ?? []) flags.add(flag);
  }
  return flags;
}

/** Whether a lot can stand in without adding a flag the meal doesn't already carry. Its own product always can. */
function addsNoNewFlags(ingredient: MealIngredientInput, lot: InventoryLot, lotProduct: ProductInfo | null, allowed: ReadonlySet<ContainsFlag>): boolean {
  if (lot.productId !== null && lot.productId === ingredient.productId) return true;
  return (lotProduct?.contains ?? []).every((flag) => allowed.has(flag));
}

function candidateLots(
  ingredient: MealIngredientInput,
  lots: readonly InventoryLot[],
  products: ReadonlyMap<string, ProductInfo>,
  date: string,
  balances: LotBalances,
  allowedFlags: ReadonlySet<ContainsFlag>,
): CandidateLot[] {
  const usable = lots.filter((lot) => lot.expiresOn === null || lot.expiresOn >= date).map((lot) => withBalance(lot, balances));
  const { exact, substitutes } = findMatchingLots(ingredient, usable, products);
  const candidates: CandidateLot[] = [];
  const add = (substitute: boolean) => (lot: InventoryLot) => {
    const product = lookupProduct(products, lot.productId);
    if (addsNoNewFlags(ingredient, lot, product, allowedFlags)) candidates.push({ lot, product, substitute });
  };
  exact.forEach(add(false));
  substitutes.forEach(add(true));
  return candidates;
}

function scaleFor(meal: PlannableMeal, servings: number): number {
  return meal.servings > 0 && servings > 0 ? servings / meal.servings : 1;
}

function baseAvailability(ingredient: MealIngredientInput, needed: number | null, unit: Unit | null): IngredientAvailability {
  return {
    name: ingredient.name,
    productId: ingredient.productId,
    status: "missing",
    neededQuantity: needed,
    unit,
    coveredQuantity: null,
    matchedLotIds: [],
    substitute: false,
    usesSoonExpiring: false,
  };
}

function statusWhenAbsent(ingredient: MealIngredientInput): IngredientStatus {
  return ingredient.optional ? "optional_missing" : "missing";
}

/** Unquantified ingredient: any usable matching lot covers it; nothing is consumed. */
function allocateUnquantified(
  ingredient: MealIngredientInput,
  product: ProductInfo | null,
  availability: IngredientAvailability,
  candidates: readonly CandidateLot[],
  date: string,
): IngredientAllocation {
  const first = candidates[0];
  if (!first) {
    const status = statusWhenAbsent(ingredient);
    return { ingredient, product, availability: { ...availability, status }, needsPurchase: status === "missing", shortfallQuantity: null };
  }
  return {
    ingredient,
    product,
    availability: {
      ...availability,
      status: "have",
      matchedLotIds: [first.lot.id],
      substitute: first.substitute,
      usesSoonExpiring: expiresSoon(first.lot, date),
    },
    needsPurchase: false,
    shortfallQuantity: null,
  };
}

function resolveStatus(ingredient: MealIngredientInput, needed: number, covered: number, hasUnmeasured: boolean): IngredientStatus {
  const somethingThere = covered > EPSILON || hasUnmeasured;
  if (ingredient.optional) return somethingThere ? "have" : "optional_missing";
  if (covered >= needed * HAVE_COVERAGE_RATIO - EPSILON) return "have";
  // A matching lot we can't measure in the recipe's unit is trusted to be enough.
  if (hasUnmeasured) return "have";
  return covered > EPSILON ? "partial" : "missing";
}

/** Quantified ingredient: claim from candidate lots in order, reducing their balances. */
function allocateQuantified(
  ingredient: MealIngredientInput,
  product: ProductInfo | null,
  availability: IngredientAvailability,
  candidates: readonly CandidateLot[],
  needed: number,
  unit: Unit,
  date: string,
  balances: LotBalances,
): IngredientAllocation {
  let remaining = needed;
  const used: CandidateLot[] = [];
  const unmeasured: CandidateLot[] = [];
  for (const candidate of candidates) {
    if (remaining <= EPSILON) break;
    const available = lotRemaining(candidate.lot, unit, candidate.product) ?? lotRemaining(candidate.lot, unit, product);
    if (available === null) {
      unmeasured.push(candidate);
      continue;
    }
    if (available <= EPSILON) continue;
    const take = Math.min(available, remaining);
    const fraction = clampFraction(candidate.lot.remainingFraction);
    balances.set(candidate.lot.id, fraction * (1 - take / available));
    remaining -= take;
    used.push(candidate);
  }
  const covered = needed - Math.max(0, remaining);
  const status = resolveStatus(ingredient, needed, covered, unmeasured.length > 0);
  const trustedUnmeasured = status === "have" && covered < needed * HAVE_COVERAGE_RATIO - EPSILON ? unmeasured.slice(0, 1) : [];
  const contributing = [...used, ...trustedUnmeasured];
  const short = status === "partial" || status === "missing";
  return {
    ingredient,
    product,
    availability: {
      ...availability,
      status,
      coveredQuantity: roundQuantity(covered),
      matchedLotIds: contributing.map((c) => c.lot.id),
      substitute: contributing.length > 0 && contributing.every((c) => c.substitute),
      usesSoonExpiring: contributing.some((c) => expiresSoon(c.lot, date)),
    },
    needsPurchase: short,
    shortfallQuantity: short ? roundQuantity(needed - covered) : null,
  };
}

function allocateIngredient(
  ingredient: MealIngredientInput,
  scale: number,
  lots: readonly InventoryLot[],
  products: ReadonlyMap<string, ProductInfo>,
  date: string,
  balances: LotBalances,
  allowedFlags: ReadonlySet<ContainsFlag>,
): IngredientAllocation {
  const product = lookupProduct(products, ingredient.productId);
  const unit: Unit | null = ingredient.unit ?? (ingredient.quantity !== null ? "each" : null);
  const needed = ingredient.quantity !== null && ingredient.quantity > 0 ? roundQuantity(ingredient.quantity * scale) : null;
  const availability = baseAvailability(ingredient, needed, unit);
  if (isAssumedAvailable(ingredient, product)) {
    return { ingredient, product, availability: { ...availability, status: "assumed" }, needsPurchase: false, shortfallQuantity: null };
  }
  const candidates = candidateLots(ingredient, lots, products, date, balances, allowedFlags);
  if (needed === null || unit === null) return allocateUnquantified(ingredient, product, availability, candidates, date);
  return allocateQuantified(ingredient, product, availability, candidates, needed, unit, date, balances);
}

/**
 * Allocate a meal's ingredients against inventory, mutating `balances` so
 * that later calls (later meals) can't claim the same stock. Within the meal,
 * required ingredients claim lots before optional ones (so a garnish never
 * leaves the dish itself short), each group in recipe order: exact lots
 * before substitutes, soonest-expiring first, skipping lots that expire
 * before the meal date. A substitute never brings in a `contains` flag the
 * meal's required ingredients don't already carry. Results are in recipe
 * order. Lower-level than `assessMealAvailability`; used by the plan
 * requirements.
 */
export function allocateMealIngredients(
  meal: PlannableMeal,
  lots: readonly InventoryLot[],
  products: ReadonlyMap<string, ProductInfo>,
  opts: AllocationOptions,
  balances: LotBalances,
): IngredientAllocation[] {
  const required = allocateIngredientGroup(meal, "required", lots, products, opts, balances);
  const optional = allocateIngredientGroup(meal, "optional", lots, products, opts, balances);
  return mergeIngredientGroups(meal, required, optional);
}

/** Which of a meal's ingredients `allocateIngredientGroup` allocates. */
export type IngredientGroup = "required" | "optional";

/**
 * Allocate just one group of a meal's ingredients, in recipe order, keyed by
 * position in `meal.ingredients` (see `allocateMealIngredients` for the
 * rules). For callers that let every meal's required ingredients claim stock
 * before any meal's optional extras; recombine with `mergeIngredientGroups`.
 */
export function allocateIngredientGroup(
  meal: PlannableMeal,
  group: IngredientGroup,
  lots: readonly InventoryLot[],
  products: ReadonlyMap<string, ProductInfo>,
  opts: AllocationOptions,
  balances: LotBalances,
): Map<number, IngredientAllocation> {
  const scale = scaleFor(meal, opts.servings);
  const allowedFlags = requiredFlags(meal, products);
  const wantOptional = group === "optional";
  const allocations = new Map<number, IngredientAllocation>();
  meal.ingredients.forEach((ingredient, index) => {
    if (ingredient.optional !== wantOptional) return;
    allocations.set(index, allocateIngredient(ingredient, scale, lots, products, opts.date, balances, allowedFlags));
  });
  return allocations;
}

/** Required and optional allocations back in recipe order. */
export function mergeIngredientGroups(
  meal: PlannableMeal,
  required: ReadonlyMap<number, IngredientAllocation>,
  optional: ReadonlyMap<number, IngredientAllocation>,
): IngredientAllocation[] {
  return meal.ingredients.flatMap((_, index) => {
    const allocation = required.get(index) ?? optional.get(index);
    return allocation ? [allocation] : [];
  });
}

/**
 * What the kitchen can cover for one meal cooked on `opts.date` for
 * `opts.servings`. Quantities scale from the meal's base servings. Status per
 * ingredient: "assumed" (pantry basics), "have" (≥ 75% covered, or an
 * unquantified / unmeasurable need with a matching lot), "partial", "missing",
 * or "optional_missing". Optional ingredients are "have" as soon as any is
 * there, from whatever the required ones leave. Lots expiring before the meal
 * date are ignored, as are substitutes carrying a flag (meat, gluten, …) the
 * dish doesn't already contain; `usesSoonExpiring` flags lots that expire
 * within 3 days of it.
 */
export function assessMealAvailability(
  meal: PlannableMeal,
  lots: readonly InventoryLot[],
  products: ReadonlyMap<string, ProductInfo>,
  opts: AllocationOptions,
): IngredientAvailability[] {
  return allocateMealIngredients(meal, lots, products, opts, new Map()).map((a) => a.availability);
}

// ─── Summary ────────────────────────────────────────────────────────────────

export interface AvailabilitySummary {
  haveCount: number;
  /** Missing plus partial (required ingredients only). */
  missingCount: number;
  /** Have-equivalents ÷ required, non-assumed ingredients (0–1); 1 when there are none. */
  coverage: number;
  /** Names of missing and partial ingredients, in recipe order. */
  missingNames: string[];
  /** Names of ingredients that would use up soon-expiring stock. */
  useSoonNames: string[];
}

function coveredShare(item: IngredientAvailability): number {
  if (item.neededQuantity === null || item.coveredQuantity === null || item.neededQuantity <= 0) return 0;
  return clampFraction(item.coveredQuantity / item.neededQuantity);
}

/**
 * Roll a meal's ingredient availability up for cards and ranking. Partial
 * ingredients count towards coverage by the share covered. Assumed and
 * missing optional ingredients are left out of the coverage denominator.
 */
export function summarizeAvailability(ingredients: readonly IngredientAvailability[]): AvailabilitySummary {
  let haveCount = 0;
  let missingCount = 0;
  let equivalents = 0;
  let required = 0;
  const missingNames: string[] = [];
  const useSoon = new Set<string>();
  for (const item of ingredients) {
    if (item.usesSoonExpiring) useSoon.add(item.name);
    switch (item.status) {
      case "have":
        haveCount += 1;
        required += 1;
        equivalents += 1;
        break;
      case "partial":
        missingCount += 1;
        required += 1;
        equivalents += coveredShare(item);
        missingNames.push(item.name);
        break;
      case "missing":
        missingCount += 1;
        required += 1;
        missingNames.push(item.name);
        break;
      case "assumed":
      case "optional_missing":
        break;
    }
  }
  return {
    haveCount,
    missingCount,
    coverage: required === 0 ? 1 : equivalents / required,
    missingNames,
    useSoonNames: [...useSoon],
  };
}
