/**
 * Shopping-list reconciliation: merge freshly computed needs into the list
 * the household already has, without undoing anything a person did.
 *
 * Rules, in order of precedence:
 *   - Manual items are never removed and their quantity is never touched;
 *     a matching need only adds its reason and sources.
 *   - Checked or purchased items are left exactly as they are.
 *   - An item dismissed until later suppresses needs for its key.
 *   - Plenty's own (auto) items are refreshed when still needed and removed
 *     when not — unless the user edited them, which makes them theirs.
 *
 * Pure and deterministic.
 */

import type { ExistingListItem, ReconcileResult, ShoppingNeed } from "@/lib/meals/types";

type ListUpdate = ReconcileResult["update"][number];

function isDismissed(item: ExistingListItem, now: Date): boolean {
  return item.dismissedUntil !== null && item.dismissedUntil.getTime() > now.getTime();
}

function isSettled(item: ExistingListItem): boolean {
  return item.checkedAt !== null || item.purchasedAt !== null;
}

function isRemovable(item: ExistingListItem, now: Date): boolean {
  // Dismissed rows stay so the dismissal is remembered until it lapses.
  return item.source !== "manual" && !isSettled(item) && !item.userEdited && !isDismissed(item, now);
}

function updateFor(item: ExistingListItem, need: ShoppingNeed): ListUpdate {
  const manual = item.source === "manual";
  return {
    id: item.id,
    // Manual items keep what the person asked for; auto items take the new suggestion
    // (a user-edited quantity lives in `quantity`, which reconciliation never writes).
    suggestedQuantity: manual ? item.suggestedQuantity : need.quantity,
    suggestedUnit: manual ? item.suggestedUnit : need.unit,
    source: manual ? "manual" : need.primarySource,
    reason: need.reason,
    advice: need.advice ?? null,
    sources: need.sources,
  };
}

/**
 * Work out how to bring the list in line with `needs` at `now`: which needs
 * to add, which existing rows to refresh, and which auto-added rows are no
 * longer needed. Items are matched on `itemKey`; duplicate needs for a key
 * after the first are ignored. Existing rows are never duplicated.
 */
export function reconcileShoppingList(
  existing: readonly ExistingListItem[],
  needs: readonly ShoppingNeed[],
  now: Date,
): ReconcileResult {
  const byKey = new Map<string, ExistingListItem[]>();
  for (const item of existing) {
    const rows = byKey.get(item.itemKey);
    if (rows) rows.push(item);
    else byKey.set(item.itemKey, [item]);
  }

  const result: ReconcileResult = { create: [], update: [], remove: [] };
  const neededKeys = new Set<string>();
  for (const need of needs) {
    if (neededKeys.has(need.itemKey)) continue;
    neededKeys.add(need.itemKey);
    const rows = byKey.get(need.itemKey) ?? [];
    if (rows.length === 0) {
      result.create.push(need);
      continue;
    }
    if (rows.some((row) => isDismissed(row, now))) continue;
    // Refresh the open rows; checked or purchased rows are left alone.
    for (const row of rows) {
      if (!isSettled(row)) result.update.push(updateFor(row, need));
    }
  }

  for (const item of existing) {
    if (!neededKeys.has(item.itemKey) && isRemovable(item, now)) result.remove.push(item.id);
  }
  return result;
}
