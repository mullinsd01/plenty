import type {
  Aisle,
  Allergen,
  Confidence,
  ContainsFlag,
  Cuisine,
  Diet,
  Difficulty,
  PredictionBasis,
  ShoppingSource,
  StorageLocation,
} from "@/lib/domain";
import type { BaseUnit, Unit } from "@/lib/units";

/** One active inventory item as seen by the meal and shopping engines. */
export interface InventoryLot {
  id: string;
  productId: string | null;
  name: string;
  /** Purchased amount in `unit`. */
  quantity: number;
  unit: Unit;
  /** Current *estimated* fraction remaining (0–1), already adjusted for predicted consumption. */
  remainingFraction: number;
  /** Effective expiry (actual if known, else estimated), YYYY-MM-DD. */
  expiresOn: string | null;
  location: StorageLocation;
  /**
   * Share of this lot the household gets through each day in everyday use
   * (milk in tea, bread for lunches). 0 or absent when it isn't the batch in use.
   */
  dailyUseFraction?: number;
  /** The date `remainingFraction` describes, YYYY-MM-DD. With `dailyUseFraction`, meals on later dates see less. */
  levelAsOf?: string;
}

export interface MealIngredientInput {
  name: string;
  productId: string | null;
  /** Quantity for the meal's base servings; null = "to taste" / unspecified. */
  quantity: number | null;
  unit: Unit | null;
  optional: boolean;
}

/** A meal (recipe) as consumed by the planner. */
export interface PlannableMeal {
  id: string;
  slug: string;
  name: string;
  cuisine: Cuisine;
  timeMinutes: number;
  difficulty: Difficulty;
  servings: number;
  mainIngredient: string;
  tags: string[];
  contains: ContainsFlag[];
  ingredients: MealIngredientInput[];
  source: "library" | "ai" | "user";
}

export type IngredientStatus = "have" | "partial" | "missing" | "assumed" | "optional_missing";

export interface IngredientAvailability {
  name: string;
  productId: string | null;
  status: IngredientStatus;
  /** Amount needed for the planned servings (in `unit`), when known. */
  neededQuantity: number | null;
  unit: Unit | null;
  /** Amount of the need covered by inventory, in `unit`, when computable. */
  coveredQuantity: number | null;
  /** Inventory lots used to satisfy this ingredient. */
  matchedLotIds: string[];
  /** True if satisfied by an interchangeable product (same group) rather than the exact one. */
  substitute: boolean;
  /** True if a matched lot expires within 3 days of the meal date. */
  usesSoonExpiring: boolean;
}

export interface PlanMealInput {
  planItemId: string;
  /** YYYY-MM-DD */
  date: string;
  servings: number;
  meal: PlannableMeal;
}

export interface MissingIngredient {
  /** productId when known, otherwise a normalised name key ("name:baby spinach"). */
  key: string;
  productId: string | null;
  name: string;
  aisle: Aisle;
  /** Shortfall across all meals (in `unit`), or null when the quantity can't be computed. */
  shortfallQuantity: number | null;
  unit: Unit | null;
  /** What to actually buy, rounded up to whole packages where the product is known. */
  purchaseQuantity: number;
  purchaseUnit: Unit;
  forPlanItemIds: string[];
  /** Plain language, e.g. "For Tuesday's chicken curry". */
  reason: string;
}

export interface PlanRequirementsResult {
  meals: Array<{
    planItemId: string;
    ingredients: IngredientAvailability[];
    haveCount: number;
    missingCount: number;
    allAvailable: boolean;
  }>;
  missing: MissingIngredient[];
}

// ─── Planner ────────────────────────────────────────────────────────────────

export interface PlannerPreferences {
  diets: Diet[];
  allergies: Allergen[];
  dislikedIngredients: string[];
  favouriteCuisines: Cuisine[];
  weeknightMaxMinutes: number | null;
  /** Adult equivalents. */
  householdSize: number;
  weeklyBudget: number | null;
}

export interface MealHistory {
  mealId: string;
  rating: -1 | 0 | 1;
  saved: boolean;
  timesPlanned: number;
  timesCooked: number;
  timesRejected: number;
  lastPlannedAt: Date | null;
  lastCookedAt: Date | null;
  lastRejectedAt: Date | null;
}

export interface ScoredMeal {
  meal: PlannableMeal;
  score: number;
  /** Fraction (0–1) of non-optional, non-assumed ingredients available. */
  coverage: number;
  haveCount: number;
  missingCount: number;
  missingNames: string[];
  /** Names of soon-expiring inventory items this meal would use. */
  useSoonNames: string[];
  ingredients: IngredientAvailability[];
  /** Human-readable reasons, most important first. */
  reasons: string[];
  /** The single best reason, for card subtitles. */
  primaryReason: string;
}

// ─── Shopping ───────────────────────────────────────────────────────────────

export interface PredictionInput {
  productId: string | null;
  itemKey: string;
  name: string;
  aisle: Aisle;
  daysRemaining: number;
  daysLow: number;
  daysHigh: number;
  confidence: Confidence;
  basis: PredictionBasis;
  /** Base units per day. */
  dailyRate: number;
  baseUnit: BaseUnit;
}

export interface StapleInput {
  productId: string;
  name: string;
  aisle: Aisle;
  /** Typical amount bought each time, in base units. */
  typicalPurchaseAmount: number | null;
  baseUnit: BaseUnit;
  lastPurchasedAt: Date | null;
  typicalIntervalDays: number | null;
  hasActiveStock: boolean;
}

export interface ShoppingNeedSource {
  source: Exclude<ShoppingSource, "manual">;
  quantity: number | null;
  unit: Unit | null;
  note: string;
  mealPlanItemId?: string;
}

export interface ShoppingNeed {
  itemKey: string;
  productId: string | null;
  name: string;
  aisle: Aisle;
  quantity: number | null;
  unit: Unit | null;
  sources: ShoppingNeedSource[];
  primarySource: Exclude<ShoppingSource, "manual">;
  reason: string;
  advice?: string;
}

export interface ExistingListItem {
  id: string;
  itemKey: string;
  productId: string | null;
  name: string;
  aisle: Aisle;
  quantity: number | null;
  unit: Unit | null;
  suggestedQuantity: number | null;
  suggestedUnit: Unit | null;
  source: ShoppingSource;
  userEdited: boolean;
  checkedAt: Date | null;
  dismissedUntil: Date | null;
  purchasedAt: Date | null;
}

export interface ReconcileResult {
  create: ShoppingNeed[];
  update: Array<{
    id: string;
    suggestedQuantity: number | null;
    suggestedUnit: Unit | null;
    source: ShoppingSource;
    reason: string;
    advice: string | null;
    sources: ShoppingNeedSource[];
  }>;
  /** Ids of auto-added items that are no longer needed. */
  remove: string[];
}
