/**
 * The smart shopping list engine: item keys, needs from predictions, meal
 * plans and staples, and reconciliation with the household's existing list.
 */

export { NAME_KEY_PREFIX, PRODUCT_KEY_PREFIX, normalizeItemName, shoppingItemKey } from "@/lib/shopping/keys";

export {
  STAPLE_DUE_INTERVAL_SHARE,
  WASTE_ADVICE_MIN_EVENTS,
  WASTE_ADVICE_MIN_RATIO,
  WASTE_ADVICE_SMALLER,
  WASTE_ADVICE_SMALLEST,
  computeShoppingNeeds,
  runOutReason,
  stapleReason,
  type ShoppingNeedsInput,
  type WasteStats,
} from "@/lib/shopping/needs";

export { reconcileShoppingList } from "@/lib/shopping/reconcile";
