import "server-only";
import { z } from "zod";
import { CUISINES, DIFFICULTIES } from "@/lib/domain";
import { UNITS } from "@/lib/units";

/**
 * The AI layer only *interprets* things (receipt photos, recipe ideas). Its
 * output is always validated here and then passed through deterministic code
 * and user confirmation before it can change household data.
 */

// ─── Receipts ───────────────────────────────────────────────────────────────

export const receiptLineSchema = z.object({
  /** The item description exactly as printed, without the price. */
  raw: z.string(),
  /** A clean, human product name if the line is a grocery item (e.g. "Full cream milk 2L"). */
  name: z.string().nullable(),
  /** Count purchased, e.g. 2 for "2 @ $1.50". */
  quantity: z.number().nullable(),
  /** Weight in kg for weighed produce/meat. */
  weightKg: z.number().nullable(),
  unitPrice: z.number().nullable(),
  /** Line total after any discount. */
  price: z.number().nullable(),
  /** False for bags, deposits, gift cards, subtotals, etc. */
  isGrocery: z.boolean(),
});

export const receiptExtractionSchema = z.object({
  isReceipt: z.boolean(),
  legible: z.boolean(),
  store: z.string().nullable(),
  /** YYYY-MM-DD */
  purchasedOn: z.string().nullable(),
  currency: z.string().nullable(),
  subtotal: z.number().nullable(),
  total: z.number().nullable(),
  lines: z.array(receiptLineSchema),
  /** Short notes about problems: "bottom of receipt cut off", "blurry". */
  problems: z.array(z.string()),
});

export type ReceiptExtraction = z.infer<typeof receiptExtractionSchema> & {
  rawText: string;
  /** 0–100 when produced by OCR; null for vision models. */
  ocrConfidence: number | null;
  provider: "anthropic" | "local";
};

/**
 * Longest an external AI provider may spend on one receipt, retries included.
 * Receipt processing sizes its lease (and the routes their `maxDuration`) from this.
 */
export const RECEIPT_AI_BUDGET_MS = 180_000;

export interface ReceiptExtractionInput {
  /** Prepared JPEG (rotated, resized, metadata stripped). */
  image: Buffer;
  mimeType: "image/jpeg";
  /** Household "today", YYYY-MM-DD — for resolving 2-digit years and sanity checks. */
  today: string;
  currency: string;
  preferredStores: string[];
}

// ─── Recipes ────────────────────────────────────────────────────────────────

export const generatedRecipeSchema = z.object({
  name: z.string(),
  description: z.string(),
  cuisine: z.enum(CUISINES),
  timeMinutes: z.number().int(),
  difficulty: z.enum(DIFFICULTIES),
  servings: z.number().int(),
  mainIngredient: z.string(),
  tags: z.array(z.string()),
  ingredients: z.array(
    z.object({
      name: z.string(),
      quantity: z.number().nullable(),
      unit: z.enum(UNITS).nullable(),
      optional: z.boolean(),
    }),
  ),
  steps: z.array(z.string()),
});

export const generatedRecipesSchema = z.object({ recipes: z.array(generatedRecipeSchema) });

export type GeneratedRecipe = z.infer<typeof generatedRecipeSchema>;

export interface RecipeGenerationInput {
  count: number;
  servings: number;
  maxMinutes: number | null;
  /** What's in the kitchen, most urgent first. */
  inventory: Array<{ name: string; amount: string; useBy: string | null }>;
  /** Items that should be used soon — prioritise these. */
  useSoon: string[];
  diets: string[];
  allergies: string[];
  dislikes: string[];
  favouriteCuisines: string[];
  /** Meals the household has rejected or already has — don't repeat. */
  avoidMeals: string[];
}

export interface AIProvider {
  readonly id: "anthropic" | "local";
  readonly label: string;
  /** Reads receipt photos. */
  extractReceipt(input: ReceiptExtractionInput): Promise<ReceiptExtraction>;
  /** Writes new recipes. Null when this provider can't (the built-in library is used instead). */
  generateRecipes: ((input: RecipeGenerationInput) => Promise<GeneratedRecipe[]>) | null;
}

/** Thrown when an AI provider fails in a way the caller may recover from (fallback / retry later). */
export class AIUnavailableError extends Error {
  constructor(
    message: string,
    public readonly reason: "rate_limited" | "overloaded" | "timeout" | "network" | "refused" | "invalid_output" | "config",
  ) {
    super(message);
    this.name = "AIUnavailableError";
  }
}
