/**
 * Checking what an AI reader says it can see in a grocery photo.
 *
 * The reader's answer is only a *guess*, and anything it says is untrusted
 * text: it may be malformed, enormous, repeated, or — if the photo has writing
 * in it — carry instructions aimed at the model. Everything here is
 * deterministic: names are cleaned and must look like something you'd write
 * on a shopping list, counts are small whole numbers, free text from the
 * reader is not passed on at all (the only notes shown are a fixed set that
 * Plenty words itself), and the list is capped. A guess that doesn't pass is
 * dropped rather than repaired.
 *
 * Pure and dependency-free: used by the server before showing a review, and
 * again before adding anything.
 */

export const GUESS_CONFIDENCES = ["high", "medium", "low"] as const;
export type GuessConfidence = (typeof GUESS_CONFIDENCES)[number];

/** The only problems the reader may report; Plenty words them itself. */
export const PHOTO_PROBLEMS = ["blurry", "dark", "partly_hidden", "crowded"] as const;
export type PhotoProblem = (typeof PHOTO_PROBLEMS)[number];

export const PHOTO_PROBLEM_TEXT: Record<PhotoProblem, string> = {
  blurry: "The photo is a little blurry, so some of these may be off.",
  dark: "The photo is quite dark, so some of these may be off.",
  partly_hidden: "Some things look hidden behind others, so there may be more than what's listed.",
  crowded: "It's a busy photo, so the counts are rough.",
};

/** The most guesses kept from one photo. */
export const MAX_GUESSES = 40;
export const MIN_NAME_LENGTH = 2;
export const MAX_NAME_LENGTH = 60;
const MAX_NAME_WORDS = 8;
/** A rough count above this isn't believable from one photo, so it's treated as "couldn't tell". */
export const MAX_GUESS_QUANTITY = 24;

export interface ValidGuess {
  name: string;
  /** 1 when the count is unknown. */
  quantity: number;
  quantityKnown: boolean;
  confidence: GuessConfidence;
}

export interface ValidReading {
  /** The reader says the photo shows groceries. */
  isGroceryPhoto: boolean;
  guesses: ValidGuess[];
  problems: PhotoProblem[];
  /** How many entries were dropped: unusable, repeated or past the cap. */
  discarded: number;
}

/** Letters, numbers and a little punctuation, starting with a letter or number. */
const NAME_SHAPE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} '’&.,%()/+-]*$/u;

/** Words that mean the reader is describing the photo or talking to us, not naming a product. */
const NOT_A_PRODUCT =
  /^(?:photo|photos|picture|image|none|n\/a|na|unknown|item|items|thing|things|stuff|food|foods|groceries|grocery|shopping|background|table|counter|bench|benchtop|shelf|shelves|fridge|freezer|pantry|bag|bags|box|boxes|hand|hands|text|label|labels|logo|container|containers|packaging|product|products|other|misc|various|undefined|null)$/i;

/** Wording aimed at a model, links, and addresses: never part of a product name. */
const SUSPICIOUS =
  /(?:ignore|disregard|forget|override|bypass)\b|\b(?:system|developer|assistant|user)\s*(?:prompt|message|role|:)|\binstructions?\b|\bprompt\b|\byou\s+(?:are|must|should|will)\b|\bas an ai\b|\bjailbreak\b|https?:|www\.|\.(?:com|net|org|io|ai|app)\b|@|\bsudo\b|\bselect\s.+\sfrom\b|\bdrop\s+table\b/i;

/** A product name from a reader's text, or null when it isn't one. */
export function cleanGuessName(input: unknown): string | null {
  if (typeof input !== "string" || input.length > MAX_NAME_LENGTH * 4) return null;
  const text = input
    .normalize("NFKC")
    // Zero-width and control characters hide text from people; they have no place in a name.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < MIN_NAME_LENGTH || text.length > MAX_NAME_LENGTH) return null;
  if (!NAME_SHAPE.test(text)) return null;
  if ((text.match(/\p{L}/gu) ?? []).length < MIN_NAME_LENGTH) return null;
  if (text.split(" ").length > MAX_NAME_WORDS) return null;
  if (NOT_A_PRODUCT.test(text) || SUSPICIOUS.test(text)) return null;
  return text;
}

/** Whole count from the reader, or "unknown". Never a weight, never a fraction. */
export function cleanGuessQuantity(input: unknown): { quantity: number; known: boolean } {
  if (typeof input !== "number" || !Number.isFinite(input)) return { quantity: 1, known: false };
  const rounded = Math.round(input);
  if (rounded < 1 || rounded > MAX_GUESS_QUANTITY) return { quantity: 1, known: false };
  return { quantity: rounded, known: true };
}

const CONFIDENCE_RANK: Record<GuessConfidence, number> = { low: 0, medium: 1, high: 2 };

function guessKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .map((w) => (w.endsWith("ies") && w.length > 4 ? `${w.slice(0, -3)}y` : w.endsWith("s") && !w.endsWith("ss") && w.length > 3 ? w.slice(0, -1) : w));
  return words.join(" ");
}

/**
 * Validate a reader's answer (any shape) into guesses Plenty is willing to
 * show. Returns null when the answer isn't the expected shape at all.
 */
export function validateReading(raw: unknown): ValidReading | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.isGroceryPhoto !== "boolean" || !Array.isArray(obj.items)) return null;

  const problems = Array.isArray(obj.problems)
    ? [...new Set(obj.problems.filter((p): p is PhotoProblem => typeof p === "string" && (PHOTO_PROBLEMS as readonly string[]).includes(p)))]
    : [];

  const byKey = new Map<string, ValidGuess>();
  let discarded = 0;
  // Never walk more than a sensible number of entries, however long the reader's list is.
  const entries = obj.items.slice(0, MAX_GUESSES * 3);
  discarded += obj.items.length - entries.length;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      discarded += 1;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const name = cleanGuessName(e.name);
    if (!name) {
      discarded += 1;
      continue;
    }
    const { quantity, known } = cleanGuessQuantity(e.quantity);
    const confidence = GUESS_CONFIDENCES.find((c) => c === e.confidence) ?? "low";
    const key = guessKey(name);
    const existing = byKey.get(key);
    if (existing) {
      // The same thing listed twice: keep one, with the more cautious confidence and the larger count.
      discarded += 1;
      existing.quantity = Math.max(existing.quantity, quantity);
      existing.quantityKnown = existing.quantityKnown || known;
      if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[existing.confidence]) existing.confidence = confidence;
      continue;
    }
    byKey.set(key, { name, quantity, quantityKnown: known, confidence });
  }
  const all = [...byKey.values()];
  const guesses = all.slice(0, MAX_GUESSES);
  discarded += all.length - guesses.length;
  return { isGroceryPhoto: obj.isGroceryPhoto, guesses: obj.isGroceryPhoto ? guesses : [], problems, discarded };
}
