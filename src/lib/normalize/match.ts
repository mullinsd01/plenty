/**
 * Product matching: resolve free text (receipt lines, typed items, recipe
 * ingredient names) to a catalog product.
 *
 * Matching is layered, strongest evidence first:
 *   1. the household's own remembered mapping for this exact receipt text;
 *   2. an exact name/alias hit after cleaning and singularising;
 *   3. token similarity, weighted by how rare (and so how telling) each word
 *      is, tolerant of truncated words ("STRAWBERRI") and typos, aware of the
 *      head noun ("MILK CHOC" is chocolate, "CHOC MILK" is milk);
 *   4. a character-trigram fallback for run-together or badly mangled text.
 *
 * Indexes are built lazily once per product set. Pure and deterministic.
 */

import { CATALOG } from "@/lib/catalog/products";
import type { CatalogProduct, ProductMatch } from "@/lib/catalog/types";
import { convert, isContainerUnit, unitDimension, type Unit } from "@/lib/units";
import {
  aliasKey,
  cleanReceiptText,
  isNonItemLine,
  normalizeText,
  sentenceCase,
  singularize,
  singularizePhrase,
  type CleanedReceiptText,
} from "@/lib/normalize/text";

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Matches at or above this are trusted without asking (canonical name, product key). */
export const ACCEPT_MATCH_SCORE = 0.75;
/** `matchProduct` returns nothing weaker than this. */
export const MIN_MATCH_SCORE = 0.45;
/** `matchProductCandidates` lists nothing weaker than this. */
export const MIN_CANDIDATE_SCORE = 0.3;

export const HOUSEHOLD_ALIAS_SCORE = 0.99;
export const EXACT_NAME_SCORE = 0.97;
export const EXACT_ALIAS_SCORE = 0.96;
/** Exact once descriptive words ("fresh", "organic", "loose") are ignored. */
export const EXACT_CORE_SCORE = 0.94;
/** Token scores are scaled into this ceiling so they rank below exact hits. */
const FUZZY_SCALE = 0.93;
const FUZZY_CAP = 0.95;

/** The query's head noun is the entry's head noun ("… chocolate" ↔ "milk chocolate"). */
const HEAD_MATCH_BONUS = 0.06;
/** The query's head noun is foreign to the product, or the entry's head noun is absent from the query. */
const HEAD_MISS_PENALTY = 0.08;
/** Entry words appear in the same order in the query. */
const ORDER_BONUS = 0.04;
/** Each meaningful query word the product can't explain ("APPLE PIE" is not a meat pie). */
const UNEXPLAINED_WORD_PENALTY = 0.05;
const MAX_UNEXPLAINED_PENALTIES = 2;
/** Different, non-substitute products scoring within this of a fuzzy best match make it ambiguous. */
const AMBIGUITY_MARGIN = 0.03;
const AMBIGUITY_PENALTY = 0.1;

/** Descriptive words ("fresh", "organic", "pack") carry this share of their weight. */
const DESCRIPTOR_WEIGHT = 0.35;
/** Variant words ("lite", "salt reduced", "crunchy") cost only this share when the product doesn't mention them. */
const MODIFIER_UNMATCHED_WEIGHT = 0.3;
/** Weight of words the catalog has never seen — usually brands. */
const UNKNOWN_TOKEN_WEIGHT = 0.8;

const PREFIX_MIN_LENGTH = 4;
/** A truncated word must cover at least this share of the word it abbreviates. */
const PREFIX_MIN_COVERAGE = 0.45;
const MAX_PREFIX_CANDIDATES = 8;
const PREFIX_STRENGTH_SINGLE = 0.92;
const PREFIX_STRENGTH_FEW = 0.85;
const PREFIX_STRENGTH_MANY = 0.75;
const FEW_PREFIX_CANDIDATES = 3;

/**
 * A known food the catalog doesn't stock ("duck", "scallops") is as telling
 * as a rare catalog word: "duck breast" must not read as a brand of breast.
 */
const UNSTOCKED_FOOD_WEIGHT = 4;
/** Penalty per unstocked food word the product can't explain ("turkey mince" is not beef mince). */
const UNSTOCKED_FOOD_PENALTY = 0.12;

/**
 * Foods the catalog stocks in one form only (turkey breast): a line naming
 * them must not drift to another product ("turkey mince" is not beef mince,
 * "turkey drumsticks" are not chicken drumsticks), so a product that never
 * mentions the word pays this much.
 */
const DEFINING_FOODS: ReadonlySet<string> = new Set(["turkey"]);
const DEFINING_WORD_PENALTY = 0.25;
/** …and a token-similarity match on such a word ("turkey stuffing" ~ turkey breast) is never better than plausible; only a name or alias hit is trusted. */
const DEFINING_FUZZY_CAP = 0.7;

const TYPO_MIN_LENGTH = 4;
const TYPO_STRENGTH_ONE_EDIT = 0.9;
const TYPO_STRENGTH_TWO_EDITS = 0.8;
const TYPO_TWO_EDITS_MIN_LENGTH = 6;
const TYPO_TRIGRAM_MIN_SIMILARITY = 0.3;

/** Run the phrase-trigram fallback when token matching peaks below this. */
const TRIGRAM_FALLBACK_BELOW = 0.6;
const TRIGRAM_MIN_SIMILARITY = 0.5;
const TRIGRAM_SCALE = 0.85;

/** Confidence for lines recognised as non-products (bags, deposits). */
const NON_ITEM_CONFIDENCE = 0.9;
/** Confidence for product lines Plenty couldn't match. */
const UNMATCHED_CONFIDENCE = 0.3;
const EMPTY_LINE_CONFIDENCE = 0.05;

// ─── Vocabulary classes (singular forms) ────────────────────────────────────

const STOPWORDS = new Set(["and", "with", "of", "in", "the", "a", "an", "for", "or", "to", "on", "at", "by", "from", "n", "x", "per"]);

/** Words that describe packaging, provenance or grade rather than the product. */
const DESCRIPTORS = new Set([
  "fresh",
  "organic",
  "australian",
  "aussie",
  "british",
  "irish",
  "local",
  "imported",
  "premium",
  "quality",
  "value",
  "family",
  "bulk",
  "loose",
  "prepacked",
  "pack",
  "packet",
  "bag",
  "box",
  "tray",
  "tub",
  "punnet",
  "bunch",
  "bottle",
  "can",
  "tin",
  "jar",
  "pouch",
  "pot",
  "sachet",
  "carton",
  "block",
  "large",
  "small",
  "medium",
  "jumbo",
  "mini",
  "extra",
  "style",
  "homestyle",
  "traditional",
  "classic",
  "deluxe",
  "gourmet",
  "selected",
  "select",
  "new",
  "variety",
  "assorted",
  "range",
  "farm",
  "washed",
  "brushed",
  "ripe",
  "seedless",
  "pitted",
  "chilled",
  "boneless",
  "skinless",
  "skin",
  "bone",
  "trimmed",
  "lean",
  "piece",
  "portion",
  "twin",
  "multipack",
  "economy",
  "size",
  "grade",
  "class",
  "cut",
  // Store departments printed before the product ("COLES BAKERY WHITE LOAF", "DELI HAM").
  "bakery",
  "deli",
  "butcher",
  // Recipes asking for what's left over ("day-old bread", "leftover rice").
  "leftover",
  "stale",
  "day",
  "old",
]);

/**
 * Real foods (singular) the catalog doesn't stock, whose word decides what the
 * thing is. Recipes (especially AI-written ones) name them freely, so they
 * must never be read as a brand, a truncation or a typo of a catalog word:
 * "scallops" is not "scallions", "mussels" not "morsels", "turkey mince" not
 * beef mince. Flavour words (fruit, spirits, cheese varieties) are left out
 * on purpose: "APRICOT JAM" and "BRANDY CUSTARD" are still jam and custard.
 * Catalog words always win (a household's own "Duck breast" product, or
 * "CHARD" as a receipt's truncated chardonnay), so words the catalog knows
 * or abbreviates don't belong here.
 */
const UNSTOCKED_FOODS = new Set([
  // Meat, poultry, game and cuts
  "duck",
  "turkey",
  "venison",
  "kangaroo",
  "goat",
  "rabbit",
  "quail",
  "pheasant",
  "brisket",
  "shank",
  "hock",
  "oxtail",
  "tripe",
  "liver",
  // Seafood
  "calamari",
  "octopus",
  "scallop",
  "mussel",
  "clam",
  "pipi",
  "crab",
  "lobster",
  "crayfish",
  "yabby",
  "sardine",
  "mackerel",
  "trout",
  "swordfish",
  // Proteins and ferments
  "paneer",
  "tempeh",
  "seitan",
  "edamame",
  "kimchi",
  "sauerkraut",
  // Grains, flours and starches
  "tapioca",
  "semolina",
  "polenta",
  "buckwheat",
  "spelt",
  "barley",
  "farro",
  "bulgur",
  "millet",
  // Vegetables
  "artichoke",
  "fennel",
  "parsnip",
  "turnip",
  "swede",
  "celeriac",
  "radish",
  "okra",
  "watercress",
  "silverbeet",
  "kohlrabi",
  "jackfruit",
  "cassava",
  "taro",
  "plantain",
  // Pantry, spices and condiments
  "caper",
  "tartar",
  "nutritional",
  "gelatine",
  "gelatin",
  "agar",
  "lard",
  "suet",
  "ghee",
  "marsala",
  "mirin",
  "harissa",
  "gochujang",
  "sambal",
  "tamarind",
  "sumac",
  "saffron",
  "cardamom",
  "fenugreek",
  "allspice",
  "juniper",
  "caraway",
  "wasabi",
  "nori",
  "dashi",
  "molasses",
  "horseradish",
]);

/** Variant words: full weight when the product mentions them, cheap to leave unmatched. */
const MODIFIERS = new Set([
  "reduced",
  "low",
  "fat",
  "free",
  "lite",
  "light",
  "full",
  "no",
  "added",
  "salt",
  "sugar",
  "sodium",
  "zero",
  "diet",
  "original",
  "plain",
  "natural",
  "unsweetened",
  "sweetened",
  "creamy",
  "smooth",
  "crunchy",
  "chunky",
  "mild",
  "hot",
  "spicy",
  "thin",
  "thick",
  "raw",
  "cooked",
  "unsalted",
  "salted",
  "roasted",
  "toasted",
  "quick",
  // How it is cut: "SHREDDED HAM" is ham, "GRATED CHEESE" is cheese.
  "shredded",
  "grated",
]);

// ─── Index ──────────────────────────────────────────────────────────────────

interface Entry {
  productIndex: number;
  isName: boolean;
  /** Singular tokens joined by spaces. */
  key: string;
  tokens: string[];
  head: string | null;
}

interface ProductIndex {
  products: CatalogProduct[];
  bySlug: Map<string, number>;
  entries: Entry[];
  entriesByProduct: Entry[][];
  vocabByProduct: Array<Set<string>>;
  exact: Map<string, Entry>;
  postings: Map<string, number[]>;
  weights: Map<string, number>;
  /** Every spelling seen in names/aliases (plural and singular) → canonical singular token. */
  surfaces: Map<string, string>;
  sortedSurfaces: string[];
  /** Built on first use: most lines never need typo or trigram matching. */
  typoIndex: TrigramIndex<string> | null;
  phraseIndex: TrigramIndex<number> | null;
}

/** Character trigram → items containing it, plus each item's trigram count. */
interface TrigramIndex<T> {
  byGram: Map<string, T[]>;
  gramCount: Map<T, number>;
}

function isDescriptor(token: string): boolean {
  return DESCRIPTORS.has(token);
}

function isModifier(token: string): boolean {
  return MODIFIERS.has(token);
}

/** The noun a phrase is about: its last word that isn't a descriptor or modifier. */
function headOf(tokens: readonly string[]): string | null {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!isDescriptor(tokens[i]) && !isModifier(tokens[i])) return tokens[i];
  }
  return tokens.length > 0 ? tokens[tokens.length - 1] : null;
}

function trigrams(word: string): string[] {
  const padded = `^${word}$`;
  const grams: string[] = [];
  for (let i = 0; i + 3 <= padded.length; i++) grams.push(padded.slice(i, i + 3));
  return [...new Set(grams)];
}

function pushPosting<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (list[list.length - 1] !== value) list.push(value);
}

/** Surface words and singular tokens of a name/alias, run through the same cleaning as receipt text. */
function phraseTokens(phrase: string): { surfaces: string[]; tokens: string[] } {
  const surfaces = cleanReceiptText(phrase, { stripBrands: false }).tokens.filter((t) => !STOPWORDS.has(t));
  return { surfaces, tokens: surfaces.map(singularize) };
}

function buildIndex(products: CatalogProduct[]): ProductIndex {
  const entries: Entry[] = [];
  const entriesByProduct: Entry[][] = products.map(() => []);
  const vocabByProduct: Array<Set<string>> = products.map(() => new Set<string>());
  const exact = new Map<string, Entry>();
  const postings = new Map<string, number[]>();
  const surfaces = new Map<string, string>();
  const bySlug = new Map<string, number>();

  products.forEach((product, productIndex) => {
    bySlug.set(product.slug, productIndex);
    const seen = new Set<string>();
    const phrases = [product.name, ...product.aliases];
    phrases.forEach((phrase, phraseIndex) => {
      const parsed = phraseTokens(phrase);
      if (parsed.tokens.length === 0) return;
      const key = parsed.tokens.join(" ");
      if (seen.has(key)) return;
      seen.add(key);
      const entry: Entry = { productIndex, isName: phraseIndex === 0, key, tokens: parsed.tokens, head: headOf(parsed.tokens) };
      entries.push(entry);
      entriesByProduct[productIndex].push(entry);
      parsed.tokens.forEach((token, k) => {
        vocabByProduct[productIndex].add(token);
        surfaces.set(token, token);
        surfaces.set(parsed.surfaces[k], token);
      });
    });
    for (const token of vocabByProduct[productIndex]) pushPosting(postings, token, productIndex);
  });

  // Names claim exact keys before aliases, so an alias can never shadow another product's name.
  for (const entry of entries) if (entry.isName && !exact.has(entry.key)) exact.set(entry.key, entry);
  for (const entry of entries) if (!exact.has(entry.key)) exact.set(entry.key, entry);

  const weights = new Map<string, number>();
  const n = products.length;
  for (const [token, list] of postings) {
    const idf = Math.log(1 + n / list.length);
    weights.set(token, isDescriptor(token) ? idf * DESCRIPTOR_WEIGHT : idf);
  }

  return {
    products,
    bySlug,
    entries,
    entriesByProduct,
    vocabByProduct,
    exact,
    postings,
    weights,
    surfaces,
    sortedSurfaces: [...surfaces.keys()].sort(),
    typoIndex: null,
    phraseIndex: null,
  };
}

function buildTrigramIndex<T>(items: ReadonlyArray<readonly [T, string]>): TrigramIndex<T> {
  const byGram = new Map<string, T[]>();
  const gramCount = new Map<T, number>();
  for (const [item, text] of items) {
    const grams = trigrams(text);
    gramCount.set(item, grams.length);
    for (const gram of grams) {
      const list = byGram.get(gram);
      if (list) list.push(item);
      else byGram.set(gram, [item]);
    }
  }
  return { byGram, gramCount };
}

/** Trigram index over vocabulary words, for typo tolerance. */
function typoIndexOf(index: ProductIndex): TrigramIndex<string> {
  index.typoIndex ??= buildTrigramIndex(
    [...index.postings.keys()].filter((t) => t.length >= TYPO_MIN_LENGTH).map((t) => [t, t] as const),
  );
  return index.typoIndex;
}

/** Trigram index over whole names/aliases (spaces removed), for the phrase fallback. */
function phraseIndexOf(index: ProductIndex): TrigramIndex<number> {
  index.phraseIndex ??= buildTrigramIndex(index.entries.map((entry, id) => [id, entry.tokens.join("")] as const));
  return index.phraseIndex;
}

let catalogIndex: ProductIndex | null = null;
const extraIndexes = new WeakMap<readonly CatalogProduct[], ProductIndex>();

/** Catalog + household products (household products win on slug clashes), built once per array. */
function indexFor(extraProducts: readonly CatalogProduct[] | undefined): ProductIndex {
  if (!extraProducts || extraProducts.length === 0) {
    catalogIndex ??= buildIndex(CATALOG);
    return catalogIndex;
  }
  const cached = extraIndexes.get(extraProducts);
  if (cached) return cached;
  const extraSlugs = new Set(extraProducts.map((p) => p.slug));
  const index = buildIndex([...extraProducts, ...CATALOG.filter((p) => !extraSlugs.has(p.slug))]);
  extraIndexes.set(extraProducts, index);
  return index;
}

// ─── Query resolution ───────────────────────────────────────────────────────

interface QueryToken {
  surface: string;
  /** Canonical vocabulary tokens this word may stand for (empty = unknown word). */
  canon: string[];
  /** 0–1: 1 for an exact word, lower for truncations and typos. */
  strength: number;
  weight: number;
  modifier: boolean;
  descriptor: boolean;
  /** A real food the catalog doesn't stock (see UNSTOCKED_FOODS). */
  unstocked: boolean;
}

/** Variant phrases that describe a recipe tweak, not a different product. */
const VARIANT_PHRASES: string[][] = [
  ["no", "added", "salt"],
  ["no", "added", "sugar"],
  ["salt", "reduced"],
  ["reduced", "salt"],
  ["low", "salt"],
  ["low", "sodium"],
  ["reduced", "sodium"],
];

function dropVariantPhrases(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const phrase = VARIANT_PHRASES.find((p) => p.every((word, k) => tokens[i + k] === word));
    if (phrase) {
      i += phrase.length;
    } else {
      out.push(tokens[i]);
      i += 1;
    }
  }
  return out;
}

/** Content tokens of a cleaned line: stopwords and variant phrases removed, singularised. */
function queryWords(cleaned: CleanedReceiptText): { surfaces: string[]; tokens: string[] } {
  const surfaces = dropVariantPhrases(cleaned.tokens.filter((t) => !STOPWORDS.has(t)));
  return { surfaces, tokens: surfaces.map(singularize) };
}

function lowerBound(sorted: readonly string[], target: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Vocabulary words a truncated receipt word could be the start of ("STRAWBERRI" → strawberry). */
function prefixCandidates(index: ProductIndex, surface: string): string[] {
  const found = new Set<string>();
  for (let i = lowerBound(index.sortedSurfaces, surface); i < index.sortedSurfaces.length; i++) {
    const candidate = index.sortedSurfaces[i];
    if (!candidate.startsWith(surface)) break;
    if (candidate === surface || surface.length / candidate.length < PREFIX_MIN_COVERAGE) continue;
    found.add(index.surfaces.get(candidate) ?? candidate);
    if (found.size > MAX_PREFIX_CANDIDATES) return [];
  }
  return [...found];
}

/** Optimal-string-alignment edit distance, abandoning once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, prevPrev[j - 2] + 1);
      row.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = row;
  }
  return prev[b.length];
}

/** Closest vocabulary words to a misspelt one ("ZUCHINI" → zucchini), with a match strength. */
function typoCandidates(index: ProductIndex, word: string): { canon: string[]; strength: number } | null {
  if (word.length < TYPO_MIN_LENGTH) return null;
  const typo = typoIndexOf(index);
  const grams = trigrams(word);
  const shared = new Map<string, number>();
  for (const gram of grams) {
    for (const token of typo.byGram.get(gram) ?? []) shared.set(token, (shared.get(token) ?? 0) + 1);
  }
  const maxEdits = word.length >= TYPO_TWO_EDITS_MIN_LENGTH ? 2 : 1;
  let best: string[] = [];
  let bestDistance = maxEdits + 1;
  for (const [token, count] of shared) {
    // Misspellings keep their first letter ("ZUCHINI", "BROCOLLI"); "brandy" is not "candy".
    if (token[0] !== word[0]) continue;
    const similarity = (2 * count) / (grams.length + (typo.gramCount.get(token) ?? 0));
    if (similarity < TYPO_TRIGRAM_MIN_SIMILARITY) continue;
    const distance = editDistance(word, token, maxEdits);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = [token];
    } else if (distance === bestDistance && distance <= maxEdits) {
      best.push(token);
    }
  }
  if (best.length === 0 || bestDistance > maxEdits) return null;
  return { canon: best.sort(), strength: bestDistance <= 1 ? TYPO_STRENGTH_ONE_EDIT : TYPO_STRENGTH_TWO_EDITS };
}

function resolveToken(index: ProductIndex, surface: string, singular: string): QueryToken {
  const base = { surface, modifier: isModifier(singular), descriptor: isDescriptor(singular), unstocked: false };
  const known = index.surfaces.get(surface) ?? index.surfaces.get(singular);
  if (known) return { ...base, canon: [known], strength: 1, weight: index.weights.get(known) ?? UNKNOWN_TOKEN_WEIGHT };

  const prefixed = surface.length >= PREFIX_MIN_LENGTH ? prefixCandidates(index, surface) : [];
  if (prefixed.length > 0) {
    const strength =
      prefixed.length === 1
        ? PREFIX_STRENGTH_SINGLE
        : prefixed.length <= FEW_PREFIX_CANDIDATES
          ? PREFIX_STRENGTH_FEW
          : PREFIX_STRENGTH_MANY;
    // A truncated descriptor or variant word ("LOOS" for "loose") is still just a descriptor or variant word.
    return {
      ...base,
      canon: prefixed,
      strength,
      weight: maxWeight(index, prefixed),
      descriptor: prefixed.every(isDescriptor),
      modifier: prefixed.every(isModifier),
    };
  }

  // A real food Plenty doesn't stock is exactly what it says, never a typo of something it does.
  if (UNSTOCKED_FOODS.has(singular)) return { ...base, canon: [], strength: 0, weight: UNSTOCKED_FOOD_WEIGHT, unstocked: true };

  const typo = typoCandidates(index, singular);
  if (typo) {
    return {
      ...base,
      canon: typo.canon,
      strength: typo.strength,
      weight: maxWeight(index, typo.canon),
      descriptor: typo.canon.every(isDescriptor),
      modifier: typo.canon.every(isModifier),
    };
  }

  return { ...base, canon: [], strength: 0, weight: UNKNOWN_TOKEN_WEIGHT };
}

function maxWeight(index: ProductIndex, tokens: readonly string[]): number {
  return Math.max(...tokens.map((t) => index.weights.get(t) ?? UNKNOWN_TOKEN_WEIGHT));
}

/**
 * The query's head noun: its last recognised word (a catalog word or an
 * unstocked food) that isn't a descriptor or modifier. An unstocked head
 * ("cream of tartar", "lamb shanks") is foreign to every product.
 */
function queryHead(tokens: readonly QueryToken[]): QueryToken | null {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if ((t.canon.length > 0 || t.unstocked) && !t.descriptor && !t.modifier) return t;
  }
  return null;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

interface Scored {
  productIndex: number;
  score: number;
  method: ProductMatch["method"];
}

function tokenIn(token: QueryToken, set: ReadonlySet<string>): boolean {
  return token.canon.some((c) => set.has(c));
}

/** Share of the query's weight the product's vocabulary explains. */
function queryCoverage(query: readonly QueryToken[], vocab: ReadonlySet<string>): number {
  let matched = 0;
  let total = 0;
  for (const token of query) {
    if (tokenIn(token, vocab)) {
      matched += token.weight * token.strength;
      total += token.weight;
    } else {
      total += token.weight * (token.modifier ? MODIFIER_UNMATCHED_WEIGHT : 1);
    }
  }
  return total > 0 ? matched / total : 0;
}

/** Strength with which the query covers one entry word (0 when absent). */
function coverStrength(query: readonly QueryToken[], word: string): number {
  let best = 0;
  for (const token of query) if (token.strength > best && token.canon.includes(word)) best = token.strength;
  return best;
}

function orderBonus(query: readonly QueryToken[], entry: Entry): number {
  if (entry.tokens.length < 2) return 0;
  let matched = 0;
  for (let k = 0; k + 1 < entry.tokens.length; k++) {
    const [a, b] = [entry.tokens[k], entry.tokens[k + 1]];
    for (let i = 0; i + 1 < query.length; i++) {
      if (query[i].canon.includes(a) && query[i + 1].canon.includes(b)) {
        matched += 1;
        break;
      }
    }
  }
  return (ORDER_BONUS * matched) / (entry.tokens.length - 1);
}

/** What scoring one entry needs to know about the query and the product it belongs to. */
interface ProductContext {
  query: readonly QueryToken[];
  head: QueryToken | null;
  vocab: ReadonlySet<string>;
  /** Share of the query the whole product explains. */
  covQ: number;
  /** Penalty for meaningful query words the product can't explain. */
  unexplainedPenalty: number;
}

function scoreEntry(index: ProductIndex, context: ProductContext, entry: Entry): number {
  const { query, head, vocab, covQ } = context;
  let matched = 0;
  let total = 0;
  for (const word of entry.tokens) {
    const weight = index.weights.get(word) ?? UNKNOWN_TOKEN_WEIGHT;
    matched += weight * coverStrength(query, word);
    total += weight;
  }
  const covE = total > 0 ? matched / total : 0;
  let score = Math.sqrt(covE * covQ);
  if (head) {
    if (entry.head && head.canon.includes(entry.head)) score += HEAD_MATCH_BONUS;
    else if (!tokenIn(head, vocab)) score -= HEAD_MISS_PENALTY;
  }
  if (entry.head && coverStrength(query, entry.head) === 0) score -= HEAD_MISS_PENALTY;
  score += orderBonus(query, entry) - context.unexplainedPenalty;
  return Math.min(FUZZY_CAP, Math.max(0, score * FUZZY_SCALE));
}

/**
 * Known, meaningful query words (not descriptors or variant words) the
 * product never mentions, plus a heavier charge for unstocked foods, which
 * no product explains.
 */
function unexplainedPenalty(query: readonly QueryToken[], vocab: ReadonlySet<string>): number {
  const unexplained = query.filter((t) => t.canon.length > 0 && !t.descriptor && !t.modifier && !tokenIn(t, vocab)).length;
  const unstocked = query.filter((t) => t.unstocked).length;
  const defining = query.some((t) => t.canon.some((c) => DEFINING_FOODS.has(c)) && !tokenIn(t, vocab));
  return (
    Math.min(unexplained, MAX_UNEXPLAINED_PENALTIES) * UNEXPLAINED_WORD_PENALTY +
    Math.min(unstocked, MAX_UNEXPLAINED_PENALTIES) * UNSTOCKED_FOOD_PENALTY +
    (defining ? DEFINING_WORD_PENALTY : 0)
  );
}

function scoreProducts(index: ProductIndex, query: readonly QueryToken[]): Scored[] {
  const candidates = new Set<number>();
  for (const token of query) for (const c of token.canon) for (const p of index.postings.get(c) ?? []) candidates.add(p);

  const head = queryHead(query);
  const contentTokens = query.filter((t) => t.canon.length > 0 && !t.descriptor).length;
  const results: Scored[] = [];
  for (const productIndex of candidates) {
    const vocab = index.vocabByProduct[productIndex];
    const covQ = queryCoverage(query, vocab);
    if (covQ === 0) continue;
    const context: ProductContext = { query, head, vocab, covQ, unexplainedPenalty: unexplainedPenalty(query, vocab) };
    const definingHit = query.some((t) => t.canon.some((c) => DEFINING_FOODS.has(c)) && tokenIn(t, vocab));
    let best = 0;
    let bestEntry: Entry | null = null;
    for (const entry of index.entriesByProduct[productIndex]) {
      const score = scoreEntry(index, context, entry);
      if (score > best) {
        best = score;
        bestEntry = entry;
      }
    }
    if (bestEntry) {
      const method = bestEntry.tokens.length === 1 && contentTokens >= 2 ? "keyword" : "fuzzy";
      results.push({ productIndex, score: definingHit ? Math.min(best, DEFINING_FUZZY_CAP) : best, method });
    }
  }
  return results;
}

/** Whole-phrase character trigram similarity, for run-together or mangled text ("WEETBIX", "CORNFLKS"). */
function trigramFallback(index: ProductIndex, tokens: readonly string[]): Scored[] {
  const grams = trigrams(tokens.join(""));
  if (grams.length === 0) return [];
  const phrases = phraseIndexOf(index);
  const shared = new Map<number, number>();
  for (const gram of grams) for (const id of phrases.byGram.get(gram) ?? []) shared.set(id, (shared.get(id) ?? 0) + 1);
  const best = new Map<number, number>();
  for (const [id, count] of shared) {
    const similarity = (2 * count) / (grams.length + (phrases.gramCount.get(id) ?? 0));
    if (similarity < TRIGRAM_MIN_SIMILARITY) continue;
    const productIndex = index.entries[id].productIndex;
    best.set(productIndex, Math.max(best.get(productIndex) ?? 0, similarity * TRIGRAM_SCALE));
  }
  return [...best].map(([productIndex, score]) => ({ productIndex, score, method: "fuzzy" as const }));
}

function exactMatch(index: ProductIndex, tokens: readonly string[]): Scored | null {
  const entry = index.exact.get(tokens.join(" "));
  if (entry) {
    return entry.isName
      ? { productIndex: entry.productIndex, score: EXACT_NAME_SCORE, method: "exact" }
      : { productIndex: entry.productIndex, score: EXACT_ALIAS_SCORE, method: "alias" };
  }
  const core = tokens.filter((t) => !isDescriptor(t));
  if (core.length === 0 || core.length === tokens.length) return null;
  const coreEntry = index.exact.get(core.join(" "));
  if (!coreEntry) return null;
  return { productIndex: coreEntry.productIndex, score: EXACT_CORE_SCORE, method: coreEntry.isName ? "exact" : "alias" };
}

function compareScored(index: ProductIndex) {
  return (a: Scored, b: Scored): number => {
    if (b.score !== a.score) return b.score - a.score;
    const pa = index.products[a.productIndex];
    const pb = index.products[b.productIndex];
    if (Boolean(pb.commonStaple) !== Boolean(pa.commonStaple)) return pb.commonStaple ? 1 : -1;
    return pa.slug < pb.slug ? -1 : pa.slug > pb.slug ? 1 : 0;
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface MatchOptions {
  /** The household's remembered mappings: `aliasKey(receipt text)` → product slug. */
  householdAliases?: ReadonlyMap<string, string>;
  /**
   * The household's own products, searched alongside the catalog (they win
   * on slug clashes). The index is cached per array instance, so pass the
   * same array for a whole receipt and treat it as immutable (build a new
   * array when the household's products change).
   */
  extraProducts?: CatalogProduct[];
}

function householdAliasMatch(index: ProductIndex, rawText: string, opts: MatchOptions | undefined): Scored | null {
  const slug = opts?.householdAliases?.get(aliasKey(rawText));
  if (!slug) return null;
  const productIndex = index.bySlug.get(slug);
  return productIndex === undefined ? null : { productIndex, score: HOUSEHOLD_ALIAS_SCORE, method: "household_alias" };
}

/** All candidate matches for already-cleaned text, best first, one per product. */
function rankCandidates(rawText: string, cleaned: CleanedReceiptText, opts: MatchOptions | undefined): { index: ProductIndex; ranked: Scored[] } {
  const index = indexFor(opts?.extraProducts);
  const found: Scored[] = [];
  const household = householdAliasMatch(index, rawText, opts);
  if (household) found.push(household);

  if (!isNonItemLine(rawText, cleaned)) {
    const words = queryWords(cleaned);
    if (words.tokens.length > 0) {
      const exact = exactMatch(index, words.tokens);
      if (exact) found.push(exact);
      const query = words.tokens.map((token, i) => resolveToken(index, words.surfaces[i], token));
      const fuzzy = scoreProducts(index, query);
      found.push(...fuzzy);
      const bestFuzzy = fuzzy.reduce((max, s) => Math.max(max, s.score), 0);
      // Text naming a real food isn't mangled, so there's nothing for the character fallback to repair.
      const mangled = !query.some((t) => t.unstocked);
      if (!exact && mangled && bestFuzzy < TRIGRAM_FALLBACK_BELOW) found.push(...trigramFallback(index, words.tokens));
    }
  }

  const byProduct = new Map<number, Scored>();
  for (const s of found) {
    const current = byProduct.get(s.productIndex);
    if (!current || s.score > current.score) byProduct.set(s.productIndex, s);
  }
  const ranked = [...byProduct.values()].sort(compareScored(index));
  return { index, ranked: penalizeAmbiguity(index, ranked) };
}

/**
 * A fuzzy best match with a near-tie from a product that isn't a substitute
 * ("BEANS": cannellini vs green beans; "CHICK": chicken vs chickpeas) is a
 * guess, so every tied candidate drops below the trusted range together.
 */
function penalizeAmbiguity(index: ProductIndex, ranked: Scored[]): Scored[] {
  const top = ranked[0];
  if (!top || (top.method !== "fuzzy" && top.method !== "keyword")) return ranked;
  const topGroup = index.products[top.productIndex].group;
  const rivals = ranked.filter((s, i) => {
    if (i === 0 || top.score - s.score > AMBIGUITY_MARGIN) return false;
    const group = index.products[s.productIndex].group;
    return !group || group !== topGroup;
  });
  if (rivals.length === 0) return ranked;
  const tied = new Set([top, ...rivals]);
  return ranked
    .map((s) => (tied.has(s) ? { ...s, score: Math.max(0, s.score - AMBIGUITY_PENALTY) } : s))
    .sort(compareScored(index));
}

function toMatch(index: ProductIndex, s: Scored): ProductMatch {
  return { product: index.products[s.productIndex], score: Math.round(s.score * 1000) / 1000, method: s.method };
}

/** Words a recipe's preparation note is made of ("finely diced", "cut into 3 cm pieces", "to serve"). */
const PREPARATION_WORDS = new Set([
  "diced",
  "chopped",
  "sliced",
  "grated",
  "minced",
  "crushed",
  "shredded",
  "peeled",
  "deseeded",
  "seeded",
  "cored",
  "halved",
  "quartered",
  "cubed",
  "torn",
  "trimmed",
  "julienned",
  "mashed",
  "juiced",
  "zested",
  "squeezed",
  "smashed",
  "bruised",
  "softened",
  "melted",
  "beaten",
  "whisked",
  "drained",
  "rinsed",
  "washed",
  "picked",
  "thawed",
  "defrosted",
  "removed",
  "discarded",
  "separated",
  "divided",
  "finely",
  "roughly",
  "coarsely",
  "thinly",
  "thickly",
  "lightly",
  "freshly",
  "loosely",
  "firmly",
  "well",
  "very",
  "cut",
  "into",
  "piece",
  "pieces",
  "chunk",
  "chunks",
  "wedge",
  "wedges",
  "ring",
  "rings",
  "strip",
  "strips",
  "floret",
  "florets",
  "matchstick",
  "matchsticks",
  "bite",
  "sized",
  "size",
  "thick",
  "thin",
  "cm",
  "mm",
  "inch",
  "lengthways",
  "crossways",
  "diagonally",
  "skin",
  "bone",
  "bones",
  "stem",
  "stems",
  "stalk",
  "stalks",
  "leaf",
  "leaves",
  "sprig",
  "sprigs",
  "separately",
  "end",
  "ends",
  "taste",
  "serve",
  "serving",
  "garnish",
  "dusting",
  "greasing",
  "frying",
  "extra",
  "plus",
  "more",
  "optional",
  "room",
  "temperature",
  "about",
]);

/**
 * Drop a trailing preparation note written after a comma, the way recipes
 * name ingredients ("brown onion, finely diced" → "brown onion"; "salt, to
 * taste" → "salt"). The note only goes when every word of it is preparation
 * language, a small word or a number, so "salt, pepper" is left alone.
 */
function withoutPreparationNote(text: string): string {
  const comma = text.indexOf(",");
  if (comma <= 0) return text;
  const head = text.slice(0, comma);
  if (normalizeText(head).length === 0) return text;
  const note = normalizeText(text.slice(comma + 1)).split(" ").filter(Boolean);
  const isPreparation = (word: string) => PREPARATION_WORDS.has(word) || STOPWORDS.has(word) || /^\d/.test(word);
  return note.length > 0 && note.every(isPreparation) ? head : text;
}

/**
 * Best catalog (or household) product for free text, or null when nothing
 * scores at least MIN_MATCH_SCORE. Scores: household alias 0.99, exact name
 * 0.97, exact alias 0.96, token/fuzzy matches up to 0.95. Treat ≥ 0.75
 * (ACCEPT_MATCH_SCORE) as confident. Non-product lines ("CARRY BAG") never
 * match unless the household mapped them. A recipe-style preparation note
 * after a comma ("onions, finely diced") is ignored.
 */
export function matchProduct(text: string, opts?: MatchOptions): ProductMatch | null {
  const query = withoutPreparationNote(text);
  const { index, ranked } = rankCandidates(query, cleanReceiptText(query), opts);
  const best = ranked[0];
  return best && best.score >= MIN_MATCH_SCORE ? toMatch(index, best) : null;
}

/** Up to `limit` plausible products for free text, best first (for "Did you mean…?" pickers). */
export function matchProductCandidates(text: string, opts?: MatchOptions, limit = 5): ProductMatch[] {
  const query = withoutPreparationNote(text);
  const { index, ranked } = rankCandidates(query, cleanReceiptText(query), opts);
  return ranked
    .filter((s) => s.score >= MIN_CANDIDATE_SCORE)
    .slice(0, Math.max(0, limit))
    .map((s) => toMatch(index, s));
}

/**
 * Stable grouping key for an item: "slug:<slug>" when the text confidently
 * matches a product, otherwise "name:<singular cleaned text>" so unmatched
 * "Kale chips" and "WW KALE CHIPS 50G" still group together.
 */
export function productKeyForText(text: string, opts?: MatchOptions): string {
  const match = matchProduct(text, opts);
  if (match && match.score >= ACCEPT_MATCH_SCORE) return `slug:${match.product.slug}`;
  const cleaned = cleanReceiptText(text).cleaned || normalizeText(text);
  return `name:${singularizePhrase(cleaned)}`;
}

// ─── Receipt lines ──────────────────────────────────────────────────────────

export interface NormalizedReceiptLine {
  rawText: string;
  /** Canonical product name when matched with score ≥ 0.75, else the sentence-cased cleaned text. */
  name: string;
  /** Best match (score ≥ MIN_MATCH_SCORE), even when below the acceptance threshold. */
  match: ProductMatch | null;
  /** Amount bought, in `unit`. */
  quantity: number;
  unit: Unit;
  /** Items in the pack (1 when not stated). */
  packCount: number;
  /** 0–1 confidence in this interpretation of the line. */
  confidence: number;
  /** False for bags, deposits, gift cards and confidently matched non-food products. */
  isFood: boolean;
  aliasKey: string;
}

interface Amount {
  quantity: number;
  unit: Unit;
}

function roundAmount(quantity: number): number {
  return Math.round(quantity * 1000) / 1000;
}

/** The whole line's amount as printed: one item's size × the pack count, unless the size already covers the pack. */
function printedTotal(cleaned: CleanedReceiptText, size: Amount): Amount {
  const items = cleaned.sizeIsTotal ? 1 : (cleaned.packCount ?? 1);
  return { quantity: size.quantity * items, unit: size.unit };
}

/** The line's printed amount (see `printedTotal`) in the product's tracking unit where that makes sense. */
function amountFromSize(cleaned: CleanedReceiptText, size: Amount, product: CatalogProduct): Amount {
  const productUnit = product.unit;
  const packCount = cleaned.packCount;
  const total = printedTotal(cleaned, size);

  if (unitDimension(productUnit) === "count") {
    // Each item of a multipack is one tracked unit (24 × 375 ml beer → 24).
    if (packCount !== null) return { quantity: packCount, unit: productUnit };
    // A size on a container describes the container (a 425 g tin is one can).
    if (isContainerUnit(productUnit)) return { quantity: 1, unit: productUnit };
    // Loose produce sold by weight: 1.2 kg of bananas → about 10.
    const counted = convert(total.quantity, total.unit, productUnit, product);
    return counted === null ? total : { quantity: Math.max(1, Math.round(counted)), unit: productUnit };
  }
  // Mass ↔ mass and volume ↔ volume always convert; mass ↔ volume only with a known density.
  const converted = convert(total.quantity, total.unit, productUnit, product);
  return converted === null ? total : { quantity: roundAmount(converted), unit: productUnit };
}

/** "AVOCADO HASS EA", "CARROTS EACH": priced per piece (a "3 @ $1.90 EACH" line multiplies it). */
const SOLD_EACH = /\b(?:ea|each)\b/;

/**
 * One piece of a product in its tracking unit: one avocado, one bunch, or
 * one carrot's weight for produce tracked by mass. Null when a piece can't
 * be expressed in the tracking unit.
 */
function onePiece(product: CatalogProduct): Amount | null {
  if (unitDimension(product.unit) === "count") return { quantity: 1, unit: product.unit };
  const converted = convert(1, "each", product.unit, product);
  return converted === null ? null : { quantity: roundAmount(converted), unit: product.unit };
}

/**
 * Quantity bought: the explicit size on the line (× pack count, unless the
 * size is the pack's net weight), then one piece for lines sold each, then
 * the matched product's package, then one each. Converted into the
 * product's tracking unit when the conversion is unambiguous.
 */
function resolveAmount(cleaned: CleanedReceiptText, product: CatalogProduct | null, soldEach: boolean): Amount {
  const { size, packCount } = cleaned;
  if (!product) {
    if (size) {
      const total = printedTotal(cleaned, size);
      return { quantity: roundAmount(total.quantity), unit: total.unit };
    }
    return { quantity: packCount ?? 1, unit: "each" };
  }
  if (size) return amountFromSize(cleaned, size, product);
  if (packCount !== null && unitDimension(product.unit) === "count") return { quantity: packCount, unit: product.unit };
  const piece = soldEach && packCount === null ? onePiece(product) : null;
  return piece ?? { quantity: product.packageQuantity, unit: product.unit };
}

/** Pantry basics nobody buys as such, and what a receipt line naming them actually sold. */
const RECEIPT_SUBSTITUTES: Readonly<Record<string, string>> = {
  water: "spring-water",
};

/** A receipt never sells tap water: map pantry basics to the product actually bought. */
function purchasable(index: ProductIndex, match: ProductMatch): ProductMatch {
  const substitute = match.product.pantryBasic ? RECEIPT_SUBSTITUTES[match.product.slug] : undefined;
  const productIndex = substitute === undefined ? undefined : index.bySlug.get(substitute);
  return productIndex === undefined ? match : { ...match, product: index.products[productIndex] };
}

/**
 * Interpret one receipt line: canonical product, quantity bought, whether
 * it's food, and how sure Plenty is.
 *
 * "W/M FULL CREAM 2L" → Full cream milk, 2 l, confidence ≈ 0.96.
 * "AVOCADO HASS EA"   → Avocado, 1 each (one piece, not the usual 2-pack).
 * "CARRY BAG"         → not food, no match.
 */
export function normalizeReceiptLine(raw: string, opts?: MatchOptions): NormalizedReceiptLine {
  const cleaned = cleanReceiptText(raw);
  const key = aliasKey(raw);
  const fallbackName = sentenceCase(cleaned.cleaned || normalizeText(raw)) || raw.trim();
  const { index, ranked } = rankCandidates(raw, cleaned, opts);
  const best = ranked[0] && ranked[0].score >= MIN_MATCH_SCORE ? purchasable(index, toMatch(index, ranked[0])) : null;
  const packCount = cleaned.packCount ?? 1;

  if (!best && isNonItemLine(raw, cleaned)) {
    return { rawText: raw, name: fallbackName, match: null, quantity: 1, unit: "each", packCount, confidence: NON_ITEM_CONFIDENCE, isFood: false, aliasKey: key };
  }

  const accepted = best && best.score >= ACCEPT_MATCH_SCORE ? best : null;
  const amount = resolveAmount(cleaned, accepted?.product ?? null, SOLD_EACH.test(normalizeText(raw)));
  const hasText = cleaned.cleaned.length > 0;
  const confidence = best ? best.score : hasText ? UNMATCHED_CONFIDENCE : EMPTY_LINE_CONFIDENCE;
  return {
    rawText: raw,
    name: accepted ? accepted.product.name : fallbackName,
    match: best,
    quantity: amount.quantity,
    unit: amount.unit,
    packCount,
    confidence,
    isFood: !(accepted?.product.nonFood ?? false),
    aliasKey: key,
  };
}

export function __debugQuery(text: string) {
  const cleaned = cleanReceiptText(text);
  const index = indexFor(undefined);
  const words = queryWords(cleaned);
  const query = words.tokens.map((token, i) => resolveToken(index, words.surfaces[i], token));
  return { query, head: queryHead(query)?.surface, scored: scoreProducts(index, query).sort((a, b) => b.score - a.score).slice(0, 4).map((s) => `${index.products[s.productIndex].slug}:${s.score.toFixed(3)}`) };
}
