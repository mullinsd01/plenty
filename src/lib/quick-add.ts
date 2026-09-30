import { parseUnit, type Unit } from "@/lib/units";

export interface QuickAddItem {
  name: string;
  /** Explicit amount with a unit ("500g mince"). */
  quantity: number | null;
  unit: Unit | null;
  /** Count of packs/items ("2 milk", "a dozen eggs"). */
  packCount: number;
}

const WORD_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, dozen: 12 };

/**
 * Parse free text like "2 milk, bread, 500g mince, a dozen eggs" into items.
 * Commas and new lines separate items.
 */
export function parseQuickAdd(text: string): QuickAddItem[] {
  return text
    .split(/[,\n;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseOne)
    .filter((i): i is QuickAddItem => i !== null);
}

function parseOne(raw: string): QuickAddItem | null {
  let text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  // "500g mince", "1.5 kg chicken", "2L milk"
  const measured = text.match(/^(\d+(?:[.,]\d+)?)\s*(kg|g|gm|grams?|l|lt|litres?|liters?|ml)\b\.?\s*(?:of\s+)?(.+)$/i);
  if (measured) {
    const unit = parseUnit(measured[2]);
    const name = measured[3].trim();
    if (unit && name) return { name: cap(name), quantity: Number(measured[1].replace(",", ".")), unit, packCount: 1 };
  }
  // "a dozen eggs"
  const dozen = text.match(/^(?:a\s+)?dozen\s+(.+)$/i);
  if (dozen) return { name: cap(dozen[1]), quantity: 12, unit: "each", packCount: 1 };
  // "2 milk", "2x bread", "two avocados"
  const counted = text.match(/^(\d+|a|an|one|two|three|four|five|six)\s*x?\s+(.+)$/i);
  if (counted) {
    const n = /^\d+$/.test(counted[1]) ? Number(counted[1]) : WORD_NUMBERS[counted[1].toLowerCase()] ?? 1;
    text = counted[2];
    return { name: cap(text), quantity: null, unit: null, packCount: Math.min(Math.max(1, n), 100) };
  }
  // "milk x2"
  const trailing = text.match(/^(.+?)\s*x\s*(\d+)$/i);
  if (trailing) return { name: cap(trailing[1]), quantity: null, unit: null, packCount: Math.min(Number(trailing[2]), 100) };
  return { name: cap(text), quantity: null, unit: null, packCount: 1 };
}

function cap(s: string): string {
  const t = s.trim().slice(0, 120);
  return t.charAt(0).toUpperCase() + t.slice(1);
}
