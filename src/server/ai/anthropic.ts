import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import {
  AIUnavailableError,
  generatedRecipesSchema,
  receiptExtractionSchema,
  type AIProvider,
  type GeneratedRecipe,
  type ReceiptExtraction,
  type ReceiptExtractionInput,
  type RecipeGenerationInput,
} from "./types";

const RECEIPT_SYSTEM = `You read photos of supermarket receipts for a household grocery app.
Transcribe every purchased line faithfully and extract structured data.
- "raw" is the item description exactly as printed, without the price (keep abbreviations and sizes, e.g. "W/M FULL CREAM 2L").
- "name" is a clean everyday product name a person would write on a shopping list, keeping size if printed ("Full cream milk 2L"). Null for non-grocery lines.
- Weighed items: set weightKg and the line total as price. Multi-buy lines like "2 @ $1.50": quantity 2, unitPrice 1.50, price 3.00.
- Apply discounts/savings printed under an item to that item's price; don't emit discount lines separately.
- isGrocery is false for carry bags, container deposits, gift cards, lottery, subtotals, tax, payment and loyalty lines — and those lines shouldn't be listed at all unless they carry a price.
- Dates: output YYYY-MM-DD. Most receipts are day-first (DD/MM/YY) unless the store is clearly American.
- Never invent lines you can't read. If part of the receipt is unreadable, say so in "problems".
- If the image is not a receipt, set isReceipt false and return no lines.`;

const RECIPE_SYSTEM = `You write practical, genuinely good home-cooking recipes for a household meal-planning app.
Recipes must be realistic for a weeknight home cook, use common supermarket ingredients, and give quantities for the stated servings in metric units (g, kg, ml, l, tsp, tbsp, cup, each, clove, can, bunch, pack, slice).
Prioritise using the listed ingredients the household already has — especially the "use soon" items — and keep extra purchases minimal.
Hard rules: never include an allergen or anything that conflicts with the dietary requirements; avoid disliked foods entirely.
Steps are concrete and concise (4–8 steps). Descriptions are one specific, warm sentence without marketing language.
Use Australian English ingredient names (capsicum, coriander, zucchini, mince, spring onion, prawns).`;

function mapError(err: unknown): never {
  if (err instanceof AIUnavailableError) throw err;
  if (err instanceof Anthropic.RateLimitError) {
    throw new AIUnavailableError("The AI service is busy right now.", "rate_limited");
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    throw new AIUnavailableError("The AI service isn't configured correctly.", "config");
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    throw new AIUnavailableError("The AI service took too long to respond.", "timeout");
  }
  if (err instanceof Anthropic.APIConnectionError) {
    throw new AIUnavailableError("Couldn't reach the AI service.", "network");
  }
  if (err instanceof Anthropic.InternalServerError || (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500)) {
    throw new AIUnavailableError("The AI service is temporarily unavailable.", "overloaded");
  }
  if (err instanceof Anthropic.BadRequestError) {
    console.error("[ai] bad request:", err.message);
    throw new AIUnavailableError("The AI service couldn't process this request.", "invalid_output");
  }
  console.error("[ai] unexpected error:", err);
  throw new AIUnavailableError("The AI service failed unexpectedly.", "network");
}

export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic" as const;
  readonly label = "Claude";
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    // Requests are retried twice by the SDK on 429/5xx/connection errors.
    this.client = new Anthropic({ apiKey, timeout: 90_000, maxRetries: 2 });
  }

  /** Structured call: validated against the zod schema; refusals and empty parses become typed errors. */
  private async structured<S extends z.ZodType>(params: {
    schema: S;
    system: string;
    content: Anthropic.Beta.BetaContentBlockParam[];
    maxTokens: number;
    effort: "low" | "medium" | "high";
  }): Promise<z.infer<S>> {
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: params.maxTokens,
        system: params.system,
        // Server-side refusal fallback: if a safety classifier declines, the API retries on a suitable model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: params.effort, format: betaZodOutputFormat(params.schema) },
        messages: [{ role: "user", content: params.content }],
      });
      if (response.stop_reason === "refusal") {
        throw new AIUnavailableError("The AI service declined this request.", "refused");
      }
      if (response.stop_reason === "max_tokens") {
        throw new AIUnavailableError("The AI response was cut short.", "invalid_output");
      }
      if (!response.parsed_output) {
        throw new AIUnavailableError("The AI response couldn't be understood.", "invalid_output");
      }
      return response.parsed_output as z.infer<S>;
    } catch (err) {
      mapError(err);
    }
  }

  async extractReceipt(input: ReceiptExtractionInput): Promise<ReceiptExtraction> {
    const extraction = await this.structured({
      schema: receiptExtractionSchema,
      system: RECEIPT_SYSTEM,
      maxTokens: 16_000,
      effort: "medium",
      content: [
        { type: "image", source: { type: "base64", media_type: input.mimeType, data: input.image.toString("base64") } },
        {
          type: "text",
          text: `Today is ${input.today}. The household's currency is ${input.currency}.${
            input.preferredStores.length ? ` They usually shop at ${input.preferredStores.join(", ")}.` : ""
          }\nExtract this receipt.`,
        },
      ],
    });
    const rawText = extraction.lines.map((l) => l.raw).join("\n");
    return { ...extraction, rawText, ocrConfidence: null, provider: "anthropic" };
  }

  generateRecipes = async (input: RecipeGenerationInput): Promise<GeneratedRecipe[]> => {
    const lines = [
      `Write ${input.count} different dinner recipes for ${input.servings} servings.`,
      input.maxMinutes ? `Each should take at most ${input.maxMinutes} minutes.` : "",
      input.useSoon.length ? `Use soon (priority): ${input.useSoon.join(", ")}.` : "",
      input.inventory.length
        ? `Already in the kitchen:\n${input.inventory.map((i) => `- ${i.name} (${i.amount}${i.useBy ? `, use by ${i.useBy}` : ""})`).join("\n")}`
        : "The kitchen is nearly empty — favour pantry-friendly recipes.",
      input.allergies.length ? `ALLERGIES (never include): ${input.allergies.join(", ")}.` : "",
      input.diets.length ? `Dietary requirements (must follow): ${input.diets.join(", ")}.` : "",
      input.dislikes.length ? `Disliked (avoid): ${input.dislikes.join(", ")}.` : "",
      input.favouriteCuisines.length ? `They love: ${input.favouriteCuisines.join(", ")}.` : "",
      input.avoidMeals.length ? `Don't suggest these again: ${input.avoidMeals.slice(0, 40).join("; ")}.` : "",
    ].filter(Boolean);
    const result = await this.structured({
      schema: generatedRecipesSchema,
      system: RECIPE_SYSTEM,
      maxTokens: 16_000,
      effort: "medium",
      content: [{ type: "text", text: lines.join("\n\n") }],
    });
    return result.recipes;
  };
}
