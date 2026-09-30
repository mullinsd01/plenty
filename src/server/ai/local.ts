import "server-only";
import { parseReceiptText } from "@/lib/receipts/parse";
import { ocrReceipt } from "@/server/receipts/ocr";
import { ocrVariant } from "@/server/receipts/image";
import type { AIProvider, ReceiptExtraction, ReceiptExtractionInput } from "./types";

/**
 * Fully offline provider: Tesseract OCR + Plenty's deterministic receipt
 * parser. Recipes come from the built-in library instead of being generated.
 */
export class LocalProvider implements AIProvider {
  readonly id = "local" as const;
  readonly label = "On-device reading";
  readonly generateRecipes = null;

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
