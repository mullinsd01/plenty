import "server-only";
import { parseReceiptText } from "@/lib/receipts/parse";
import { ocrReceipt } from "@/server/receipts/ocr";
import { ocrVariant } from "@/server/receipts/image";
import type { AIProvider, GroceryPhotoInput, GroceryPhotoReading, ReceiptExtraction, ReceiptExtractionInput } from "./types";

/**
 * Fully offline provider: Tesseract OCR + Plenty's deterministic receipt
 * parser. Recipes come from the built-in library instead of being generated.
 */
export class LocalProvider implements AIProvider {
  readonly id = "local" as const;
  readonly label = "On-device reading";
  readonly generateRecipes = null;

  /**
   * A fixed, made-up list: this provider cannot look at pictures, and never pretends to. It exists so the
   * photo flow can be built, tested and demonstrated without an AI service. Photo recognition only uses
   * it outside production and labels the result as a sample.
   */
  async recognizeGroceries(_input: GroceryPhotoInput): Promise<GroceryPhotoReading> {
    return {
      isGroceryPhoto: true,
      items: [
        { name: "Bananas", quantity: 5, confidence: "high" },
        { name: "Full cream milk", quantity: 1, confidence: "high" },
        { name: "Sourdough bread", quantity: 1, confidence: "medium" },
        { name: "Red capsicum", quantity: 2, confidence: "medium" },
        { name: "Jar of something", quantity: null, confidence: "low" },
      ],
      problems: [],
      provider: "local",
    };
  }

  async extractReceipt(input: ReceiptExtractionInput): Promise<ReceiptExtraction> {
    const prepared = await ocrVariant(input.image);
    const { text, confidence } = await ocrReceipt(prepared);
    const parsed = parseReceiptText(text, { today: input.today });
    return {
      isReceipt: parsed.lines.length > 0,
      legible: confidence >= 40,
      store: parsed.store,
      purchasedOn: parsed.purchasedOn,
      currency: null,
      subtotal: parsed.subtotal,
      total: parsed.total,
      lines: parsed.lines.map((line) => ({
        raw: line.description,
        name: null,
        quantity: line.quantity,
        weightKg: line.weightKg,
        unitPrice: line.unitPrice,
        price: line.price,
        isGrocery: true,
      })),
      problems: parsed.warnings,
      rawText: text,
      ocrConfidence: confidence,
      provider: "local",
    };
  }
}
