/**
 * Receipt-text normalisation and product matching.
 *
 * `text.ts` cleans raw text (sizes, brands, abbreviations); `match.ts` maps
 * it to catalog or household products and interprets whole receipt lines.
 */

export {
  aliasKey,
  cleanReceiptText,
  isNonItemLine,
  normalizeText,
  sentenceCase,
  singularize,
  singularizePhrase,
  type CleanOptions,
  type CleanedReceiptText,
  type ReceiptSize,
} from "@/lib/normalize/text";

export {
  ACCEPT_MATCH_SCORE,
  EXACT_ALIAS_SCORE,
  EXACT_CORE_SCORE,
  EXACT_NAME_SCORE,
  HOUSEHOLD_ALIAS_SCORE,
  MIN_CANDIDATE_SCORE,
  MIN_MATCH_SCORE,
  matchProduct,
  matchProductCandidates,
  normalizeReceiptLine,
  productKeyForText,
  type MatchOptions,
  type NormalizedReceiptLine,
} from "@/lib/normalize/match";
