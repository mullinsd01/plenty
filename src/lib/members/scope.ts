/**
 * Learning scopes. Plenty learns how fast things get used separately for each
 * owner, so "Dad's Pepsi Max" and "Mum's Pepsi Max" have their own pace:
 *
 *   household        — items nobody in particular owns
 *   member:<id>      — a person's items that the household can see
 *   private:<id>     — a person's private items; only they see anything learned from them
 *
 * A scope is a plain string so it can sit in a unique index next to the product.
 */

export const HOUSEHOLD_SCOPE = "household";

export type ItemVisibility = "household" | "private";

export interface ScopeSource {
  ownerMemberId: string | null;
  visibility: ItemVisibility;
}

/** The scope an item's consumption belongs to. */
export function scopeOf(item: ScopeSource): string {
  if (!item.ownerMemberId) return HOUSEHOLD_SCOPE;
  return item.visibility === "private" ? `private:${item.ownerMemberId}` : `member:${item.ownerMemberId}`;
}

/**
 * The scope used for learning, given whether the household's plan includes
 * individual consumption patterns. Without it, shared items all feed one
 * household pattern. Private items always keep their own scope: privacy
 * doesn't depend on the plan.
 */
export function learningScopeOf(item: ScopeSource, individualPatterns: boolean): string {
  if (!item.ownerMemberId) return HOUSEHOLD_SCOPE;
  if (item.visibility === "private") return `private:${item.ownerMemberId}`;
  return individualPatterns ? `member:${item.ownerMemberId}` : HOUSEHOLD_SCOPE;
}

/** Scopes whose consumption history contributes to a household-wide pattern when patterns aren't individual. */
export function feedsHouseholdPattern(scope: string, individualPatterns: boolean): boolean {
  if (scope === HOUSEHOLD_SCOPE) return true;
  return !individualPatterns && scope.startsWith("member:");
}

/** The member a scope belongs to, or null for the household. */
export function scopeOwner(scope: string): string | null {
  const [kind, id] = scope.split(":");
  return (kind === "member" || kind === "private") && id ? id : null;
}

export function isPrivateScope(scope: string): boolean {
  return scope.startsWith("private:");
}

/** `productId` + scope as one key, for maps of learned state. */
export function learningKey(productId: string, scope: string): string {
  return `${productId}|${scope}`;
}
