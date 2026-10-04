/**
 * Deterministic supermarket receipt text parser.
 *
 * Turns OCR output (or pasted receipt text) into structured purchase lines.
 * It understands the usual layouts of Australian (Woolworths, Coles, Aldi),
 * New Zealand (Countdown), UK (Tesco, Sainsbury's) and US (Walmart, Kroger)
 * receipts:
 *
 *   - an item line is a description with a price at the end, optionally
 *     followed by flags ("A", "#", "*", "T", "F", "GST", …);
 *   - quantity lines ("2 @ $1.50 EACH", "Qty 2 @ 1.50", "2 x 1.50") and weight
 *     lines ("0.842 kg NET @ $3.90/kg 3.28") qualify the neighbouring item;
 *   - discount lines ("LESS SPECIAL", "PRICE REDUCED", "-1.00") reduce the
 *     previous item;
 *   - everything else (totals, tax, payment, loyalty, contact details,
 *     boilerplate) is skipped, capturing store, date, subtotal and total.
 *
 * It tolerates common OCR noise: O/0, S/5, l/1 confusions inside prices, stray
 * punctuation, broken spacing ("4 .20", "$ 4.20") and lower case. Photos of
 * receipts add margin noise (fake characters before the line and short junk
 * words after the price), which is stripped before a line is classified, and
 * weighed-item lines whose unit price OCR has mangled ("@ B4.30rkg 3.10") are
 * still understood.
 *
 * Pure and deterministic: no clock, no I/O. Pass `today` for date sanity checks.
 */

import { addDays, isDateString } from "@/lib/dates";
import { SUPERMARKETS } from "@/lib/domain";
import { mergeReadings, type Reading } from "@/lib/receipts/consensus";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ParsedReceiptLine {
  /** The source line(s) as read; multi-line items are joined with "\n". */
  raw: string;
  /** Product text with prices, flags and barcodes removed, e.g. "W/M FULL CREAM 2L". */
  description: string;
  /** Count purchased, from "2 @ $1.50" or "QTY 2". Null when not stated. */
  quantity: number | null;
  /** Weight for weighed items ("0.842 kg NET @ $3.90/kg"), converted to kg. */
  weightKg: number | null;
  /** Price per item, or per kg for weighed items. */
  unitPrice: number | null;
  /** Line total after discounts. */
  price: number | null;
  /** Total discount applied to this line (positive), or null. */
  discount: number | null;
}

export interface ParsedReceipt {
  /** Canonical supermarket name from `SUPERMARKETS`, or null if unrecognised. */
  store: string | null;
  /** YYYY-MM-DD */
  purchasedOn: string | null;
  total: number | null;
  subtotal: number | null;
  lines: ParsedReceiptLine[];
  /** Codes from `RECEIPT_PARSE_WARNINGS`. */
  warnings: string[];
}

export const RECEIPT_PARSE_WARNINGS = [
  "no_items_found",
  "total_mismatch",
  /** Items found but no total or subtotal was read, and nothing follows the items: the receipt may be cut off. */
  "no_total",
  /** Items found and no total amount was read, but the receipt carries on below the items (or a subtotal matches them): it is a reading problem, not a missing part. */
  "total_unreadable",
  "no_date",
  "date_in_future",
  "date_too_old",
  "no_store",
] as const;
export type ReceiptParseWarning = (typeof RECEIPT_PARSE_WARNINGS)[number];

export interface ParseReceiptOptions {
  /** Household "today" (YYYY-MM-DD): resolves 2-digit years and rejects implausible dates. */
  today?: string;
}

export type StoreName = (typeof SUPERMARKETS)[number];

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Line prices may differ from the printed total by this fraction before we warn. */
export const TOTAL_MISMATCH_TOLERANCE = 0.05;
/** …or by this absolute amount, whichever is larger (protects tiny receipts). */
const TOTAL_MISMATCH_MIN_ABS = 0.1;
/** Receipt dates older than this (relative to `today`) are rejected. */
export const MAX_RECEIPT_AGE_DAYS = 730;
/** Lines at the top of the receipt searched first for the store name. */
const HEADER_LINE_COUNT = 8;
/** Larger "item" prices are almost certainly misreads (barcodes, phone numbers). */
const MAX_ITEM_PRICE = 1000;
const MAX_TOTAL = 50_000;
const MAX_QUANTITY = 99;
const MAX_WEIGHT_KG = 50;
/** Flags allowed after a price ("4.20 A", "1.24 N X"). */
const MAX_TRAILING_FLAGS = 2;
/** Two prices "match" within this absolute or relative difference. */
const PRICE_MATCH_ABS = 0.02;
const PRICE_MATCH_REL = 0.01;
/** Letters allowed in a discount/total label besides its keywords ("Cc CLUBCARD PRICE"). */
const DISCOUNT_RESIDUAL_MAX_LETTERS = 3;
const TOTAL_RESIDUAL_MAX_LETTERS = 2;
const LB_IN_KG = 0.45359237;

/** Stores whose receipts print dates month-first (MM/DD/YY). */
const MONTH_FIRST_STORES: ReadonlySet<string> = new Set<StoreName>(["Walmart", "Kroger", "Trader Joe's", "Whole Foods", "Target"]);

// ─── Line normalisation ─────────────────────────────────────────────────────

interface TextLine {
  /** Trimmed source line. */
  raw: string;
  /** Repaired text, original case. */
  text: string;
  /** `text` upper-cased; used for structural (number) patterns. */
  upper: string;
  /** `upper` with look-alike digits in words mapped to letters ("T0TAL" → "TOTAL"); used for keywords. */
  key: string;
}

const DIGIT_LOOKALIKES: Record<string, string> = { O: "0", o: "0", S: "5", s: "5", I: "1", l: "1", "|": "1", B: "8" };
const LETTER_LOOKALIKES: Record<string, string> = { "0": "O", "5": "S", "8": "B" };

/**
 * A price-like token with OCR look-alikes: optional parentheses/minus, currency
 * (a leading "S" before digits is a misread "$"), whole part, 2-digit cents,
 * trailing minus and an optional glued flag ("3.50A").
 */
const LOOSE_AMOUNT_TOKEN =
  /^(\(?)(-?)([$£€]|[Ss](?=[\dOoIl|]*\d))?(-?)(\d{1,3}(?:,\d{3})+|[\dOoSsIl|B]{1,6})[.,]([\dOoSsIl|B]{2})(-?)(\)?)([*#^]|[ABCDEFNRTXZ])?$/;

function toDigits(value: string): string {
  return value.replace(/,/g, "").replace(/[OoSsIl|B]/g, (ch) => DIGIT_LOOKALIKES[ch] ?? ch);
}

/** Canonicalise one price-like token: "S4.2O" → "$4.20", "1.00-" → "-1.00", "3.50A" → "3.50 A". */
function repairAmountToken(token: string): string {
  const m = LOOSE_AMOUNT_TOKEN.exec(token);
  if (!m) return token;
  const [, openParen, lead1, currency, lead2, whole, cents, trail, closeParen, flag] = m;
  if (!/\d/.test(whole + cents)) return token;
  const negative = Boolean(lead1 || lead2 || trail || (openParen && closeParen));
  const symbol = currency ? (/[Ss]/.test(currency) ? "$" : currency) : "";
  const amount = `${negative ? "-" : ""}${symbol}${toDigits(whole)}.${toDigits(cents)}`;
  return flag ? `${amount} ${flag}` : amount;
}

function repairToken(token: string): string {
  return token.includes("/") ? token.split("/").map(repairAmountToken).join("/") : repairAmountToken(token);
}

/**
 * OCR sometimes reads a price's decimal point as a colon ("2:28"). Only
 * repaired at the end of weight/quantity lines (which contain "@"), so times
 * like "17:42" are never turned into prices.
 */
function repairColonPrice(text: string): string {
  const m = /^(.*@.*\S)\s+(-?[$£€]?\d{1,4}):(\d{2})$/.exec(text);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : text;
}

/** Fix unicode variants, broken spacing, stray edge characters and OCR-damaged prices. */
function normaliseText(raw: string): string {
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\t]/g, " ")
    .replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4`]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[•·]/g, " ")
    .replace(/\s*@\s*/g, " @ ")
    .replace(/([$£€])\s+(?=[-\dOoSsIl|])/g, "$1") // "$ 4.20"
    .replace(/(\d)\s+([.,])(\d{2})(?!\d)/g, "$1$2$3") // "4 .20"
    .replace(/(\d[.,])\s+(\d{2})(?!\d)/g, "$1$2") // "4. 20"
    .replace(/(^|\s)-\s+(?=[$£€]?[\dOoSsIl|])/g, "$1-") // "- 1.00"
    .replace(/(\d[.,]\d{2})\s+-(?=\s|$)/g, "$1-") // "1.00 -"
    .replace(/\s+\|\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[|_~'"\\«»!;:,]+/, "")
    .replace(/[|_~'"\\«»!;:,.]+$/, "")
    .trim();
  return repairColonPrice(cleaned.split(" ").map(repairToken).join(" "));
}

/** Map look-alike digits back to letters inside words (letters must dominate the token). */
function toKey(upper: string): string {
  return upper
    .split(" ")
    .map((token) => {
      const letters = (token.match(/[A-Z]/g) ?? []).length;
      const digits = (token.match(/\d/g) ?? []).length;
      if (digits === 0 || letters < 2 || letters <= digits) return token;
      return token.replace(/[058]/g, (d) => LETTER_LOOKALIKES[d] ?? d);
    })
    .join(" ");
}

// ─── Margin noise ───────────────────────────────────────────────────────────

/**
 * Photos of receipts lying on a speckled surface pick up characters from the
 * margins: fake symbols and short junk words in front of a line ("©. ", "~~ ",
 * "Co ", "CT ") and junk after its price ("3.10     nal", "5.90 ©]"). They are
 * stripped before a line is classified. Symbols and wide-gapped junk after a
 * price are always removed; short junk words at the start of a line (which could
 * be real abbreviations) only when the text is clearly noisy.
 */

/** Symbols a photographed margin turns into; never part of an item. `#`, `*`, `-`, `@`, `$` and brackets are meaningful and kept. */
const JUNK_SYMBOLS = /^[©®™°§¶•·~_|\\^=+<>«»{}[\]!;:,.'"`´¬¦†‡¡¿…]+$/;
/** A junk word: a few letters with at most a little punctuation stuck to it ("re,", "Tal,", "©"-free). */
const JUNK_FRAGMENT = /^[^A-Za-z0-9]{0,2}[A-Za-z]{1,5}[^A-Za-z0-9]{0,2}$/;
/** Real short words that may start an item line (store brands, abbreviations). */
const REAL_SHORT_WORDS: ReadonlySet<string> = new Set(["WW", "WM", "CB", "CC", "HB", "GV", "KS", "JS", "TJ", "ST", "QTY", "WT", "NET", "PK", "KG", "EA", "NZ", "UK", "US"]);
/** Words that legitimately follow a price. */
const PRICE_SUFFIX_WORD = /^(?:EA|EACH|KGS?|G|GMS?|LBS?|PER|GST|TAX|TX|NET|AUD|NZD|USD|GBP|EUR|CAD)$/i;
const WEIGHT_NUMBER = /^\d{1,3}[.,]\d{1,3}$/;
const KG_LIKE = /^(?:KGS?|KQ|KY|K9)$/i;
/** At most this many junk tokens are stripped from one end of a line. */
const MAX_JUNK_TOKENS = 4;
/** Whitespace between a price (or the end of the text) and trailing junk that marks it as margin noise. */
const JUNK_GAP_AFTER_PRICE = 2;
const JUNK_GAP_AFTER_TEXT = 3;
const JUNK_GAP_DASH = 3;
/** This many lines with symbol junk at an end (or long junk words after a price) make the text "noisy". */
const NOISY_TEXT_LINES = 2;

interface RawToken {
  text: string;
  /** Whitespace characters before the token (OCR keeps column gaps, so wide gaps separate margin junk from the line). */
  gap: number;
}

function rawTokens(line: string): RawToken[] {
  return [...line.replace(/\t/g, "    ").matchAll(/(\s*)(\S+)/g)].map((m) => ({ text: m[2], gap: m[1].length }));
}

const isJunkSymbol = (token: RawToken): boolean => JUNK_SYMBOLS.test(token.text);

function isPriceToken(text: string): boolean {
  return parseAmount(repairToken(text).split(" ")[0]) !== null;
}

function lastPriceIndex(tokens: readonly RawToken[]): number {
  for (let i = tokens.length - 1; i >= 0; i -= 1) if (isPriceToken(tokens[i].text)) return i;
  return -1;
}

function isJunkWord(token: RawToken, afterPrice: boolean): boolean {
  if (isJunkSymbol(token)) return true;
  // A lone dash is a minus sign when it hugs the price ("1.00 -"), margin noise when it sits far off ("5.90      -").
  if (/^[-–—]+$/.test(token.text)) return !afterPrice || token.gap >= JUNK_GAP_DASH;
  return JUNK_FRAGMENT.test(token.text) && !PRICE_SUFFIX_WORD.test(token.text.replace(/[^A-Za-z]/g, ""));
}

/** A short fragment at the start of a line that no real line would begin with. Only trusted in noisy text. */
function isLeadingFragment(tokens: readonly RawToken[]): boolean {
  const [token, next, third] = tokens;
  const letters = token.text.replace(/[^A-Za-z]/g, "");
  if (/\d/.test(token.text) || letters.length === 0 || letters.length > 3 || token.text.length > letters.length + 2) return false;
  if (REAL_SHORT_WORDS.has(letters.toUpperCase())) return false;
  if (letters.length === 1 || !/[AEIOUY]/i.test(letters)) return true;
  if (next?.text.startsWith("#")) return true;
  if (next && third && WEIGHT_NUMBER.test(next.text) && KG_LIKE.test(third.text.replace(/[^A-Za-z0-9]/g, ""))) return true;
  // "CoD", "cT": capitals in odd places are not a word.
  return /[a-z]/.test(letters) && /[A-Z]/.test(letters) && !/^[A-Z][a-z]+$/.test(letters);
}

function leadingJunkCount(tokens: readonly RawToken[], noisy: boolean): number {
  let i = 0;
  while (i < tokens.length - 1) {
    if (isJunkSymbol(tokens[i]) || (noisy && isLeadingFragment(tokens.slice(i)))) i += 1;
    else break;
  }
  return i;
}

/**
 * Index where trailing junk starts (`tokens.length` when there is none).
 *
 * After a price, everything that follows must be junk: symbols, or short words
 * set apart from the price by a wide gap. Without a price (a description above
 * a weight line) the junk is the run of fragments after the line's last wide
 * gap, which can only be told from real trailing words in noisy text.
 */
function trailingJunkStart(tokens: readonly RawToken[], noisy: boolean): number {
  const price = lastPriceIndex(tokens);
  if (price >= 0) {
    const trailing = tokens.slice(price + 1);
    if (trailing.length === 0 || trailing.length > MAX_JUNK_TOKENS || !trailing.every((t) => isJunkWord(t, true))) return tokens.length;
    return trailing[0].gap >= JUNK_GAP_AFTER_PRICE || trailing.every(isJunkSymbol) ? price + 1 : tokens.length;
  }
  if (!noisy) return tokens.length;
  let start = tokens.length;
  let wide = tokens.length;
  while (start > 1 && tokens.length - start < MAX_JUNK_TOKENS && isJunkWord(tokens[start - 1], false)) {
    start -= 1;
    if (tokens[start].gap >= JUNK_GAP_AFTER_TEXT) wide = start;
  }
  // Never leave nothing but fragments behind.
  return wide < tokens.length && tokens.slice(0, wide).some((t) => /[A-Za-z]{3,}|\d/.test(t.text)) ? wide : tokens.length;
}

function cleanMargins(source: string, tokens: readonly RawToken[], noisy: boolean): string {
  if (tokens.length < 2) return source;
  const start = leadingJunkCount(tokens, noisy);
  const rest = tokens.slice(start);
  const end = trailingJunkStart(rest, noisy);
  return start === 0 && end === rest.length ? source : rest.slice(0, end).map((t) => t.text).join(" ");
}

/** Evidence of photographic margin noise: symbol junk at a line end, or long junk words after a price. */
function isNoisyText(lines: ReadonlyArray<readonly RawToken[]>): boolean {
  let evidence = 0;
  for (const tokens of lines) {
    if (tokens.length < 2 || tokens.every(isJunkSymbol)) continue;
    if (isJunkSymbol(tokens[0]) || isJunkSymbol(tokens[tokens.length - 1])) {
      evidence += 1;
      continue;
    }
    const price = lastPriceIndex(tokens);
    const trailing = price >= 0 ? tokens.slice(price + 1) : [];
    if (trailing.length > 0 && trailing[0].gap >= JUNK_GAP_AFTER_PRICE && trailing.every((t) => isJunkWord(t, true)) && trailing.some((t) => t.text.replace(/[^A-Za-z]/g, "").length >= 3)) {
      evidence += 1;
    }
  }
  return evidence >= NOISY_TEXT_LINES;
}

function prepareLines(text: string): TextLine[] {
  const sources = text.split(/\r\n|\r|\n/).map((source) => source.trim());
  const tokenised = sources.map(rawTokens);
  const noisy = isNoisyText(tokenised);
  const out: TextLine[] = [];
  sources.forEach((raw, i) => {
    const normalised = normaliseText(cleanMargins(raw, tokenised[i], noisy));
    if (!normalised) return;
    const upper = normalised.toUpperCase();
    out.push({ raw, text: normalised, upper, key: toKey(upper) });
  });
  return out;
}

// ─── Money helpers ──────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function pricesMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(PRICE_MATCH_ABS, Math.abs(b) * PRICE_MATCH_REL);
}

/** A canonical amount token (after repair): "-$4.20", "£1.45", "3.10". */
const AMOUNT_TOKEN = /^(-?)[$£€]?(\d{1,6})\.(\d{2})$/;
const AMOUNT_SOURCE = String.raw`-?[$£€]?\d{1,6}\.\d{2}`;
const AMOUNT_GLOBAL = new RegExp(`(?<![\\d.])${AMOUNT_SOURCE}(?![\\d])`, "g");
const FLAG_TOKEN = /^(?:[A-Z]{1,2}|GST|TAX|TX|NT|FT|[*#^~]{1,3})$/i;
const GLUED_AMOUNT = /^(.*[A-Za-z%)'])(-?[$£€]?\d{1,6}\.\d{2})$/;

function parseAmount(token: string): number | null {
  const m = AMOUNT_TOKEN.exec(token);
  if (!m) return null;
  const value = Number(`${m[2]}.${m[3]}`);
  return m[1] === "-" ? -value : value;
}

interface TrailingAmount {
  /** Text before the amount (flags after it removed). */
  head: string;
  amount: number;
}

/** Split "W/M FULL CREAM 2L 3.10 A" into head "W/M FULL CREAM 2L" and 3.10. */
function splitTrailingAmount(text: string): TrailingAmount | null {
  const tokens = text.split(" ");
  let end = tokens.length;
  let flags = 0;
  while (end > 1 && flags < MAX_TRAILING_FLAGS && parseAmount(tokens[end - 1]) === null && FLAG_TOKEN.test(tokens[end - 1])) {
    end -= 1;
    flags += 1;
  }
  const last = tokens[end - 1];
  const amount = parseAmount(last);
  if (amount !== null) return { head: tokens.slice(0, end - 1).join(" "), amount };
  const glued = GLUED_AMOUNT.exec(last);
  if (glued) {
    const gluedAmount = parseAmount(glued[2]);
    if (gluedAmount !== null) return { head: [...tokens.slice(0, end - 1), glued[1]].join(" "), amount: gluedAmount };
  }
  return null;
}

function countLetters(value: string): number {
  return (value.match(/[A-Z]/gi) ?? []).length;
}

// ─── Store detection ────────────────────────────────────────────────────────

const STORE_PATTERNS: ReadonlyArray<{ store: StoreName; pattern: RegExp }> = [
  { store: "Woolworths", pattern: /\bWOOLWORTHS?\b|\bWOOLIES\b/ },
  { store: "Coles", pattern: /\bCOLES\b/ },
  { store: "Aldi", pattern: /\bALDI\b/ },
  { store: "IGA", pattern: /\bIGA\b/ },
  { store: "Harris Farm", pattern: /\bHARRIS\s*FARM\b/ },
  { store: "Costco", pattern: /\bCOSTCO\b/ },
  { store: "Tesco", pattern: /\bTESCO\b/ },
  { store: "Sainsbury's", pattern: /\bSAINSBURY'?S?\b/ },
  { store: "Asda", pattern: /\bASDA\b/ },
  { store: "Lidl", pattern: /\bLIDL\b/ },
  { store: "Waitrose", pattern: /\bWAITROSE\b/ },
  { store: "Countdown", pattern: /\bCOUNTDOWN\b/ },
  { store: "New World", pattern: /\bNEW\s*WORLD\b/ },
  { store: "Pak'nSave", pattern: /\bPAK\s*'?\s*N\s*'?\s*SAVE\b/ },
  { store: "Walmart", pattern: /\bWAL\s*[-*.]?\s*MART\b/ },
  { store: "Kroger", pattern: /\bKROGER\b/ },
  { store: "Trader Joe's", pattern: /\bTRADER\s+JOE'?S?\b/ },
  { store: "Whole Foods", pattern: /\bWHOLE\s*FOODS\b/ },
  { store: "Target", pattern: /\bTARGET\b/ },
];

/** Long store words matched with one OCR error allowed ("WOOLWDRTHS"). */
const FUZZY_STORE_WORDS: ReadonlyArray<{ store: StoreName; word: string }> = [
  { store: "Woolworths", word: "WOOLWORTHS" },
  { store: "Countdown", word: "COUNTDOWN" },
  { store: "Waitrose", word: "WAITROSE" },
  { store: "Sainsbury's", word: "SAINSBURYS" },
  { store: "Walmart", word: "WALMART" },
  { store: "Kroger", word: "KROGER" },
  { store: "Costco", word: "COSTCO" },
];

/** Loyalty programmes that identify the store when its name is unreadable. */
const LOYALTY_STORE_HINTS: ReadonlyArray<{ store: StoreName; pattern: RegExp }> = [
  { store: "Woolworths", pattern: /\bEVERYDAY\s+REWARDS\b/ },
  { store: "Coles", pattern: /\bFLY\s?BUYS\b/ },
  { store: "Tesco", pattern: /\bCLUB\s?CARD\b/ },
  { store: "Sainsbury's", pattern: /\bNECTAR\b/ },
  { store: "Countdown", pattern: /\bONE\s?CARD\b/ },
];

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

function matchStore(key: string): StoreName | null {
  return STORE_PATTERNS.find(({ pattern }) => pattern.test(key))?.store ?? null;
}

function fuzzyMatchStore(key: string): StoreName | null {
  const words = key.replace(/[^A-Z\s]/g, "").split(/\s+/);
  for (const word of words) {
    const hit = FUZZY_STORE_WORDS.find((entry) => word.length >= 5 && withinOneEdit(word, entry.word));
    if (hit) return hit.store;
  }
  return null;
}

/**
 * Find the supermarket: exact names in the header, then OCR-tolerant matches
 * in the header, then exact names anywhere ("Thank you for shopping at Coles"),
 * then loyalty programme hints.
 */
function detectStore(lines: TextLine[]): StoreName | null {
  const header = lines.slice(0, HEADER_LINE_COUNT);
  for (const line of header) {
    const store = matchStore(line.key);
    if (store) return store;
  }
  for (const line of header) {
    const store = fuzzyMatchStore(line.key);
    if (store) return store;
  }
  for (const line of lines) {
    const store = matchStore(line.key);
    if (store) return store;
  }
  for (const line of lines) {
    const hint = LOYALTY_STORE_HINTS.find(({ pattern }) => pattern.test(line.key));
    if (hint) return hint.store;
  }
  return null;
}

// ─── Dates ──────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const MONTH_NAME = String.raw`(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?`;
const ISO_DATE = /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g;
const NUMERIC_DATE = /(?<![\d.])(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?![\d.])/g;
const DAY_MONTH_YEAR = new RegExp(String.raw`\b(\d{1,2})(?:ST|ND|RD|TH)?[\s./-]*${MONTH_NAME}[\s./,-]*'?(\d{4}|\d{2})\b`, "g");
const MONTH_DAY_YEAR = new RegExp(String.raw`\b${MONTH_NAME}\s+(\d{1,2})(?:ST|ND|RD|TH)?,?\s+(\d{4})\b`, "g");
const TIME_PATTERN = /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\b/;
const DATE_TOKEN_LOOKALIKE = /^[\dOoIl]{1,4}([/.-])[\dOoIl]{1,2}\1[\dOoIl]{2,4}$/;
const DATE_KEYWORD = /\bDATE\b/;
const NON_PURCHASE_DATE_KEYWORD = /\b(?:EXP(?:IRY|IRES|\.)?|VALID|UNTIL|BEFORE|BEST|USE\s+BY|OFFER|ENDS?|FROM|BIRTH|DOB)\b/;
const DATE_SCORE_TIME = 2;
const DATE_SCORE_KEYWORD = 2;
const DATE_SCORE_NON_PURCHASE = -5;

interface DateCandidate {
  line: number;
  score: number;
  /** Plausible ISO readings, most preferred first. */
  readings: string[];
}

type DateRejection = "date_in_future" | "date_too_old";

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1990 || year > 2100) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function expandYear(value: string, today: string | null): number {
  const n = Number(value.replace("'", ""));
  if (value.length === 4) return n;
  const todayYear = today ? Number(today.slice(0, 4)) : 2000;
  const year = Math.floor(todayYear / 100) * 100 + n;
  return today && year > todayYear + 1 ? year - 100 : year;
}

/** Repair "26/O9/2O26"-style tokens before date matching. */
function repairDateTokens(upper: string): string {
  return upper
    .split(" ")
    .map((token) => (DATE_TOKEN_LOOKALIKE.test(token) ? token.replace(/[Oo]/g, "0").replace(/[Il]/g, "1") : token))
    .join(" ");
}

function dateReadingsInLine(upper: string, monthFirst: boolean, today: string | null): string[][] {
  const text = repairDateTokens(upper);
  const found: string[][] = [];
  const push = (readings: Array<string | null>) => {
    const valid = readings.filter((r): r is string => r !== null);
    if (valid.length > 0) found.push([...new Set(valid)]);
  };
  for (const m of text.matchAll(ISO_DATE)) push([isoDate(Number(m[1]), Number(m[2]), Number(m[3]))]);
  for (const m of text.matchAll(NUMERIC_DATE)) {
    const year = expandYear(m[4], today);
    const a = Number(m[1]);
    const b = Number(m[3]);
    const dayFirst = isoDate(year, b, a);
    const monthFirstReading = isoDate(year, a, b);
    push(monthFirst ? [monthFirstReading, dayFirst] : [dayFirst, monthFirstReading]);
  }
  for (const m of text.matchAll(DAY_MONTH_YEAR)) push([isoDate(expandYear(m[3], today), MONTHS[m[2]], Number(m[1]))]);
  for (const m of text.matchAll(MONTH_DAY_YEAR)) push([isoDate(Number(m[3]), MONTHS[m[1]], Number(m[2]))]);
  return found;
}

function lineHasDate(upper: string): boolean {
  return dateReadingsInLine(upper, false, null).length > 0;
}

function dateRejection(date: string, today: string | null): DateRejection | null {
  if (!today) return null;
  if (date > today) return "date_in_future";
  if (date < addDays(today, -MAX_RECEIPT_AGE_DAYS)) return "date_too_old";
  return null;
}

/**
 * Pick the purchase date: prefer dates printed with a time or a "DATE" label,
 * avoid "valid until"/"expires" dates, prefer day-first unless the store is
 * American, and reject dates in the future or too far in the past.
 */
function detectDate(lines: TextLine[], store: StoreName | null, today: string | null): { date: string | null; rejection: DateRejection | null } {
  const monthFirst = store !== null && MONTH_FIRST_STORES.has(store);
  const candidates: DateCandidate[] = [];
  lines.forEach((line, index) => {
    const readings = dateReadingsInLine(line.upper, monthFirst, today);
    if (readings.length === 0) return;
    let score = 0;
    if (TIME_PATTERN.test(line.upper)) score += DATE_SCORE_TIME;
    if (DATE_KEYWORD.test(line.key)) score += DATE_SCORE_KEYWORD;
    if (NON_PURCHASE_DATE_KEYWORD.test(line.key)) score += DATE_SCORE_NON_PURCHASE;
    for (const r of readings) candidates.push({ line: index, score, readings: r });
  });
  candidates.sort((a, b) => b.score - a.score || a.line - b.line);
  for (const candidate of candidates) {
    const accepted = candidate.readings.find((reading) => dateRejection(reading, today) === null);
    if (accepted) return { date: accepted, rejection: null };
  }
  const first = candidates[0];
  return { date: null, rejection: first ? dateRejection(first.readings[0], today) : null };
}

// ─── Line classification ────────────────────────────────────────────────────

type LineKind =
  | { kind: "skip" }
  | { kind: "date" }
  | { kind: "subtotal"; amount: number }
  | { kind: "total"; amount: number; priority: number }
  | { kind: "tender"; amount: number }
  | { kind: "tax"; amount: number }
  | { kind: "qualifier"; qualifier: Qualifier }
  | { kind: "discount"; amount: number }
  | { kind: "item"; item: ItemReading }
  | { kind: "text"; description: string };

interface Qualifier {
  quantity: number | null;
  weightKg: number | null;
  unitPrice: number | null;
  /** Line total printed on the qualifier line, if any. */
  total: number | null;
  /** Line total implied by quantity/weight × unit price. */
  implied: number | null;
}

interface ItemReading {
  description: string;
  price: number;
  quantity: number | null;
  weightKg: number | null;
  unitPrice: number | null;
}

const SKIP: LineKind = { kind: "skip" };
const SEPARATOR = /^[-=*_.#~+<>\s]+$/;

// Totals ──────────────────────────────────────────────────────────────────────

const SUBTOTAL_WORD = /\bSUB\s*-?\s*TOTAL\b|\bSUBTOTAL/;
const TOTAL_WORD = /\bTOTAL\b/;
const AMOUNT_DUE_WORDS = /\bBALANCE\s+DUE\b|\bAMOUNT\s+DUE\b|\bTO\s+PAY\b|\bPAYABLE\b/;
const BALANCE_WORD = /\bBALANCE\b/;
const TAX_WORD = /\b(?:GST|VAT|HST|PST|TAX(?:ES)?)\b/;
const TAX_INCLUSIVE = /\bINC(?:L|LUDING|LUSIVE)?\.?\s*(?:OF\s+)?(?:GST|VAT|TAX)\b/;
/** Words that may accompany a total without making it something else. */
const TOTAL_QUALIFIERS =
  /\b(?:GRAND|SUB|TOTAL|SUBTOTAL|BALANCE|DUE|AMOUNT|AMT|TO|PAY|PAYABLE|FOR|ITEMS?|INC|INCL|INCLUDING|INCLUSIVE|OF|GST|VAT|TAX|AUD|NZD|GBP|USD|EUR|CAD|SALE|PURCHASE|NET|FINAL|THE)\b/g;

type TotalLabel = { kind: "subtotal" } | { kind: "total"; priority: number } | null;

/** Classify a label ("Total for 8 items", "**** BALANCE", "SUBTOTAL") as a (sub)total. */
function classifyTotalLabel(label: string): TotalLabel {
  const isSubtotal = SUBTOTAL_WORD.test(label);
  const hasTotal = TOTAL_WORD.test(label);
  const hasDue = AMOUNT_DUE_WORDS.test(label);
  const hasBalance = BALANCE_WORD.test(label);
  if (!isSubtotal && !hasTotal && !hasDue && !hasBalance) return null;
  if (TAX_WORD.test(label) && !TAX_INCLUSIVE.test(label)) return null;
  const residual = label.replace(TOTAL_QUALIFIERS, " ").replace(/[^A-Z]/g, "");
  if (residual.length > TOTAL_RESIDUAL_MAX_LETTERS) return null;
  if (isSubtotal) return { kind: "subtotal" };
  if (hasTotal) return { kind: "total", priority: 1 };
  if (hasDue) return { kind: "total", priority: 2 };
  return { kind: "total", priority: 3 };
}

// Quantity & weight qualifiers ──────────────────────────────────────────────────

const QUANTITY_LINE = new RegExp(
  String.raw`^(?:QTY|QUANTITY)?\s*:?\s*(\d{1,3})\s*(?:EA\s*)?(?:@|X|×|\*|AT)\s*(?:(\d{1,2})\s*(?:FOR|\/)\s*)?(${AMOUNT_SOURCE})\s*(?:(?:EA|EACH|PER\s+ITEM|\/\s*EA)\.?)?(?:\s+(${AMOUNT_SOURCE}))?(?:\s+(?:[A-Z]{1,2}|[*#^]))?$`,
);
const WEIGHT_START = /^(?:NET\s*(?:WT|WEIGHT)?\.?|WT\.?|WEIGHT)?\s*:?\s*(\d{1,3}(?:\.\d{1,3})?)\s*(KGS?|G|GMS?|LBS?)\b\.?/;
const WEIGHT_NOISE_WORDS = /\b(?:NET|AT|X|PER|EACH|EA|KGS?|LBS?|GMS?|G)\b/g;
const PER_UNIT = /(?:\/|\bPER)\s*(KGS?|LBS?|G)\b|@\s*1\s*(KG|LB)\b/;

function massInKg(unit: string): number {
  if (unit.startsWith("LB")) return LB_IN_KG;
  if (unit.startsWith("KG")) return 1;
  return 0.001;
}

/** "2 @ $1.50 EACH 3.00", "QTY 2 @ 1.50", "2 x 1.50", "2 AT 1 FOR 1.92". */
function parseQuantityLine(upper: string): Qualifier | null {
  const m = QUANTITY_LINE.exec(upper);
  if (!m) return null;
  const quantity = Number(m[1]);
  const per = m[2] ? Number(m[2]) : 1;
  const stated = parseAmount(m[3]);
  const total = m[4] ? parseAmount(m[4]) : null;
  if (stated === null || stated < 0 || quantity < 1 || quantity > MAX_QUANTITY || per < 1) return null;
  const unitPrice = round2(stated / per);
  return { quantity, weightKg: null, unitPrice, total: total !== null && total > 0 ? total : null, implied: round2(quantity * stated / per) };
}

/** "0.842 kg NET @ $3.90/kg 3.28", "1.34 lb @ 0.69 /lb", "2.13 lb @ 1 lb /0.58". */
function parseCleanWeightLine(upper: string): Qualifier | null {
  const start = WEIGHT_START.exec(upper);
  if (!start) return null;
  const rest = upper.slice(start[0].length);
  const residual = rest.replace(AMOUNT_GLOBAL, " ").replace(WEIGHT_NOISE_WORDS, " ").replace(/[^A-Z]/g, "");
  if (residual.length > MAX_TRAILING_FLAGS) return null;
  const weightKg = Number(start[1]) * massInKg(start[2]);
  if (!(weightKg > 0) || weightKg > MAX_WEIGHT_KG) return null;

  const amounts = [...rest.matchAll(AMOUNT_GLOBAL)].map((m) => ({ value: parseAmount(m[0]) ?? 0, index: m.index ?? 0 }));
  const perUnit = PER_UNIT.exec(rest);
  const perUnitKg = massInKg(perUnit?.[1] ?? perUnit?.[2] ?? start[2]);
  let unitRaw: number | null = null;
  let total: number | null = null;
  if (amounts.length >= 2) {
    unitRaw = amounts[0].value;
    total = amounts[amounts.length - 1].value;
  } else if (amounts.length === 1) {
    const isRate = perUnit !== null || rest.slice(0, amounts[0].index).includes("@");
    if (isRate) unitRaw = amounts[0].value;
    else total = amounts[0].value;
  }
  const unitPrice = unitRaw !== null && unitRaw > 0 ? round2(unitRaw / perUnitKg) : null;
  const implied = unitRaw !== null ? round2((weightKg / perUnitKg) * unitRaw) : null;
  return { quantity: null, weightKg: round3(weightKg), unitPrice, total: total !== null && total > 0 ? total : null, implied };
}

/**
 * A weighed-item line whose unit price OCR has mangled: "0.632 kg NET @ B4.30rkg 3.10",
 * "0.222 kg NET © $4.3)/kg 1.09". Shape: weight, kg (or a misread "kq"/"ky"), an
 * optional "NET", "@", unit-price garbage, then the line total as the right-most price.
 * A short junk fragment before the weight ("CET 0.632 kg …") is tolerated.
 */
const DAMAGED_WEIGHT_LINE = /^(?:[^\sA-Z0-9]{0,2}[A-Z]{1,3}\s+)?(\d{1,2}[.,]\d{2,3})\s*(?:KGS?|KQ|KY|K9)\.?\s*([A-Z]{2,4})?\s*(?:@|©|®)\s*(.+)$/;
const DAMAGED_UNIT_PRICE_MAX_CHARS = 16;
/** "$3.90/KG", "3.90 PER KG", "0.69 /LB": a unit price OCR read cleanly. */
const LEGIBLE_UNIT_PRICE = /^[$£€]?\d{1,3}[.,]\d{2}\s*(?:\/|PER\s+)?\s*(?:KGS?|G|LBS?)?$/;
/** The unit price read from the garbage is only believed when weight × price reproduces the printed total this closely. */
const UNIT_PRICE_TOTAL_TOLERANCE = 0.03;

/**
 * The total is the right-most price. The unit price is kept only when it is
 * legible and consistent with weight and total; a misread one ("4.30" for
 * "4.90") would otherwise be reported as fact, and a total that is itself
 * unreadable is left empty rather than guessed from a damaged unit price.
 */
function parseDamagedWeightLine(upper: string): { qualifier: Qualifier; legibleRate: boolean } | null {
  const m = DAMAGED_WEIGHT_LINE.exec(upper);
  if (!m) return null;
  const weightKg = Number(m[1].replace(",", "."));
  if (!(weightKg > 0) || weightKg > MAX_WEIGHT_KG) return null;
  const tokens = m[3].trim().split(" ");
  const rightmost = parseAmount(tokens[tokens.length - 1]);
  const total = rightmost !== null && rightmost > 0 ? rightmost : null;
  const garbage = (total !== null ? tokens.slice(0, -1) : tokens).join(" ");
  if (garbage.length > DAMAGED_UNIT_PRICE_MAX_CHARS || !(/\d/.test(garbage) || /K[GQY9]/.test(garbage))) return null;
  // Without a total, only a line that says "NET" is trusted to be a weight line.
  if (total === null && !m[2]) return null;
  const rate = /(\d{1,3})[.,](\d{2})(?!\d)/.exec(garbage);
  const perKg = rate ? Number(`${rate[1]}.${rate[2]}`) : null;
  const consistent = total !== null && perKg !== null && Math.abs(weightKg * perKg - total) <= Math.max(0.03, total * UNIT_PRICE_TOTAL_TOLERANCE);
  return {
    qualifier: { quantity: null, weightKg: round3(weightKg), unitPrice: consistent ? perKg : null, total, implied: null },
    legibleRate: LEGIBLE_UNIT_PRICE.test(garbage),
  };
}

/**
 * A weight line with a damaged unit price must not be read the ordinary way: with
 * "@ $4.3)/kg 3.10" the only amount left is the line total, which the ordinary
 * reading mistakes for a rate (and then prices the item at weight × total). When
 * the unit price is legible the ordinary reading applies.
 */
function parseWeightLine(upper: string): Qualifier | null {
  const damaged = parseDamagedWeightLine(upper);
  if (damaged && !damaged.legibleRate) return damaged.qualifier;
  return parseCleanWeightLine(upper) ?? damaged?.qualifier ?? null;
}

// Discounts ─────────────────────────────────────────────────────────────────

const DISCOUNT_TRIGGER =
  /\b(?:LESS\s+SPECIAL|ON\s+SPECIAL|SPECIALS|SPECIAL\s+(?:PRICE|OFFER|SAVING|DISCOUNT)|PRICE\s+(?:REDUCED|REDUCTION|DROP|MATCH)|REDUCED|REDUCTION|SAVINGS?|SAVE|MEMBER\s+(?:PRICE|SAVING|DISCOUNT|OFFER)|PROMO(?:TION(?:AL)?)?|OFFER|MULTI\s*-?\s*BUY|DISCOUNT|DISC|COUPON|VOUCHER|MARK\s*DOWN|MARKDOWN|(?:CLUBCARD|NECTAR|ONECARD|LOYALTY)\s+(?:PRICE|SAVING|DISCOUNT)|BONUS\s+BUY)\b/;
/** Everything a pure discount label may contain besides its trigger. */
const DISCOUNT_FILLER =
  /\b(?:LESS|SPECIALS?|PRICE|REDUCED|REDUCTION|DROP|MATCH|SAVINGS?|SAVE|MEMBERS?|PROMO(?:TION(?:AL)?)?|OFFER|MULTI|BUY|MULTIBUY|DISCOUNT|DISC|COUPON|VOUCHER|MARK|DOWN|MARKDOWN|CLUBCARD|NECTAR|ONECARD|LOYALTY|BONUS|REWARDS?|STAFF|INSTANT|DIGITAL|STORE|MFR|ON|OFF|FOR|YOUR|THIS|ITEM|AND|NOW|WAS|GET|KROGER|WALMART|TESCO|COLES|WOOLWORTHS|ALDI|SAINSBURY'?S|COUNTDOWN|ASDA|LIDL|WAITROSE)\b/g;

function discountAmount(label: string, amount: number): number | null {
  if (!DISCOUNT_TRIGGER.test(label)) return null;
  if (amount < 0) return -amount;
  const residual = label.replace(DISCOUNT_FILLER, " ").replace(/[^A-Z]/g, "");
  return residual.length <= DISCOUNT_RESIDUAL_MAX_LETTERS && amount > 0 ? amount : null;
}

// Skipped lines ─────────────────────────────────────────────────────────────

const SUMMARY_SAVINGS =
  /\bYOU(?:'?VE)?\s+SAVED\b|\bYOUR\s+SAVINGS\b|\bTOTAL\s+(?:SAVINGS?|SAVED|DISCOUNTS?)\b|\bSAVINGS?\s+TODAY\b|\bTODAY'?S\s+SAVINGS\b|\bSAVED\s+TODAY\b/;

const TENDER =
  /^\W*(?:EFTPOS|EFT|VISA|MASTER\s?CARD|AMEX|AMERICAN\s+EXPRESS|DINERS|DISCOVER|MAESTRO|DEBIT|CREDIT|US\s+DEBIT|CARD|CONTACTLESS|APPLE\s*PAY|GOOGLE\s*PAY|SAMSUNG\s*PAY|PAY\s?WAVE|PAY\s?PASS)\b/;

/**
 * Card-terminal fields on EFTPOS slips ("AID A0000000031010", "PAN ****1234",
 * "MID: 123456"). Their values are codes, never words, so a code followed by
 * a word is a product ("PAN DULCE", "MID STRENGTH LAGER").
 */
const TERMINAL_FIELD = /^\W*(?:AID|TVR|ATC|ARQC|RRN|STAN|TID|MID|PAN|TSI|IAD)\b(?!\s+[A-Z]{2,}\b)/;
/** US food-benefit lines ("SNAP BAL 12.34", "SNAP 4.54") — but not "SNAP PEAS". */
const SNAP_BENEFIT =
  /^\W*SNAP\b(?=\s*(?:$|[^A-Z\s]|(?:BAL(?:ANCE)?|TEND(?:ER|ERED)?|ELIGIBLE|BENEFITS?|FOOD|CASH|EBT|PAID|PAYMENT|AMT|AMOUNT|TOTAL|SUBTOTAL|DUE|PURCHASE|CARD|ACCT|ACCOUNT)\b))/;

/** Lines that never describe a purchased item. Tested against the letter-normalised key. */
const SKIP_PATTERNS: readonly RegExp[] = [
  // Payment and tender
  TENDER,
  /^\W*(?:CASH|CHANGE|ROUNDING|TEND(?:ER|ERED)?|PAYPAL|EBT|GIFT\s*CARD|ACCOUNT|ACCT|AUTH(?:ORI[SZ]ATION)?|APPROVED|ACCEPTED|DECLINED|PURCHASE)\b/,
  TERMINAL_FIELD,
  SNAP_BENEFIT,
  /\bTEND(?:ER|ERED)?\b|\bCHANGE\s+DUE\b|\bCASH\s*(?:OUT|BACK|RECEIVED|PAID)\b|\bCARD\s*(?:NO|NUMBER|#|TYPE|ENDING|PAYMENT|SALE)\b/,
  /\*{3,}\s*\d{2,4}\b|X{4,}\d{2,4}\b/,
  // Tax and business registration
  TAX_WORD,
  /\bTAX\s+INVOICE\b|\bA\.?B\.?N\b|\bA\.?C\.?N\b|\bNZBN\b|\bREG(?:ISTRATION|ISTERED)?\s*(?:NO|NUMBER|OFFICE)\b|\bCOMPANY\s+(?:NO|NUMBER)\b/,
  /\bWWW\.|\.COM\b|\.CO\.UK\b|\.COM\.AU\b|\.CO\.NZ\b|@[A-Z]/,
  /\bSERVED\s+BY\b|\bCASHIER\b|\bOPERATOR\b|\bMANAGER\b/,
  // Loyalty programmes
  /\bEVERYDAY\s+REWARDS?\b|\bREWARDS?\b|\bFLY\s?BUYS\b|\bCLUB\s?CARD\b|\bNECTAR\b|\bONE\s?CARD\b|\bPOINTS?\b|\bLOYALTY\b|\bMEMBER(?:SHIP)?\s*(?:NO|NUMBER|#|ID|CARD)\b|\bKROGER\s+PLUS\b/,
  // Courtesy text and policies
  /\bTHANK\s*(?:YOU|S)\b|\bPLEASE\b|\bCOME\s+AGAIN\b|\bSEE\s+YOU\b|\bHAVE\s+A\b|\bWELCOME\b|\bRETAIN\b|\bKEEP\s+(?:THIS|YOUR)\b|\bRETURNS?\b|\bREFUNDS?\b|\bEXCHANGE\b|\bPOLICY\b|\bSURVEY\b|\bFEEDBACK\b|\bCUSTOMER\s+(?:COPY|SERVICE|CARE)\b|\bMERCHANT\s+COPY\b|\bSIGNATURE\b|\bPIN\s+VERIFIED\b|\bOPENING\s+HOURS\b|\bTRADING\s+HOURS\b/,
  // Savings summaries
  SUMMARY_SAVINGS,
  // Reference prices printed for information under a sale item ("Regular Price $3.49", "WAS $6.00 NOW $4.00")
  /^\W*(?:REG(?:ULAR)?|ORIG(?:INAL)?|NORMAL|RETAIL|LIST)\.?\s+PRICE\b|^\W*WAS\s+[$£€]?\d/,
  // Item counts
  /^\W*\d+\s*(?:ITEMS?|ITEM\(S\)|ARTICLES?|PCS)\b|\b(?:NO\.?|NUMBER|#|COUNT)\s*(?:OF\s+)?ITEMS?\b|\bITEMS?\s+(?:SOLD|PURCHASED|COUNT)\b|\bTOTAL\s+ITEMS?\b|\bITEMS?\s*[:=]\s*\d+\s*$/,
];

/**
 * Header-style lines (contact details, register references, addresses). Only
 * checked for lines without a price, so item names like "COKE REG 1.25L" or
 * "ST AGNES BRANDY" can never be mistaken for them.
 */
const HEADER_PATTERNS: readonly RegExp[] = [
  // Contact details
  /\b(?:PH|PHONE|TEL|TELEPHONE|FAX|MOB)\b\.?\s*:?\s*[(+\d]/,
  /\(\s*0\d\s*\)\s*\d{4}\s*\d{4}|\b1[38]00\s?\d{3}\s?\d{3}\b|\(\s*\d{3}\s*\)\s*\d{3}\s*-?\s*\d{4}|\b\d{3}-\d{3}-\d{4}\b|\b0\d{1,4}\s\d{3,4}\s\d{3,4}\b/,
  // Store, register and transaction references
  /\b(?:STORE|ST|STR|OP|OPR|TE|TERM|TERMINAL|TR|TRN|TRANS(?:ACTION)?|TXN|REG|REGISTER|LANE|TILL|POS|CHECKOUT|RECEIPT|INVOICE|DOCKET|REF(?:ERENCE)?|SEQ|BATCH)\s*(?:NO\.?|#|NUMBER|ID)?\s*[:.#]?\s*\d+\b/,
  // Addresses
  /\b(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s+\d{4}\b/,
  /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/,
  /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/,
  /\b\d+[A-Z]?(?:[-/]\d+)?\s+[A-Z][A-Z' ]*\s(?:ST|STREET|RD|ROAD|AVE|AVENUE|HWY|HIGHWAY|PDE|PARADE|DR|DRIVE|BLVD|BOULEVARD|LANE|LN|PL|PLACE|WAY|CRES|CRESCENT|TCE|TERRACE|CT|COURT|SQ|SQUARE)\b/,
  /\bSHOP\s+\d+|\bSHOPPING\s+(?:CENTRE|CENTER|CTR)\b|\bPLAZA\b|\bMALL\b|\bWESTFIELD\b|\bSTOCKLAND\b|\bLEVEL\s+\d+/,
];

// Item lines ────────────────────────────────────────────────────────────────

const INLINE_QUANTITY = new RegExp(String.raw`^(.*?)\s+(\d{1,3})\s*(?:@|X|×|AT)\s*(${AMOUNT_SOURCE})\s*(?:EA|EACH)?\.?$`, "i");
const INLINE_WEIGHT = new RegExp(
  String.raw`^(.*?)\s+(\d{1,3}\.\d{1,3})\s*(KGS?|G|LBS?)\s*(?:NET)?\s*(?:@|X|AT)\s*(${AMOUNT_SOURCE})\s*(?:\/\s*(KGS?|LBS?|G))?$`,
  "i",
);
const TRAILING_UNIT_PRICE = new RegExp(String.raw`^(.*?)\s+(?:(\d{1,3})\s+)?(${AMOUNT_SOURCE})$`);
const LEADING_QUANTITY = /^(\d{1,2})\s*[X@×]\s*(?=[A-Za-z])/i;
const WEIGHED_SUFFIX = /\s*(?:\/|PER\s+)?(?:KG|KILO)$/i;
/** OCR often reads the "g" of a trailing "kg" as "y" or "q" ("Streaky Bacon ky"). Only used on lines that have a price. */
const MISREAD_KG_SUFFIX = /\s(K[YQ])$/i;

/** Remove markers, item codes, barcodes and dangling symbols from a description. */
function cleanDescription(head: string): string {
  return head
    .replace(/^[*#^~+>.\-]+\s*/, "")
    .replace(/^\d{5,}\s+/, "")
    .replace(/^WT\.?\s+/i, "")
    .replace(/\s+\d{8,14}(?:[A-Z]{1,2})?(?:\s+[A-Z]{1,2})?$/i, "")
    .replace(/\s\d{8,14}[A-Z]{0,2}\b/gi, " ")
    .replace(/(?:\s+[*#^]+)+$/, "")
    .replace(/[\s$£€@:\-]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDescription(value: string): boolean {
  return countLetters(value) >= 2 && /[A-Za-z]{2,}/.test(value);
}

/** Parse "W/M FULL CREAM 2L 3.10", "2 X MILK 2L 4.20", "MILK 2L 2 @ 2.10 4.20". */
function parseItemLine(head: string, price: number): ItemReading | null {
  if (price < 0 || price > MAX_ITEM_PRICE) return null;
  let text = head;
  let quantity: number | null = null;
  let weightKg: number | null = null;
  let unitPrice: number | null = null;

  const inlineWeight = INLINE_WEIGHT.exec(text);
  const inlineQuantity = inlineWeight ? null : INLINE_QUANTITY.exec(text);
  if (inlineWeight) {
    const kg = Number(inlineWeight[2]) * massInKg(inlineWeight[3].toUpperCase());
    const rate = parseAmount(inlineWeight[4]);
    if (kg > 0 && kg <= MAX_WEIGHT_KG && rate !== null) {
      weightKg = round3(kg);
      unitPrice = round2(rate / massInKg((inlineWeight[5] ?? inlineWeight[3]).toUpperCase()));
      text = inlineWeight[1];
    }
  } else if (inlineQuantity) {
    const qty = Number(inlineQuantity[2]);
    const each = parseAmount(inlineQuantity[3]);
    if (qty >= 1 && qty <= MAX_QUANTITY && each !== null && each > 0) {
      quantity = qty;
      unitPrice = each;
      text = inlineQuantity[1];
    }
  } else {
    const trailing = TRAILING_UNIT_PRICE.exec(text);
    const each = trailing ? parseAmount(trailing[3]) : null;
    if (trailing && each !== null && each > 0 && isDescription(trailing[1])) {
      const implied = price / each;
      const statedQty = trailing[2] ? Number(trailing[2]) : null;
      const qty = Math.round(implied);
      if (Math.abs(implied - qty) < 0.01 && qty >= 1 && qty <= MAX_QUANTITY && (statedQty === null || statedQty === qty)) {
        quantity = qty > 1 || statedQty !== null ? qty : null;
        unitPrice = each;
        text = trailing[1];
      }
    }
  }

  const leading = LEADING_QUANTITY.exec(text);
  if (leading && quantity === null && weightKg === null) {
    const qty = Number(leading[1]);
    if (qty >= 1 && qty <= MAX_QUANTITY) {
      quantity = qty;
      unitPrice = round2(price / qty);
      text = text.slice(leading[0].length);
    }
  }

  let description = cleanDescription(text).replace(MISREAD_KG_SUFFIX, (_, k: string) => (k === k.toUpperCase() ? " KG" : " kg"));
  if (weightKg !== null) description = description.replace(WEIGHED_SUFFIX, "").trim() || description;
  if (!isDescription(description)) return null;
  return { description, price, quantity, weightKg, unitPrice };
}

function looksLikeProductText(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  const alnum = (compact.match(/[A-Za-z0-9]/g) ?? []).length;
  return countLetters(text) >= 3 && /[A-Za-z]{3,}/.test(text) && alnum / compact.length >= 0.6;
}

/** Classify one line without context; the assembly pass decides what it applies to. */
function classifyLine(line: TextLine): LineKind {
  const { text, upper, key } = line;
  if (!/[A-Za-z0-9]/.test(text) || SEPARATOR.test(text)) return SKIP;
  if (lineHasDate(upper)) return { kind: "date" };

  const tail = splitTrailingAmount(text);
  const label = tail ? toKey(tail.head.toUpperCase()) : key;
  if (tail) {
    const total = classifyTotalLabel(label);
    if (total && tail.amount >= 0 && tail.amount <= MAX_TOTAL) {
      return total.kind === "subtotal" ? { kind: "subtotal", amount: tail.amount } : { kind: "total", amount: tail.amount, priority: total.priority };
    }
    if (TAX_WORD.test(label)) return { kind: "tax", amount: tail.amount };
    if (SUMMARY_SAVINGS.test(label)) return SKIP;
  }

  const qualifier = parseQuantityLine(upper) ?? parseWeightLine(upper);
  if (qualifier) return { kind: "qualifier", qualifier };

  if (tail) {
    const discount = discountAmount(label, tail.amount);
    if (discount !== null) return { kind: "discount", amount: discount };
    if (TENDER.test(label) && tail.amount > 0) return { kind: "tender", amount: tail.amount };
  }
  if (SKIP_PATTERNS.some((pattern) => pattern.test(key))) return SKIP;
  if (tail) {
    if (tail.amount < 0) return { kind: "discount", amount: -tail.amount };
    const item = parseItemLine(tail.head, tail.amount);
    return item ? { kind: "item", item } : SKIP;
  }
  if (HEADER_PATTERNS.some((pattern) => pattern.test(key))) return SKIP;
  if (looksLikeProductText(text)) return { kind: "text", description: cleanDescription(text) };
  return SKIP;
}

// ─── Assembly ───────────────────────────────────────────────────────────────

interface DraftLine {
  raw: string[];
  description: string;
  quantity: number | null;
  weightKg: number | null;
  unitPrice: number | null;
  /** Price before discounts. */
  basePrice: number | null;
  discount: number;
  /** A quantity/weight line has already been applied. */
  qualified: boolean;
}

interface AssemblyState {
  lines: DraftLine[];
  /** A price-less description ("BANANAS KG") that a following weight/quantity line may complete. */
  pending: { raw: string; description: string; index: number } | null;
  /** A qualifier printed above its item (Kroger style), waiting for that item. */
  leading: { raw: string; qualifier: Qualifier } | null;
  ended: boolean;
  subtotal: number | null;
  totals: Array<{ amount: number; priority: number }>;
  tenders: number[];
  taxes: number[];
  classified: LineKind[];
  /** Index (in the text lines) of the last line that produced or completed an item; -1 when there is none. */
  lastItemIndex: number;
}

function expectedTotal(q: Qualifier): number | null {
  return q.total ?? q.implied;
}

function applyQualifier(line: DraftLine, q: Qualifier, raw: string, position: "before" | "after"): void {
  if (q.quantity !== null) line.quantity = q.quantity;
  if (q.weightKg !== null) {
    line.weightKg = q.weightKg;
    line.description = line.description.replace(WEIGHED_SUFFIX, "").trim() || line.description;
  }
  if (q.unitPrice !== null) line.unitPrice = q.unitPrice;
  if (q.total !== null) line.basePrice = q.total;
  else if (line.basePrice === null) line.basePrice = q.implied;
  line.qualified = true;
  if (position === "before") line.raw.unshift(raw);
  else line.raw.push(raw);
}

function qualifierFitsPrevious(prev: DraftLine | undefined, q: Qualifier): boolean {
  if (!prev || prev.qualified) return false;
  if (prev.basePrice === null) return true;
  const expected = expectedTotal(q);
  if (expected !== null && pricesMatch(prev.basePrice, expected)) return true;
  if (q.quantity !== null && q.unitPrice !== null && pricesMatch(prev.basePrice, q.unitPrice)) return true;
  return false;
}

function nextItem(classified: LineKind[], from: number): ItemReading | null {
  for (let i = from; i < classified.length; i += 1) {
    const c = classified[i];
    if (c.kind === "item") return c.item;
    if (c.kind !== "skip") return null;
  }
  return null;
}

function onlySkipsBetween(classified: LineKind[], from: number, to: number): boolean {
  for (let i = from + 1; i < to; i += 1) if (classified[i].kind !== "skip") return false;
  return true;
}

/**
 * Attach a quantity/weight line: to the description just above it ("BANANAS
 * KG" then the weight line), to the previous item when consistent, or — when
 * the next item's price matches instead — to the next item (Kroger prints
 * "2 @ 1.25" above the item it belongs to).
 */
function handleQualifier(state: AssemblyState, q: Qualifier, raw: string, classified: LineKind[], index: number): void {
  const upcoming = nextItem(classified, index + 1);
  const expected = expectedTotal(q);
  const upcomingMatches = upcoming !== null && expected !== null && pricesMatch(upcoming.price, expected);
  const pending = state.pending;
  if (pending && onlySkipsBetween(classified, pending.index, index) && (q.total !== null || !upcomingMatches)) {
    const line = newDraft({ description: pending.description, price: null, quantity: null, weightKg: null, unitPrice: null }, pending.raw);
    state.pending = null;
    applyQualifier(line, q, raw, "after");
    state.lines.push(line);
    return;
  }
  const prev = state.lines[state.lines.length - 1];
  if (qualifierFitsPrevious(prev, q)) {
    applyQualifier(prev, q, raw, "after");
    return;
  }
  if (!prev || prev.qualified || upcomingMatches) {
    state.leading = { raw, qualifier: q };
    return;
  }
  applyQualifier(prev, q, raw, "after");
}

function newDraft(item: Omit<ItemReading, "price"> & { price: number | null }, raw: string): DraftLine {
  return {
    raw: [raw],
    description: item.description,
    quantity: item.quantity,
    weightKg: item.weightKg,
    unitPrice: item.unitPrice,
    basePrice: item.price,
    discount: 0,
    qualified: item.quantity !== null || item.weightKg !== null,
  };
}

function handleItem(state: AssemblyState, item: ItemReading, raw: string): void {
  state.pending = null;
  const line = newDraft(item, raw);
  if (state.leading) {
    applyQualifier(line, { ...state.leading.qualifier, total: null }, state.leading.raw, "before");
    state.leading = null;
  }
  state.lines.push(line);
}

/** Reduce the previous item. A discount bigger than what's left of it is a summary line, not an item discount. */
function handleDiscount(state: AssemblyState, amount: number, raw: string): void {
  const prev = state.lines[state.lines.length - 1];
  if (!prev || prev.basePrice === null) return;
  if (prev.discount + amount > prev.basePrice + PRICE_MATCH_ABS / 2) return;
  prev.discount = round2(prev.discount + amount);
  prev.raw.push(raw);
}

function assemble(lines: TextLine[]): AssemblyState {
  const classified = lines.map(classifyLine);
  const state: AssemblyState = {
    lines: [],
    pending: null,
    leading: null,
    ended: false,
    subtotal: null,
    totals: [],
    tenders: [],
    taxes: [],
    classified,
    lastItemIndex: -1,
  };
  classified.forEach((c, index) => {
    const raw = lines[index].raw;
    const before = state.lines.length;
    switch (c.kind) {
      case "subtotal":
        if (state.subtotal === null) state.subtotal = c.amount;
        state.ended = true;
        break;
      case "total":
        state.totals.push({ amount: c.amount, priority: c.priority });
        state.ended = true;
        break;
      case "tender":
        state.tenders.push(c.amount);
        break;
      case "tax":
        state.taxes.push(c.amount);
        break;
      case "qualifier":
        if (!state.ended) handleQualifier(state, c.qualifier, raw, classified, index);
        break;
      case "discount":
        if (!state.ended) handleDiscount(state, c.amount, raw);
        break;
      case "item":
        if (!state.ended) handleItem(state, c.item, raw);
        break;
      case "text":
        if (!state.ended) state.pending = { raw, description: c.description, index };
        break;
      default:
        break;
    }
    if (state.lines.length > before) state.lastItemIndex = index;
  });
  return state;
}

/**
 * True when the receipt visibly carries on below its last item: a total,
 * payment, tax, date, loyalty or courtesy line (even one whose amount couldn't
 * be read). Items that run straight into the end of the text may be cut off.
 */
function continuesBelowItems(lines: readonly TextLine[], state: AssemblyState): boolean {
  for (let i = state.lastItemIndex + 1; i < lines.length; i += 1) {
    const c = state.classified[i];
    if (c.kind === "date" || c.kind === "subtotal" || c.kind === "total" || c.kind === "tender" || c.kind === "tax") return true;
    const { key } = lines[i];
    if (c.kind === "skip" && SKIP_PATTERNS.some((pattern) => pattern.test(key))) return true;
    if (c.kind === "text" && (TOTAL_WORD.test(key) || SUBTOTAL_WORD.test(key) || TAX_WORD.test(key))) return true;
  }
  return false;
}

function finaliseLine(draft: DraftLine): ParsedReceiptLine {
  const discount = draft.discount > 0 ? round2(draft.discount) : null;
  const price = draft.basePrice === null ? null : round2(Math.max(0, draft.basePrice - (discount ?? 0)));
  return {
    raw: draft.raw.join("\n"),
    description: draft.description,
    quantity: draft.quantity,
    weightKg: draft.weightKg,
    unitPrice: draft.unitPrice,
    price,
    discount,
  };
}

function pickTotal(state: AssemblyState): number | null {
  const best = [...state.totals].sort((a, b) => a.priority - b.priority)[0];
  if (best) return best.amount;
  return state.tenders[0] ?? null;
}

/** True when the line prices don't add up to the total, subtotal or pre-tax total. */
function totalsDisagree(lines: ParsedReceiptLine[], total: number | null, subtotal: number | null, taxes: number[]): boolean {
  const priced = lines.filter((l) => l.price !== null);
  const reference = total ?? subtotal;
  if (priced.length === 0 || reference === null) return false;
  const sum = round2(priced.reduce((acc, l) => acc + (l.price ?? 0), 0));
  const taxSum = taxes.reduce((acc, t) => acc + Math.max(0, t), 0);
  const references = [total, subtotal, total !== null && taxSum > 0 ? total - taxSum : null].filter((r): r is number => r !== null && r > 0);
  return references.every((ref) => Math.abs(sum - ref) > Math.max(ref * TOTAL_MISMATCH_TOLERANCE, TOTAL_MISMATCH_MIN_ABS));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** The form feed OCR engines put between pages; here it separates several readings of the same receipt. */
export const READING_SEPARATOR = "\f";

/** Everything one reading of the text yields, before warnings are worked out. */
function readText(text: string, today: string | null): Reading {
  const lines = prepareLines(text);
  const store = detectStore(lines);
  const { date, rejection } = detectDate(lines, store, today);
  const state = assemble(lines);
  return {
    store,
    purchasedOn: date,
    dateRejection: rejection,
    total: pickTotal(state),
    subtotal: state.subtotal,
    taxes: state.taxes,
    footerSeen: continuesBelowItems(lines, state),
    lines: state.lines.map(finaliseLine),
  };
}

/**
 * Parse receipt text into store, date, totals and item lines.
 *
 * Never throws: problems are reported in `warnings` ("no_items_found",
 * "total_mismatch", "no_total", "total_unreadable", "no_date", "date_in_future",
 * "date_too_old", "no_store").
 * With `opts.today`, dates in the future or more than two years old are
 * rejected (and 2-digit years resolve to the current century).
 *
 * The text may hold several readings of the same receipt separated by form
 * feeds (`READING_SEPARATOR`), as the on-device reader produces for a poor photo.
 * Each is parsed on its own and they are merged by consensus (see
 * `mergeReadings`): a price, weight or total needs two readings to agree, and an
 * item needs two readings unless it is in the best one.
 */
export function parseReceiptText(text: string, opts: ParseReceiptOptions = {}): ParsedReceipt {
  const today = opts.today && isDateString(opts.today) ? opts.today : null;
  const texts = (text ?? "").split(READING_SEPARATOR).filter((t, i, all) => all.length === 1 || t.trim().length > 0);
  const reading = mergeReadings(texts.map((t) => readText(t, today)));
  const { store, purchasedOn: date, total, subtotal, lines } = reading;

  const warnings: ReceiptParseWarning[] = [];
  const mismatch = totalsDisagree(lines, total, subtotal, reading.taxes);
  if (lines.length === 0) warnings.push("no_items_found");
  if (mismatch) warnings.push("total_mismatch");
  if (lines.length > 0 && total === null && !mismatch) {
    // No total amount was read. If the receipt visibly goes on below the items, or a subtotal read from it matches them, nothing is
    // missing from the photo: the total just wasn't legible. Otherwise the items run into the end of the text and it may be cut off.
    warnings.push(subtotal !== null || reading.footerSeen ? "total_unreadable" : "no_total");
  }
  if (!date) warnings.push("no_date");
  if (!date && reading.dateRejection) warnings.push(reading.dateRejection);
  if (!store) warnings.push("no_store");

  return { store, purchasedOn: date, total, subtotal, lines, warnings };
}

/** Sum of the parsed line prices (after discounts), rounded to cents. */
export function sumReceiptLines(lines: readonly ParsedReceiptLine[]): number {
  return round2(lines.reduce((acc, l) => acc + (l.price ?? 0), 0));
}
