import type { Cuisine, Difficulty } from "@/lib/domain";
import type { Unit } from "@/lib/units";

export interface RecipeIngredient {
  /** Catalog product slug this ingredient resolves to, or null for free-text items. */
  product: string | null;
  /** Display name as written in the recipe, e.g. "baby spinach". */
  name: string;
  /** Quantity for the recipe's stated servings. Omit for "to taste". */
  quantity?: number;
  unit?: Unit;
  optional?: boolean;
  /** Preparation note, e.g. "finely chopped". */
  note?: string;
}

/** A structured recipe from Plenty's built-in library. */
export interface Recipe {
  /** Stable identifier, kebab-case. */
  slug: string;
  name: string;
  /** One sentence, warm and specific. No marketing language. */
  description: string;
  cuisine: Cuisine;
  /** Total hands-on + cooking time in minutes. */
  timeMinutes: number;
  difficulty: Difficulty;
  servings: number;
  /** Hero ingredient used for variety and for the visual tile, e.g. "chicken", "chickpeas". */
  mainIngredient: string;
  /** Extra descriptive tags: "quick", "kid_friendly", "one_pot", "freezer_friendly", "comfort", "light". */
  tags: string[];
  ingredients: RecipeIngredient[];
  /** Ordered steps, each one or two sentences. */
  steps: string[];
}
