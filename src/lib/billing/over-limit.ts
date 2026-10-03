/**
 * What exceeds a plan after a downgrade.
 *
 * The rule is the same everywhere: nothing is ever deleted, hidden or
 * locked. A household that ends up over a limit keeps all of its people and
 * items and can keep using them; the only thing that waits is adding more,
 * until it is back under. Finishing and removing is always allowed, which is
 * how a household gets back under.
 */

import type { Entitlements } from "./plans";

export interface OverLimit {
  kind: "members" | "items";
  used: number;
  limit: number;
  /** How many beyond the limit. */
  over: number;
  message: string;
}

export interface OverLimitReport {
  over: boolean;
  limits: OverLimit[];
  /** One plain-language paragraph for the plan page, or null when nothing is over. */
  message: string | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function overLimitReport(
  entitlements: Pick<Entitlements, "max_household_members" | "max_inventory_items">,
  counts: { members: number; items: number },
): OverLimitReport {
  const limits: OverLimit[] = [];

  const maxMembers = entitlements.max_household_members;
  if (maxMembers !== null && counts.members > maxMembers) {
    limits.push({
      kind: "members",
      used: counts.members,
      limit: maxMembers,
      over: counts.members - maxMembers,
      message: `Your household has ${plural(counts.members, "person", "people")} and this plan covers ${maxMembers}. Nobody is removed or hidden; adding more people waits until there are ${maxMembers} or fewer.`,
    });
  }

  const maxItems = entitlements.max_inventory_items;
  if (maxItems !== null && counts.items > maxItems) {
    limits.push({
      kind: "items",
      used: counts.items,
      limit: maxItems,
      over: counts.items - maxItems,
      message: `Your kitchen has ${plural(counts.items, "item", "items")} and this plan covers ${maxItems}. Nothing is deleted or hidden, and you can finish or remove items any time; adding more waits until there are ${maxItems} or fewer.`,
    });
  }

  return { over: limits.length > 0, limits, message: limits.length > 0 ? limits.map((l) => l.message).join(" ") : null };
}
