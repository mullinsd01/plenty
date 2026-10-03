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

import { HOUSEHOLD_SCOPE } from "@/lib/members/scope";
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
 * "n:<normalised singular name>". Something that's one person's ("Pepsi Max —
 * Dad") gets its own line, so the key carries the learning scope after an "@":
 * "p:<productId>@member:<id>". The household's own items have no suffix.
 */
export function shoppingItemKey(item: { productId: string | null; name: string; scope?: string | null }): string {
  const base = item.productId ? `${PRODUCT_KEY_PREFIX}${item.productId}` : `${NAME_KEY_PREFIX}${normalizeItemName(item.name)}`;
  return item.scope && item.scope !== HOUSEHOLD_SCOPE ? `${base}@${item.scope}` : base;
}
