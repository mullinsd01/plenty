/**
 * Shared domain vocabulary. Pure types and label maps only — safe to import
 * from both server and client code.
 */

// ─── Storage locations (inventory categories) ────────────────────────────────

export const STORAGE_LOCATIONS = [
  "fridge",
  "freezer",
  "pantry",
  "produce",
  "drinks",
  "household",
  "other",
] as const;
export type StorageLocation = (typeof STORAGE_LOCATIONS)[number];

export const STORAGE_LOCATION_LABELS: Record<StorageLocation, string> = {
  fridge: "Fridge",
  freezer: "Freezer",
  pantry: "Pantry",
  produce: "Fruit & vegetables",
  drinks: "Drinks",
  household: "Household staples",
  other: "Other",
};

// ─── Aisles (shopping-list grouping) ─────────────────────────────────────────

export const AISLES = [
  "produce",
  "dairy",
  "meat",
  "seafood",
  "bakery",
  "deli",
  "pantry",
  "frozen",
  "drinks",
  "snacks",
  "household",
  "personal_care",
  "baby",
  "pet",
  "other",
] as const;
export type Aisle = (typeof AISLES)[number];

export const AISLE_LABELS: Record<Aisle, string> = {
  produce: "Fruit & vegetables",
  dairy: "Dairy & eggs",
  meat: "Meat",
  seafood: "Seafood",
  bakery: "Bakery",
  deli: "Deli",
  pantry: "Pantry",
  frozen: "Frozen",
  drinks: "Drinks",
  snacks: "Snacks",
  household: "Household",
  personal_care: "Personal care",
  baby: "Baby",
  pet: "Pet",
  other: "Other",
};

/** Default walking order through a typical supermarket. */
export const AISLE_ORDER: Aisle[] = [
  "produce",
  "bakery",
  "deli",
  "meat",
  "seafood",
  "dairy",
  "pantry",
  "snacks",
  "frozen",
  "drinks",
  "household",
  "personal_care",
  "baby",
  "pet",
  "other",
];

// ─── Confidence ──────────────────────────────────────────────────────────────

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/**
 * `estimate`: Plenty's starting guess (catalog priors scaled to the household).
 * `history`: learned from this household's own consumption events.
 */
export const PREDICTION_BASES = ["estimate", "history"] as const;
export type PredictionBasis = (typeof PREDICTION_BASES)[number];

export const PREDICTION_BASIS_LABELS: Record<PredictionBasis, string> = {
  estimate: "Plenty estimate",
  history: "Based on your household history",
};

// ─── Inventory lifecycle ─────────────────────────────────────────────────────

export const INVENTORY_STATUSES = ["active", "finished", "wasted", "expired", "removed"] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const INVENTORY_SOURCES = ["receipt", "manual", "shopping_list", "demo"] as const;
export type InventorySource = (typeof INVENTORY_SOURCES)[number];

export const INVENTORY_EVENT_TYPES = [
  "added",
  "adjusted",
  "used",
  "finished",
  "wasted",
  "expired",
  "removed",
  "restored",
  "moved",
  "edited",
] as const;
export type InventoryEventType = (typeof INVENTORY_EVENT_TYPES)[number];

export const CONSUMPTION_OUTCOMES = ["consumed", "wasted", "expired"] as const;
export type ConsumptionOutcome = (typeof CONSUMPTION_OUTCOMES)[number];

/** Quick level presets used instead of typing quantities. */
export const LEVEL_PRESETS = [
  { key: "full", label: "Full", fraction: 1 },
  { key: "mostly", label: "Mostly full", fraction: 0.75 },
  { key: "half", label: "Half", fraction: 0.5 },
  { key: "low", label: "Low", fraction: 0.2 },
  { key: "empty", label: "Empty", fraction: 0 },
] as const;
export type LevelPresetKey = (typeof LEVEL_PRESETS)[number]["key"];

export function levelLabel(fraction: number): string {
  if (fraction <= 0.02) return "Empty";
  if (fraction <= 0.3) return "Low";
  if (fraction <= 0.6) return "Half";
  if (fraction <= 0.9) return "Mostly full";
  return "Full";
}

// ─── Diet, allergens, cuisines ───────────────────────────────────────────────

/** What an ingredient contains. Drives allergy + dietary filtering deterministically. */
export const CONTAINS_FLAGS = [
  "meat", // red meat (beef, lamb, etc.)
  "pork",
  "poultry",
  "fish",
  "shellfish",
  "dairy",
  "egg",
  "gluten",
  "peanuts",
  "tree_nuts",
  "soy",
  "sesame",
  "alcohol",
  "honey",
] as const;
export type ContainsFlag = (typeof CONTAINS_FLAGS)[number];

export const ALLERGENS = [
  "peanuts",
  "tree_nuts",
  "dairy",
  "egg",
  "gluten",
  "soy",
  "fish",
  "shellfish",
  "sesame",
] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const ALLERGEN_LABELS: Record<Allergen, string> = {
  peanuts: "Peanuts",
  tree_nuts: "Tree nuts",
  dairy: "Dairy",
  egg: "Eggs",
  gluten: "Gluten",
  soy: "Soy",
  fish: "Fish",
  shellfish: "Shellfish",
  sesame: "Sesame",
};

export const DIETS = [
  "vegetarian",
  "vegan",
  "pescatarian",
  "gluten_free",
  "dairy_free",
  "halal",
  "no_pork",
  "no_red_meat",
] as const;
export type Diet = (typeof DIETS)[number];

export const DIET_LABELS: Record<Diet, string> = {
  vegetarian: "Vegetarian",
  vegan: "Vegan",
  pescatarian: "Pescatarian",
  gluten_free: "Gluten free",
  dairy_free: "Dairy free",
  halal: "Halal",
  no_pork: "No pork",
  no_red_meat: "No red meat",
};

/** Flags that make a dish incompatible with each diet. */
export const DIET_EXCLUDES: Record<Diet, ContainsFlag[]> = {
  vegetarian: ["meat", "pork", "poultry", "fish", "shellfish"],
  vegan: ["meat", "pork", "poultry", "fish", "shellfish", "dairy", "egg", "honey"],
  pescatarian: ["meat", "pork", "poultry"],
  gluten_free: ["gluten"],
  dairy_free: ["dairy"],
  halal: ["pork", "alcohol"],
  no_pork: ["pork"],
  no_red_meat: ["meat"],
};

export const CUISINES = [
  "italian",
  "mexican",
  "indian",
  "chinese",
  "thai",
  "japanese",
  "korean",
  "vietnamese",
  "middle_eastern",
  "mediterranean",
  "greek",
  "french",
  "spanish",
  "american",
  "british",
  "australian",
  "other",
] as const;
export type Cuisine = (typeof CUISINES)[number];

export const CUISINE_LABELS: Record<Cuisine, string> = {
  italian: "Italian",
  mexican: "Mexican",
  indian: "Indian",
  chinese: "Chinese",
  thai: "Thai",
  japanese: "Japanese",
  korean: "Korean",
  vietnamese: "Vietnamese",
  middle_eastern: "Middle Eastern",
  mediterranean: "Mediterranean",
  greek: "Greek",
  french: "French",
  spanish: "Spanish",
  american: "American",
  british: "British",
  australian: "Australian",
  other: "Something else",
};

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Involved",
};

export const MEAL_SLOTS = ["breakfast", "lunch", "dinner"] as const;
export type MealSlot = (typeof MEAL_SLOTS)[number];

export const COOKING_FREQUENCIES = ["rarely", "sometimes", "most_nights", "every_night"] as const;
export type CookingFrequency = (typeof COOKING_FREQUENCIES)[number];

export const COOKING_FREQUENCY_LABELS: Record<CookingFrequency, string> = {
  rarely: "Rarely",
  sometimes: "A few nights a week",
  most_nights: "Most nights",
  every_night: "Every night",
};

/** Home-cooked dinners per week implied by each cooking frequency. */
export const COOKING_FREQUENCY_NIGHTS: Record<CookingFrequency, number> = {
  rarely: 2,
  sometimes: 4,
  most_nights: 5,
  every_night: 7,
};

// ─── Shopping list ───────────────────────────────────────────────────────────

export const SHOPPING_SOURCES = ["manual", "predicted", "meal_plan", "staple"] as const;
export type ShoppingSource = (typeof SHOPPING_SOURCES)[number];

export const SHOPPING_SOURCE_LABELS: Record<ShoppingSource, string> = {
  manual: "Added by you",
  predicted: "Running low",
  meal_plan: "For your meal plan",
  staple: "Household staple",
};

// ─── Notifications ───────────────────────────────────────────────────────────

export const NOTIFICATION_TYPES = [
  "running_low",
  "use_soon",
  "meal_plan_ready",
  "shopping_reminder",
  "receipt_ready",
  "check_in",
  "insight",
  "household",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// ─── Household size ──────────────────────────────────────────────────────────

/** Children eat roughly 60% of an adult on average; used to scale consumption priors. */
export const CHILD_EQUIVALENT = 0.6;

export function adultEquivalents(adults: number, children: number): number {
  const ae = Math.max(0, adults) + Math.max(0, children) * CHILD_EQUIVALENT;
  return Math.max(1, Math.round(ae * 100) / 100);
}

export const SUPERMARKETS = [
  "Woolworths",
  "Coles",
  "Aldi",
  "IGA",
  "Harris Farm",
  "Costco",
  "Tesco",
  "Sainsbury's",
  "Asda",
  "Lidl",
  "Waitrose",
  "Countdown",
  "New World",
  "Pak'nSave",
  "Walmart",
  "Kroger",
  "Trader Joe's",
  "Whole Foods",
  "Target",
] as const;

export const CURRENCIES = ["AUD", "NZD", "GBP", "USD", "EUR", "CAD"] as const;
export type Currency = (typeof CURRENCIES)[number];
