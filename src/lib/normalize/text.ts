/**
 * Receipt text normalisation.
 *
 * Supermarket receipt lines are upper-case, truncated, abbreviated and
 * prefixed with store brands ("W/M FULL CREAM 2L", "CHKN BRST FLLT 1KG",
 * "GV 2% MILK GAL"). This module turns them into clean, comparable text and
 * pulls out the pack size. It knows nothing about the product catalog —
 * matching lives in `match.ts`.
 *
 * Pure and deterministic.
 */

import type { Unit } from "@/lib/units";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReceiptSize {
  quantity: number;
  unit: Unit;
}

export interface CleanedReceiptText {
  /** Lower-case, expanded, brand- and size-free text, e.g. "full cream". */
  cleaned: string;
  /** `cleaned` split into words (not singularised). */
  tokens: string[];
  /**
   * Size as printed, or null: one item's ("2L" → 2 l; "6X375ML" → 375 ml),
   * or the whole pack's when `sizeIsTotal`.
   */
  size: ReceiptSize | null;
  /** Items in the pack ("6PK", "X6", "12S", "DOZEN", "6X375ML" → 6), or null. */
  packCount: number | null;
  /**
   * `size` is the whole pack's net amount, not one item's: a weight beside a
   * pack count that isn't a multiplier ("SAUSAGES 8PK 500G" is 500 g of
   * sausages). Multipliers ("6X375ML", "500G X2", "X6") and volumes
   * ("COKE 24PK 375ML", sold by the can) give one item's size.
   */
  sizeIsTotal: boolean;
  /** Sold by weight ("BANANAS KG", "$3.90/KG"). */
  perKg: boolean;
  /** Store-brand / range / national-brand words that were removed. */
  removedBrandTokens: string[];
}

export interface CleanOptions {
  /** Remove store-brand and national-brand words (default true). Off when indexing catalog aliases. */
  stripBrands?: boolean;
}

// ─── Basic text ─────────────────────────────────────────────────────────────

const DIACRITICS = /[̀-ͯ]/g;
const APOSTROPHES = /['’‘`´]/g;
const DECIMAL_MARK = "\u0001";
const FRACTION_MARK = "\u0002";
const PERCENT_MARK = "\u0003";
const PLAIN_TEXT = /^[a-z0-9 ]*$/;

/**
 * Lower-case, strip accents and punctuation, collapse whitespace.
 * Keeps what carries meaning: decimal points ("1.5"), fractions ("1/2"),
 * percentages ("2%"). Single letters around a slash are joined
 * ("W/M" → "wm", "F/R" → "fr") because receipts abbreviate that way;
 * "&" becomes "and".
 */
export function normalizeText(input: string): string {
  // Already plain lower-case words (most catalog aliases): only whitespace to tidy.
  if (PLAIN_TEXT.test(input)) return input.replace(/\s+/g, " ").trim();
  return input
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(/&/g, " and ")
    .replace(/\b([a-z])\s*\/\s*([a-z])\b/g, "$1$2")
    .replace(/(\d)\.(?=\d)/g, `$1${DECIMAL_MARK}`)
    .replace(/(\d)\/(?=\d)/g, `$1${FRACTION_MARK}`)
    .replace(/(\d)%/g, `$1${PERCENT_MARK}`)
    .replace(/[^a-z0-9\u0001\u0002\u0003]+/g, " ")
    .replace(new RegExp(DECIMAL_MARK, "g"), ".")
    .replace(new RegExp(FRACTION_MARK, "g"), "/")
    .replace(new RegExp(PERCENT_MARK, "g"), "%")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stable key for remembering a household's mapping of this exact receipt
 * text: lower-case letters, digits and spaces (decimal points inside numbers
 * are kept so "1.5L" and "15L" differ). Sizes stay in the key.
 * "W/M FULL CREAM 2L" → "wm full cream 2l".
 */
export function aliasKey(raw: string): string {
  return normalizeText(raw)
    .replace(/[%/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ACRONYMS = new Set(["bbq", "uht", "a2", "spf", "xo", "ipa", "gf"]);

/** "KALE CHIPS" / "kale chips" → "Kale chips". Known acronyms stay upper-case ("BBQ sauce"). */
export function sentenceCase(text: string): string {
  const words = text.trim().replace(/\s+/g, " ").toLowerCase().split(" ").filter(Boolean);
  if (words.length === 0) return "";
  const cased = words.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(" ");
  return cased.charAt(0).toUpperCase() + cased.slice(1);
}

// ─── Singularisation ────────────────────────────────────────────────────────

/** Words ending in "s" that are already singular. */
const SINGULAR_INVARIANTS = new Set([
  "asparagus",
  "bonus",
  "cactus",
  "chassis",
  "christmas",
  "citrus",
  "couscous",
  "harris",
  "hibiscus",
  "hummus",
  "houmous",
  "iris",
  "lotus",
  "mars",
  "molasses",
  "news",
  "octopus",
  "paris",
  "pastis",
  "series",
  "species",
  "swiss",
  "tennis",
  "xmas",
]);

/** Plurals the suffix rules would get wrong. */
const IRREGULAR_PLURALS: Record<string, string> = {
  aches: "ache",
  aloes: "aloe",
  aussies: "aussie",
  barbies: "barbie",
  beanies: "beanie",
  bikkies: "bikkie",
  brioches: "brioche",
  brownies: "brownie",
  buses: "bus",
  caches: "cache",
  calories: "calorie",
  calves: "calf",
  canoes: "canoe",
  charcuteries: "charcuterie",
  children: "child",
  chilies: "chili",
  chillies: "chilli",
  citruses: "citrus",
  cookies: "cookie",
  creches: "creche",
  feet: "foot",
  floes: "floe",
  gateaux: "gateau",
  geese: "goose",
  goodies: "goodie",
  halves: "half",
  headaches: "headache",
  hoagies: "hoagie",
  hoes: "hoe",
  knives: "knife",
  leaves: "leaf",
  lives: "life",
  loaves: "loaf",
  men: "man",
  mice: "mouse",
  mousses: "mousse",
  movies: "movie",
  niches: "niche",
  oboes: "oboe",
  pies: "pie",
  quiches: "quiche",
  quizzes: "quiz",
  rotisseries: "rotisserie",
  scarves: "scarf",
  shelves: "shelf",
  shoes: "shoe",
  sloes: "sloe",
  smoothies: "smoothie",
  teeth: "tooth",
  thieves: "thief",
  ties: "tie",
  toes: "toe",
  veggies: "veggie",
  wives: "wife",
  wolves: "wolf",
  women: "woman",
  zombies: "zombie",
};

/** Words this short are left alone ("cos", "gas", "yes"). */
const MIN_SINGULARIZE_LENGTH = 4;

/**
 * Singular form of one lower-case word: tomatoes → tomato, berries → berry,
 * leaves → leaf, peaches → peach, chips → chip. Leaves singular words ending
 * in "s" alone (hummus, asparagus, couscous, swiss, glass) as well as short
 * words and anything containing digits.
 */
export function singularize(word: string): string {
  const w = word.toLowerCase();
  if (w.length < MIN_SINGULARIZE_LENGTH || /\d/.test(w)) return w;
  const irregular = IRREGULAR_PLURALS[w];
  if (irregular) return irregular;
  if (SINGULAR_INVARIANTS.has(w) || !w.endsWith("s")) return w;
  if (w.endsWith("ss") || w.endsWith("us")) return w;
  if (w.endsWith("ies")) return w.length > 4 ? `${w.slice(0, -3)}y` : w.slice(0, -1);
  if (w.endsWith("oes")) return w.slice(0, -2);
  if (w.endsWith("sses") || w.endsWith("zzes") || w.endsWith("xes") || w.endsWith("ches") || w.endsWith("shes")) {
    return w.slice(0, -2);
  }
  return w.slice(0, -1);
}

/** Singularise every word of a phrase: "cherry tomatoes" → "cherry tomato". */
export function singularizePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(singularize)
    .join(" ");
}

// ─── Sizes ──────────────────────────────────────────────────────────────────

interface SizeUnitDef {
  unit: Unit;
  /** Multiplier from the written unit into `unit`. */
  factor: number;
}

/** Written size units → tracked unit. Imperial pints (UK receipts) are 568 ml. */
const SIZE_UNIT_GROUPS: Array<[string[], SizeUnitDef]> = [
  [["millilitres", "milliliters", "millilitre", "milliliter", "mls", "ml"], { unit: "ml", factor: 1 }],
  [["cl"], { unit: "ml", factor: 10 }],
  [["litres", "liters", "litre", "liter", "ltrs", "ltr", "lt", "l"], { unit: "l", factor: 1 }],
  [["kilograms", "kilogram", "kilos", "kilo", "kgs", "kg"], { unit: "kg", factor: 1 }],
  [["grams", "gram", "grms", "grm", "gms", "gm", "gr", "g"], { unit: "g", factor: 1 }],
  [["fl oz", "floz"], { unit: "ml", factor: 29.5735 }],
  [["ounces", "ounce", "oz"], { unit: "g", factor: 28.3495 }],
  [["pounds", "pound", "lbs", "lb"], { unit: "g", factor: 453.592 }],
  [["gallons", "gallon", "gal"], { unit: "l", factor: 3.78541 }],
  [["quarts", "quart", "qt"], { unit: "ml", factor: 946.353 }],
  [["pints", "pint", "pt"], { unit: "ml", factor: 568.261 }],
];

const SIZE_UNITS = new Map<string, SizeUnitDef>();
for (const [names, def] of SIZE_UNIT_GROUPS) for (const name of names) SIZE_UNITS.set(name, def);

const UNIT_ALTERNATION = [...SIZE_UNITS.keys()]
  .sort((a, b) => b.length - a.length)
  .map((name) => name.replace(" ", "\\s*"))
  .join("|");

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const MULTIPACK_COUNT_FIRST = new RegExp(
  String.raw`(?<![\d.])(\d+)\s*x\s*${NUM}\s*(${UNIT_ALTERNATION})(?![a-z0-9])`,
  "g",
);
const MULTIPACK_SIZE_FIRST = new RegExp(
  String.raw`(?<![\d.])${NUM}\s*(${UNIT_ALTERNATION})\s*x\s*(\d+)(?![\d.a-z])`,
  "g",
);
const FRACTION_SIZE = new RegExp(String.raw`(?<![\d.])(\d+)\/(\d+)\s*(${UNIT_ALTERNATION})(?![a-z0-9])`, "g");
const PLAIN_SIZE = new RegExp(String.raw`(?<![\d./])${NUM}\s*(${UNIT_ALTERNATION})(?![a-z0-9])`, "g");
const HALF_GALLON = /\b(?:half|hlf)\s*gal(?:lon)?s?\b/g;
const BARE_GALLON = /\bgal(?:lon)?s?\b/g;
const GALLON_LITRES = 3.78541;

const PACK_SUFFIX = /(?<![\d.])(\d+)\s*(?:pk|pks|pkt|pkts|pack|packs|pce|pces|pcs|pc|ct|cnt|count)(?![a-z0-9])/g;
const PLURAL_S_COUNT = /(?<![\d.])(\d+)s(?![a-z0-9])/g;
const X_COUNT = /(?<![a-z0-9.])x\s*(\d+)(?![\d.a-z])/g;
const COUNT_X = /(?<![\d.])(\d+)\s*x(?![a-z0-9])/g;
const DOZEN = /(?:(?<![\d.])(\d+)\s*|\b(half)\s+)?(?<![a-z])(?:dozen|doz|dz)(?![a-z])/g;
const DOZEN_COUNT = 12;
/** "24 ROLL", "60 TABLETS" — the number counts items; the noun stays in the text. */
const COUNT_NOUN =
  /(?<![\d.])(\d+)\s*(rolls?|tablets?|tabs?|capsules?|caps|pods?|sachets?|bags?|teabags?|wipes?|nappies|bars?|slices?|eggs|pieces?|serves?|sticks?|cans?|tins?|bottles?|stubbies|pouches)(?![a-z])/g;
const SHEETS_OR_PLY = /(?<![\d.])\d+\s*(?:sheets?|ply|shts?)(?![a-z])/g;
const LENGTH = /(?<![\d.])\d+(?:\.\d+)?\s*(?:mm|cm|m|metres?|meters?)(?![a-z])/g;
const PER_WEIGHT = /\b(?:per|p)\s*(?:kg|kilo|lb)\b/g;
const LOOSE_WEIGHT_UNIT = /\b(?:kg|kgs|kilo|lb|lbs)\b/g;
/** Cheap pre-check: could any of the word-only size patterns below apply? */
const SIZE_WORD_HINT = /\b(?:half|hlf|gal|gals|gallons?|dozen|doz|dz|ea|each|per|p|kg|kgs|kilo|lb|lbs)\b|dozen|doz|dz/;
const EACH = /\b(?:ea|each)\b/g;

/** Unit prices ("@ $3.90/KG", "$1.20/100G") and money amounts; handled before punctuation is stripped. */
const UNIT_PRICE = /@?\s*[$£€]?\s*\d+(?:\.\d+)?\s*\/\s*(kg|kilo|lb|100\s*g|100\s*ml|ea|each|l|litre)\b/g;
const AT_PRICE = /@\s*[$£€]?\s*\d+(?:\.\d+)?/g;
const MONEY = /[$£€]\s*\d+(?:[.,]\d+)?/g;

interface SizeExtraction {
  text: string;
  size: ReceiptSize | null;
  packCount: number | null;
  /** The pack count was written as a multiplier ("6X375ML", "X6"), so the size is per item. */
  packFromMultiplier: boolean;
  perKg: boolean;
}

/** Units a pack's net weight is printed in. */
const MASS_SIZE_UNITS: ReadonlySet<Unit> = new Set<Unit>(["g", "kg"]);

function roundSize(quantity: number, unit: Unit): number {
  if (unit === "l" || unit === "kg") return Math.round(quantity * 1000) / 1000;
  return quantity >= 10 ? Math.round(quantity) : Math.round(quantity * 10) / 10;
}

function toSize(amount: number, writtenUnit: string): ReceiptSize | null {
  const def = SIZE_UNITS.get(writtenUnit.replace(/\s+/g, " ")) ?? SIZE_UNITS.get(writtenUnit.replace(/\s+/g, ""));
  if (!def || !Number.isFinite(amount) || amount <= 0) return null;
  return { quantity: roundSize(amount * def.factor, def.unit), unit: def.unit };
}

function positiveInt(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Remove unit prices and money amounts from the raw (lower-cased) line. */
function stripPrices(lower: string): { text: string; perKg: boolean } {
  if (!/[\d$£€@×]/.test(lower)) return { text: lower, perKg: false };
  let perKg = false;
  const text = lower
    .replace(/×/g, " x ")
    .replace(UNIT_PRICE, (_match, unit: string) => {
      if (/^(kg|kilo|lb)$/.test(unit)) perKg = true;
      return " ";
    })
    .replace(AT_PRICE, " ")
    .replace(MONEY, " ");
  return { text, perKg };
}

/** US "2% milk" means reduced fat, "1% milk" low fat; other percentages are noise. */
function rewritePercentages(text: string): string {
  if (!text.includes("%")) return text;
  return text
    .replace(/(?<![\d.])2%(?=\s+milk\b)/g, "reduced fat")
    .replace(/(?<![\d.])1%(?=\s+milk\b)/g, "low fat")
    .replace(/(?<![\d.])\d+(?:\.\d+)?%/g, " ");
}

/** Sizes and counts written with digits: "2L", "6X375ML", "1/2 GAL", "6PK", "12S", "X6", "24 ROLL". */
function extractNumericSizes(input: string, found: SizeExtraction): string {
  const setSize = (next: ReceiptSize | null) => {
    if (found.size === null) found.size = next;
  };
  const setPack = (n: number | null, multiplier: boolean) => {
    if (n === null || found.packCount !== null) return;
    found.packCount = n;
    found.packFromMultiplier = multiplier;
  };
  const multipack = (amount: string, unit: string, count: string) => {
    if (found.size === null) {
      setSize(toSize(Number(amount), unit));
      setPack(positiveInt(count), true);
    }
    return " ";
  };
  const pack = (_m: string, count: string) => {
    setPack(positiveInt(count), false);
    return " ";
  };
  const multiplierPack = (_m: string, count: string) => {
    setPack(positiveInt(count), true);
    return " ";
  };
  return input
    .replace(MULTIPACK_COUNT_FIRST, (_m, count: string, amount: string, unit: string) => multipack(amount, unit, count))
    .replace(MULTIPACK_SIZE_FIRST, (_m, amount: string, unit: string, count: string) => multipack(amount, unit, count))
    .replace(FRACTION_SIZE, (_m, num: string, den: string, unit: string) => {
      if (Number(den) > 0) setSize(toSize(Number(num) / Number(den), unit));
      return " ";
    })
    .replace(PLAIN_SIZE, (_m, amount: string, unit: string) => {
      setSize(toSize(Number(amount), unit));
      return " ";
    })
    .replace(PACK_SUFFIX, pack)
    .replace(PLURAL_S_COUNT, pack)
    .replace(X_COUNT, multiplierPack)
    .replace(COUNT_X, multiplierPack)
    .replace(SHEETS_OR_PLY, " ")
    .replace(COUNT_NOUN, (_m, count: string, noun: string) => {
      setPack(positiveInt(count), false);
      return ` ${noun} `;
    })
    .replace(LENGTH, " ");
}

/**
 * Pull sizes, pack counts and per-kg markers out of normalised text. The
 * digit-based patterns only run when there are digits (catalog aliases
 * rarely have any, which keeps index building fast).
 */
function extractSizes(input: string): SizeExtraction {
  const found: SizeExtraction = { text: input, size: null, packCount: null, packFromMultiplier: false, perKg: false };
  const numeric = /\d/.test(input) ? extractNumericSizes(input, found) : input;
  if (!SIZE_WORD_HINT.test(numeric)) {
    found.text = numeric;
    return found;
  }
  found.text = numeric
    .replace(HALF_GALLON, () => {
      found.size ??= { quantity: roundSize(GALLON_LITRES / 2, "l"), unit: "l" };
      return " ";
    })
    .replace(BARE_GALLON, () => {
      found.size ??= { quantity: roundSize(GALLON_LITRES, "l"), unit: "l" };
      return " ";
    })
    .replace(DOZEN, (_m, count: string | undefined, half: string | undefined) => {
      const dozens = half ? 0.5 : (positiveInt(count) ?? 1);
      found.packCount ??= Math.round(dozens * DOZEN_COUNT);
      return " ";
    })
    .replace(EACH, " ")
    .replace(PER_WEIGHT, () => {
      found.perKg = true;
      return " ";
    })
    .replace(LOOSE_WEIGHT_UNIT, () => {
      found.perKg = true;
      return " ";
    });
  return found;
}

// ─── Token rewriting ────────────────────────────────────────────────────────

interface Token {
  text: string;
  /** Produced by a phrase expansion: never re-expanded, brand-stripped or dropped as noise. */
  locked: boolean;
}

interface PhraseRule {
  from: string[];
  to: string[];
}

/** Phrase rules keyed by their first word, longest phrase first. */
type PhraseTable = ReadonlyMap<string, readonly PhraseRule[]>;

function compilePhrases(pairs: ReadonlyArray<readonly [string, string]>): PhraseTable {
  const table = new Map<string, PhraseRule[]>();
  for (const [from, to] of pairs) {
    const rule: PhraseRule = { from: from.split(" "), to: to.split(" ").filter(Boolean) };
    const bucket = table.get(rule.from[0]);
    if (bucket) bucket.push(rule);
    else table.set(rule.from[0], [rule]);
  }
  for (const bucket of table.values()) bucket.sort((a, b) => b.from.length - a.from.length);
  return table;
}

/**
 * Multi-word receipt spellings, applied before brand stripping and
 * single-word abbreviations. Some keep digits that would otherwise be
 * dropped as stray numbers ("2 minute noodles", "4 bean mix").
 */
const PHRASE_EXPANSIONS = compilePhrases([
  ["2 minute", "instant"],
  ["two minute", "instant"],
  ["3 bean", "three bean"],
  ["4 bean", "four bean"],
  ["5 bean", "five bean"],
  ["7 up", "7up"],
  ["chick pea", "chickpeas"],
  ["chick peas", "chickpeas"],
  ["chk pea", "chickpeas"],
  ["chk peas", "chickpeas"],
  ["s and v", "salt and vinegar"],
  ["salt vin", "salt vinegar"],
  ["sr cream", "sour cream"],
  ["sr crm", "sour cream"],
  ["sour crm", "sour cream"],
  ["toilet tiss", "toilet paper"],
  ["toilet tis", "toilet paper"],
  ["toil tiss", "toilet paper"],
  ["free rng", "free range"],
  ["free rge", "free range"],
  ["b less", "boneless"],
  ["bone less", "boneless"],
  ["s less", "skinless"],
  ["skin less", "skinless"],
  ["l free", "lactose free"],
  ["lact free", "lactose free"],
  ["lac free", "lactose free"],
  ["g free", "gluten free"],
  ["glut free", "gluten free"],
  ["w meal", "wholemeal"],
  ["whole meal", "wholemeal"],
  ["w grain", "wholegrain"],
  ["whole grain", "wholegrain"],
  ["multi grain", "multigrain"],
  ["wm bread", "wholemeal bread"],
  ["wm flour", "wholemeal flour"],
  ["wm wraps", "wholemeal wraps"],
  ["wm wrap", "wholemeal wrap"],
  ["wm rolls", "wholemeal rolls"],
  ["wm pasta", "wholemeal pasta"],
  ["wm loaf", "wholemeal loaf"],
  ["wm spaghetti", "wholemeal spaghetti"],
  ["p nut", "peanut"],
  ["c nut", "coconut"],
  ["ev olive", "extra virgin olive"],
  ["ex virgin", "extra virgin"],
  ["x virgin", "extra virgin"],
  ["min wtr", "mineral water"],
  ["min water", "mineral water"],
  ["sw chilli", "sweet chilli"],
  ["sft drnk", "soft drink"],
  ["eng muff", "english muffins"],
  ["eng muffs", "english muffins"],
  ["eng muffin", "english muffins"],
  ["bi carb", "bicarb"],
  ["cond milk", "condensed milk"],
  ["evap milk", "evaporated milk"],
  ["ice crm", "ice cream"],
  ["dish wash", "dishwashing"],
  ["dish washing", "dishwashing"],
  ["dish washer", "dishwasher"],
  ["pot set", "pot set"],
  ["tom yum", "tom yum"],
  ["yoghurt pots", "yoghurt pots"],
  ["special k", "special k"],
  ["random weight", ""],
  ["pre packed", ""],
  ["pre pack", ""],
]);

/** Store-owned brands and range names, stripped anywhere in the line. */
const STORE_BRANDS = compilePhrases(
  [
    "woolworths",
    "woolies",
    "ww",
    "wow",
    "wm",
    "coles",
    "cb",
    "cc",
    "aldi",
    "iga",
    "black and gold",
    "community co",
    "homebrand",
    "hb",
    "farmdale",
    "remano",
    "bakers life",
    "specially selected",
    "tesco",
    "sainsburys",
    "sainsbury",
    "js",
    "by sainsburys",
    "taste the difference",
    "asda",
    "extra special",
    "smart price",
    "lidl",
    "waitrose",
    "morrisons",
    "m and s",
    "marks and spencer",
    "coop",
    "co op",
    "walmart",
    "great value",
    "gv",
    "kirkland signature",
    "kirkland",
    "ks",
    "costco",
    "trader joes",
    "tjs",
    "tj",
    "whole foods market",
    "whole foods",
    "365",
    "marketside",
    "market pantry",
    "good and gather",
    "kroger",
    "private selection",
    "simple truth",
    "signature select",
    "countdown",
    "pams",
    "pak n save",
    "new world",
    "harris farm",
  ].map((b) => [b, ""] as const),
);

/** Range words that only mean "brand" at the start of a line ("GOLD KIWIFRUIT" keeps meaning otherwise). */
const LEADING_RANGE_BRANDS = compilePhrases(
  ["select", "gold", "essentials", "macro", "finest", "value", "simply", "signature", "everyday", "graze", "own brand"].map(
    (b) => [b, ""] as const,
  ),
);

/** National brands that span many product types, so they say nothing about which product it is. */
const NATIONAL_BRANDS = compilePhrases(
  [
    "dairy farmers",
    "pauls",
    "a2",
    "devondale",
    "pura",
    "norco",
    "brownes",
    "harvey fresh",
    "bega",
    "mainland",
    "kraft",
    "bulla",
    "perfect italiano",
    "south cape",
    "tasmanian heritage",
    "king island",
    "castello",
    "lemnos",
    "yoplait",
    "danone",
    "chobani",
    "jalna",
    "gippsland",
    "nestle",
    "sanitarium",
    "uncle tobys",
    "kelloggs",
    "freedom foods",
    "arnotts",
    "heinz",
    "leggos",
    "san remo",
    "barilla",
    "latina",
    "la molisana",
    "de cecco",
    "sunrice",
    "uncle bens",
    "tip top",
    "helgas",
    "abbotts",
    "burgen",
    "mighty soft",
    "golden circle",
    "masterfoods",
    "mccormick",
    "hoyts",
    "campbells",
    "massel",
    "continental",
    "knorr",
    "ayam",
    "pataks",
    "lee kum kee",
    "birds eye",
    "mccain",
    "edgell",
    "streets",
    "peters",
    "sara lee",
    "don",
    "dorsogna",
    "bertocchi",
    "hans",
    "primo",
    "steggles",
    "inghams",
    "lilydale",
    "john west",
    "sirena",
    "safcol",
    "smiths",
    "red rock deli",
    "old el paso",
    "mission",
    "schweppes",
    "kirks",
    "bundaberg",
    "cottees",
    "berri",
    "daily juice",
    "nudie",
    "cobram estate",
    "bertolli",
    "lavazza",
    "vittoria",
    "twinings",
    "lipton",
    "dilmah",
    "tetley",
    "carmans",
    "nice and natural",
    "dove",
    "palmolive",
    "nivea",
    "pantene",
    "head and shoulders",
    "tresemme",
    "garnier",
    "oral b",
    "dettol",
    "earth choice",
    "sorbent",
    "vileda",
    "pampers",
    "purina",
    "optimum",
    "advance",
    "iams",
    "royal canin",
    "friskies",
    "black hawk",
    "cravendale",
    "arla",
    "warburtons",
    "hovis",
    "kingsmill",
    "mcvities",
    "hellmanns",
    "quaker",
    "cathedral city",
    "oscar mayer",
    "tyson",
    "horizon",
    "fairlife",
    "dannon",
    "land o lakes",
    "tillamook",
    "general mills",
    "nabisco",
  ].map((b) => [b, ""] as const),
);

/**
 * Single-word receipt abbreviations → full words. Applied after brands are
 * stripped, so "WW" / "W/M" are gone before "WM" could be read as wholemeal.
 */
const ABBREVIATIONS: Record<string, string> = {
  // Dairy & eggs
  fc: "full cream",
  fcm: "full cream milk",
  mlk: "milk",
  lte: "lite",
  skm: "skim",
  yght: "yoghurt",
  yog: "yoghurt",
  yogh: "yoghurt",
  ygt: "yoghurt",
  yghrt: "yoghurt",
  yoghrt: "yoghurt",
  yogurt: "yoghurt",
  yogurts: "yoghurt",
  grk: "greek",
  natrl: "natural",
  chs: "cheese",
  chse: "cheese",
  chees: "cheese",
  chdr: "cheddar",
  ched: "cheddar",
  chedd: "cheddar",
  chedr: "cheddar",
  mozz: "mozzarella",
  mozza: "mozzarella",
  mozzar: "mozzarella",
  parm: "parmesan",
  parmsn: "parmesan",
  parmes: "parmesan",
  tsty: "tasty",
  shred: "shredded",
  shrd: "shredded",
  shredd: "shredded",
  grtd: "grated",
  btr: "butter",
  bttr: "butter",
  buttr: "butter",
  unsltd: "unsalted",
  sltd: "salted",
  crm: "cream",
  thkn: "thickened",
  thkd: "thickened",
  sr: "self raising",
  // Meat & seafood
  chkn: "chicken",
  chk: "chicken",
  chic: "chicken",
  chickn: "chicken",
  ckn: "chicken",
  chkin: "chicken",
  brst: "breast",
  smkd: "smoked",
  brest: "breast",
  bst: "breast",
  thgh: "thigh",
  thg: "thigh",
  drmstk: "drumsticks",
  drumstk: "drumsticks",
  fil: "fillet",
  fill: "fillet",
  fllt: "fillet",
  flt: "fillet",
  filt: "fillet",
  fillt: "fillet",
  fllts: "fillets",
  flts: "fillets",
  bnls: "boneless",
  bnless: "boneless",
  sknls: "skinless",
  sknless: "skinless",
  skls: "skinless",
  mnce: "mince",
  mnc: "mince",
  grnd: "ground",
  bf: "beef",
  prk: "pork",
  lmb: "lamb",
  saus: "sausages",
  sausg: "sausages",
  sausgs: "sausages",
  ssg: "sausages",
  bcn: "bacon",
  rshr: "rashers",
  rshrs: "rashers",
  stk: "steak",
  stks: "steaks",
  dcd: "diced",
  prwn: "prawns",
  prwns: "prawns",
  slmn: "salmon",
  // Produce
  toms: "tomatoes",
  tom: "tomato",
  tmto: "tomato",
  tmt: "tomato",
  tomat: "tomato",
  tomatos: "tomatoes",
  pots: "potatoes",
  pota: "potato",
  potat: "potato",
  potatos: "potatoes",
  broc: "broccoli",
  brocc: "broccoli",
  brocolli: "broccoli",
  brocoli: "broccoli",
  caps: "capsicum",
  capsic: "capsicum",
  // UK/US/NZ "peppers" are capsicums; ground pepper is never sold as "peppers".
  peppers: "capsicum",
  avo: "avocado",
  avos: "avocados",
  avoc: "avocado",
  strawb: "strawberries",
  strawbs: "strawberries",
  strwb: "strawberries",
  strawberrys: "strawberries",
  blueb: "blueberries",
  bluebs: "blueberries",
  rasp: "raspberries",
  rasps: "raspberries",
  raspb: "raspberries",
  bnna: "banana",
  bnnas: "bananas",
  mand: "mandarin",
  mands: "mandarins",
  zucc: "zucchini",
  zuc: "zucchini",
  cucu: "cucumber",
  cucmbr: "cucumber",
  lett: "lettuce",
  lettce: "lettuce",
  mush: "mushrooms",
  mushrm: "mushroom",
  mushrms: "mushrooms",
  mshrm: "mushroom",
  mshrms: "mushrooms",
  onin: "onion",
  crrt: "carrot",
  crrts: "carrots",
  cauli: "cauliflower",
  spnch: "spinach",
  cori: "coriander",
  corian: "coriander",
  coriandr: "coriander",
  corriander: "coriander",
  parsly: "parsley",
  swt: "sweet",
  veg: "vegetables",
  vege: "vegetables",
  vegie: "vegetables",
  vegies: "vegetables",
  veggie: "vegetables",
  veggies: "vegetables",
  frt: "fruit",
  grn: "green",
  rd: "red",
  yel: "yellow",
  ylw: "yellow",
  wht: "white",
  wte: "white",
  brn: "brown",
  blk: "black",
  lge: "large",
  lrg: "large",
  lg: "large",
  sml: "small",
  med: "medium",
  xl: "extra large",
  xlge: "extra large",
  bn: "bunch",
  bnch: "bunch",
  pnnt: "punnet",
  // Bakery
  brd: "bread",
  whlml: "wholemeal",
  wmeal: "wholemeal",
  wml: "wholemeal",
  whlmeal: "wholemeal",
  wholeml: "wholemeal",
  mgrain: "multigrain",
  multigr: "multigrain",
  mltgrn: "multigrain",
  mgrn: "multigrain",
  wgrain: "wholegrain",
  srdgh: "sourdough",
  sourdo: "sourdough",
  sdough: "sourdough",
  slcd: "sliced",
  slc: "sliced",
  slced: "sliced",
  sndwch: "sandwich",
  sandw: "sandwich",
  muff: "muffins",
  muffs: "muffins",
  crois: "croissants",
  croiss: "croissants",
  bgl: "bagels",
  bgls: "bagels",
  // Pantry
  spag: "spaghetti",
  spagh: "spaghetti",
  spagetti: "spaghetti",
  fett: "fettuccine",
  lasag: "lasagne",
  lasagna: "lasagne",
  nood: "noodles",
  ndl: "noodles",
  ndls: "noodles",
  noodl: "noodles",
  inst: "instant",
  instnt: "instant",
  rce: "rice",
  bsmti: "basmati",
  basm: "basmati",
  jasm: "jasmine",
  jsmn: "jasmine",
  brwn: "brown",
  flr: "flour",
  pln: "plain",
  sgr: "sugar",
  sug: "sugar",
  cstr: "caster",
  castor: "caster",
  icng: "icing",
  bkg: "baking",
  pwdr: "powder",
  pwd: "powder",
  powd: "powder",
  vnla: "vanilla",
  ess: "essence",
  olv: "olive",
  xv: "extra virgin",
  ev: "extra virgin",
  cnla: "canola",
  vin: "vinegar",
  vngr: "vinegar",
  bals: "balsamic",
  balsmc: "balsamic",
  sce: "sauce",
  sauc: "sauce",
  pst: "paste",
  pste: "paste",
  crry: "curry",
  stck: "stock",
  cnd: "canned",
  crshd: "crushed",
  whl: "whole",
  cnut: "coconut",
  cocnt: "coconut",
  pnut: "peanut",
  pnt: "peanut",
  pnuts: "peanuts",
  pb: "peanut butter",
  hny: "honey",
  cer: "cereal",
  cerl: "cereal",
  wbix: "weetbix",
  muesl: "muesli",
  rlld: "rolled",
  chkpea: "chickpeas",
  chkpeas: "chickpeas",
  lntl: "lentils",
  lntls: "lentils",
  bkd: "baked",
  bns: "beans",
  // Frozen, drinks, snacks
  frzn: "frozen",
  froz: "frozen",
  frz: "frozen",
  fzn: "frozen",
  icecream: "ice cream",
  jce: "juice",
  juc: "juice",
  oj: "orange juice",
  aj: "apple juice",
  org: "organic",
  orgnc: "organic",
  wtr: "water",
  sprk: "sparkling",
  sprkl: "sparkling",
  spkl: "sparkling",
  sparkl: "sparkling",
  mnrl: "mineral",
  sft: "soft",
  drnk: "drink",
  kmbcha: "kombucha",
  choc: "chocolate",
  chc: "chocolate",
  chocl: "chocolate",
  choco: "chocolate",
  bis: "biscuits",
  bisc: "biscuits",
  bisk: "biscuits",
  bscts: "biscuits",
  biscs: "biscuits",
  crkrs: "crackers",
  crkr: "crackers",
  chps: "chips",
  // Household & personal care
  tp: "toilet paper",
  tlt: "toilet",
  tiss: "tissue",
  ppr: "paper",
  twl: "towel",
  twls: "towels",
  dishw: "dishwashing",
  dishwsh: "dishwashing",
  dshwsh: "dishwashing",
  dishwash: "dishwashing",
  dishwshr: "dishwasher",
  liq: "liquid",
  lqd: "liquid",
  tabs: "tablets",
  lndry: "laundry",
  ldry: "laundry",
  laund: "laundry",
  det: "detergent",
  deterg: "detergent",
  detrg: "detergent",
  cond: "conditioner",
  shamp: "shampoo",
  shmp: "shampoo",
  deod: "deodorant",
  deo: "deodorant",
  tthpst: "toothpaste",
  // Descriptors
  astd: "assorted",
  asst: "assorted",
  orig: "original",
  unsw: "unsweetened",
  unswt: "unsweetened",
  aust: "australian",
  aus: "australian",
  rf: "reduced fat",
  fr: "free range",
  gf: "gluten free",
  df: "dairy free",
  ctn: "carton",
  btl: "bottle",
};

/** Words that never help identify a product and are dropped from the cleaned text. */
const NOISE_WORDS = new Set([
  "approx",
  "aprx",
  "loose",
  "net",
  "nett",
  "prepacked",
  "prepack",
  "rw",
  "wt",
  "per",
  "ea",
  "each",
  "pk",
  "pkt",
  "pks",
  "ml",
  "mls",
  "gm",
  "gms",
  "gr",
  "kgs",
  "lt",
  "ltr",
  "oz",
  "lbs",
  "fl",
  "cl",
  "plu",
  "code",
]);

function tokenize(text: string): Token[] {
  return text
    .split(" ")
    .filter(Boolean)
    .map((t) => ({ text: t, locked: false }));
}

function matchesAt(tokens: readonly Token[], index: number, phrase: readonly string[]): boolean {
  if (index + phrase.length > tokens.length) return false;
  for (let k = 0; k < phrase.length; k++) {
    const token = tokens[index + k];
    if (token.locked || token.text !== phrase[k]) return false;
  }
  return true;
}

/** The longest rule in `table` that matches the tokens starting at `index`. */
function ruleAt(tokens: readonly Token[], index: number, table: PhraseTable): PhraseRule | undefined {
  const bucket = table.get(tokens[index].text);
  return bucket?.find((r) => matchesAt(tokens, index, r.from));
}

function applyPhraseExpansions(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    const rule = ruleAt(tokens, i, PHRASE_EXPANSIONS);
    if (rule) {
      out.push(...rule.to.map((text) => ({ text, locked: true })));
      i += rule.from.length;
    } else {
      out.push(tokens[i]);
      i += 1;
    }
  }
  return out;
}

const NUMERIC_TOKEN = /^\d+(?:\.\d+)?$|^\d+\/\d+$/;
const CENTS_TOKEN = /^\d+c$/;

function isNumericToken(text: string): boolean {
  return NUMERIC_TOKEN.test(text);
}

/** Long, distinctive store names, matched with one OCR error allowed. */
const MISREAD_STORE_NAMES = ["woolworths", "sainsburys", "morrisons", "countdown", "waitrose"];

/** True when `a` and `b` differ by at most one substitution, insertion or deletion. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function isMisreadStoreName(word: string): boolean {
  return /^[a-z]{8,12}$/.test(word) && !MISREAD_STORE_NAMES.includes(word) && MISREAD_STORE_NAMES.some((name) => withinOneEdit(word, name));
}

/**
 * Remove store brands and multi-category national brands anywhere, and
 * range words ("SELECT", "GOLD") only in the leading run. Never removes
 * everything: a line that is nothing but brand words is kept as is.
 */
function stripBrandTokens(tokens: Token[]): { tokens: Token[]; removed: string[] } {
  const removed: string[] = [];
  const out: Token[] = [];
  let leading = true;
  let i = 0;
  while (i < tokens.length) {
    const rule =
      ruleAt(tokens, i, STORE_BRANDS) ??
      ruleAt(tokens, i, NATIONAL_BRANDS) ??
      (leading ? ruleAt(tokens, i, LEADING_RANGE_BRANDS) : undefined);
    if (rule) {
      removed.push(...rule.from);
      i += rule.from.length;
      continue;
    }
    // A long store name with one misread letter ("WOOLWERTHS ART BAG") is still the store.
    if (!tokens[i].locked && isMisreadStoreName(tokens[i].text)) {
      removed.push(tokens[i].text);
      i += 1;
      continue;
    }
    // Product codes before the description don't end the leading brand run.
    if (!isNumericToken(tokens[i].text)) leading = false;
    out.push(tokens[i]);
    i += 1;
  }
  const meaningful = out.some((t) => !isNumericToken(t.text));
  return meaningful ? { tokens: out, removed } : { tokens, removed: [] };
}

/**
 * Abbreviations that are only trusted when nothing else on the line says what
 * the product is: "POTS WASHED 2KG" is potatoes, but "S/POTS MACADAMIA" is a pot
 * (pack) of macadamias. The words that may accompany them without changing that.
 */
const CONTEXTUAL_ABBREVIATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  pots: new Set([
    "washed", "brushed", "white", "red", "new", "baby", "dutch", "cream", "sebago", "desiree", "pontiac", "royal", "blue", "gold", "bag", "loose",
    "kg", "kilo", "fresh", "organic", "prepacked", "pack", "packed", "pre", "per", "each", "ea", "australian", "aussie", "local", "large", "small",
    "medium", "premium", "value", "select", "selected", "nicola", "kipfler", "coliban", "spud",
  ]),
};

function expandAbbreviations(tokens: Token[]): Token[] {
  return tokens.flatMap((token, i) => {
    if (token.locked) return [token];
    const expansion = ABBREVIATIONS[token.text];
    if (!expansion) return [token];
    const companions = CONTEXTUAL_ABBREVIATIONS[token.text];
    if (companions && tokens.some((other, j) => j !== i && /^[a-z]{3,}$/.test(other.text) && !companions.has(other.text))) return [token];
    return expansion.split(" ").map((text) => ({ text, locked: false }));
  });
}

function dropNoise(tokens: Token[]): Token[] {
  return tokens
    .map((token) => (/^spf\d+$/.test(token.text) ? { ...token, text: "spf" } : token))
    .filter((token) => {
      if (token.locked) return token.text.length > 0;
      if (isNumericToken(token.text) || CENTS_TOKEN.test(token.text)) return false;
      if (NOISE_WORDS.has(token.text)) return false;
      return token.text.length > 1;
    });
}

// ─── Cleaning ───────────────────────────────────────────────────────────────

/**
 * Clean a raw receipt line: normalise, pull out size / pack count / per-kg,
 * expand receipt abbreviations, strip store and multi-category brands,
 * product codes, prices and stray numbers.
 *
 * "W/M FULL CREAM 2L" → { cleaned: "full cream", size: { 2, "l" } }
 * "COKE 24X375ML"     → { cleaned: "coke", size: { 375, "ml" }, packCount: 24 }
 * "SAUSAGES 8PK 500G" → { cleaned: "sausages", size: { 500, "g" }, packCount: 8, sizeIsTotal: true }
 * "BANANAS KG"        → { cleaned: "bananas", perKg: true }
 */
export function cleanReceiptText(raw: string, options: CleanOptions = {}): CleanedReceiptText {
  const stripBrands = options.stripBrands ?? true;
  const priced = stripPrices(raw.toLowerCase());
  const normalized = rewritePercentages(normalizeText(priced.text));
  const extracted = extractSizes(normalized);

  let tokens = applyPhraseExpansions(tokenize(extracted.text));
  let removedBrandTokens: string[] = [];
  if (stripBrands) {
    const stripped = stripBrandTokens(tokens);
    tokens = stripped.tokens;
    removedBrandTokens = stripped.removed;
  }
  tokens = dropNoise(expandAbbreviations(tokens));

  const words = tokens.map((t) => t.text);
  const { size, packCount } = extracted;
  return {
    cleaned: words.join(" "),
    tokens: words,
    size,
    packCount,
    sizeIsTotal: size !== null && packCount !== null && !extracted.packFromMultiplier && MASS_SIZE_UNITS.has(size.unit),
    perKg: priced.perKg || extracted.perKg,
    removedBrandTokens,
  };
}

// ─── Non-item lines ─────────────────────────────────────────────────────────

/** Words that may make up a non-product line ("CARRY BAG", "CONTAINER DEPOSIT", "GIFT CARD"). */
const NON_ITEM_VOCABULARY = new Set([
  "bag",
  "bags",
  // Reusable bag ranges ("Woolworths Art Bag", "Eco Tote").
  "art",
  "eco",
  "tote",
  "jute",
  "hessian",
  "carry",
  "carrier",
  "reusable",
  "paper",
  "plastic",
  "shopping",
  "calico",
  "green",
  "levy",
  "fee",
  "fees",
  "for",
  "life",
  "the",
  "of",
  "and",
  "bottle",
  "container",
  "can",
  "cds",
  "deposit",
  "refund",
  "scheme",
  "gift",
  "card",
  "giftcard",
  "voucher",
  "coupon",
  "delivery",
  "service",
  "packing",
  "pickup",
  "pick",
  "up",
  "surcharge",
  "rounding",
  "discount",
  "promotional",
  "promo",
  "promotion",
  "saving",
  "savings",
  "subtotal",
  "sub",
  "total",
  "balance",
  "due",
  "change",
  "cash",
  "eftpos",
  "credit",
  "debit",
  "visa",
  "mastercard",
  "amex",
  "tendered",
  "payment",
  "gst",
  "tax",
  "points",
  "rewards",
  "member",
  "price",
  "flybuys",
  "clubcard",
  "nectar",
  "charge",
]);

/** At least one of these must appear for a line to be treated as a non-item. */
const NON_ITEM_TRIGGERS = new Set([
  "bag",
  "bags",
  "deposit",
  "refund",
  "cds",
  "gift",
  "giftcard",
  "voucher",
  "coupon",
  "fee",
  "fees",
  "levy",
  "surcharge",
  "rounding",
  "discount",
  "subtotal",
  "total",
  "change",
  "cash",
  "eftpos",
  "tendered",
  "payment",
  "gst",
  "tax",
  "points",
  "rewards",
  "flybuys",
  "clubcard",
  "nectar",
  "savings",
]);

/**
 * True for receipt lines that aren't products: carry bags, bottle/container
 * deposits, gift cards, fees, discounts and payment/total lines. "BIN BAGS"
 * and "TEA BAGS" are products and return false. Pass `cleaned` when the
 * line has already been through `cleanReceiptText` to avoid re-cleaning.
 */
export function isNonItemLine(raw: string, cleaned: CleanedReceiptText = cleanReceiptText(raw)): boolean {
  const cleanedWords = cleaned.tokens;
  const words = cleanedWords.length > 0 ? cleanedWords : normalizeText(raw).split(" ").filter(Boolean);
  const content = words.filter((w) => !isNumericToken(w) && !CENTS_TOKEN.test(w));
  if (content.length === 0) return false;
  return content.every((w) => NON_ITEM_VOCABULARY.has(w)) && content.some((w) => NON_ITEM_TRIGGERS.has(w));
}
