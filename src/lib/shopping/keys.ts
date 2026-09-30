/**
 * Shopping-list identity.
 *
 * Every list line has an item key so that the same thing arriving from
 * different sources (a predicted run-out, a meal-plan shortfall, a manual
 * add) lands on one line. Known products key by id; free text keys by its
 * normalised, singular name so "Tomatoes" and "tomato" are the same line.
 *
 * Pure and deterministic.
 */

import { normalizeText, singularizePhrase } from "@/lib/normalize";

/** Prefix for keys of catalog/household products. */
export const PRODUCT_KEY_PREFIX = "p:";
/** Prefix for keys of free-text items. */
export const NAME_KEY_PREFIX = "n:";

/**
 * Canonical form of an item name for comparison: lower-case, punctuation
 * stripped, every word singular ("Cherry Tomatoes" → "cherry tomato").
 */
export function normalizeItemName(name: string): string {
  return singularizePhrase(normalizeText(name));
}

/**
 * The list key for an item: "p:<productId>" for known products, otherwise
 * "n:<normalised singular name>".
 */
export function shoppingItemKey(item: { productId: string | null; name: string }): string {
  return item.productId ? `${PRODUCT_KEY_PREFIX}${item.productId}` : `${NAME_KEY_PREFIX}${normalizeItemName(item.name)}`;
}
