/**
 * Buying and restoring inside the iPhone app. The app (Capacitor shell) owns Apple's purchase sheet and exposes it to
 * the page as the `PlentyPurchases` plugin; the page asks it, then sends what Apple returned to Plenty, which verifies it
 * with Apple before any household gets a plan. Nothing here decides a plan: the server does.
 *
 * Contract with the shell (mobile/purchases.d.ts):
 *   products({ productIds })                     -> the store's own names and localised prices
 *   purchase({ productId, appAccountToken })      -> purchased | pending | cancelled (+ Apple's signed transaction)
 *   restore()                                     -> every current entitlement as Apple's signed transactions
 */
import { BillingRequestError, requestJson } from "./billing-api";

export interface StoreProduct {
  productId: string;
  displayName: string;
  /** What Apple will charge, in the person's own currency ("A$7.99"). */
  displayPrice: string;
  period: "monthly" | "annual";
}

interface SignedTransaction {
  signedTransaction: string;
  signedRenewalInfo?: string;
}

interface PurchasesPlugin {
  products(options: { productIds: string[] }): Promise<{ products: StoreProduct[] }>;
  purchase(options: { productId: string; appAccountToken: string }): Promise<{ status: "purchased" | "pending" | "cancelled" } & Partial<SignedTransaction>>;
  restore(): Promise<{ transactions: SignedTransaction[] }>;
  manageSubscriptions?(): Promise<unknown>;
}

/** The shell's purchase plugin, or null in a browser. */
export function purchasesPlugin(): PurchasesPlugin | null {
  if (typeof window === "undefined") return null;
  const plugin = (window as unknown as { Capacitor?: { Plugins?: { PlentyPurchases?: PurchasesPlugin } } }).Capacitor?.Plugins?.PlentyPurchases;
  return plugin ?? null;
}

const NOT_IN_APP = "Subscribing and restoring run from the Plenty app. Open Plenty on your iPhone and try again.";
const STORE_PROBLEM = "The App Store didn't complete that. Nothing has been charged. Please try again in a moment.";

/** The store's own prices for these products; an empty list when the app can't say (the page then shows its own). */
export async function loadStoreProducts(productIds: string[]): Promise<StoreProduct[]> {
  const plugin = purchasesPlugin();
  if (!plugin || productIds.length === 0) return [];
  try {
    return (await plugin.products({ productIds })).products;
  } catch {
    return [];
  }
}

export interface LinkResult {
  outcome: "linked" | "already_linked" | "nothing_to_restore";
  message: string;
}

/** Hand Apple's signed transaction to Plenty to verify and link to this household. */
async function linkTransaction(transaction: SignedTransaction): Promise<LinkResult> {
  return requestJson<LinkResult>("POST", "/api/billing/restore", {
    provider: "apple",
    signedTransaction: transaction.signedTransaction,
    signedRenewalInfo: transaction.signedRenewalInfo ?? null,
  });
}

export type BuyResult =
  | { kind: "linked"; message: string }
  | { kind: "pending"; message: string }
  | { kind: "cancelled" }
  /** Apple took the purchase but Plenty couldn't link it yet. Restoring finishes it, and never charges twice. */
  | { kind: "unlinked"; message: string };

export async function buyFromStore(productId: string): Promise<BuyResult> {
  const plugin = purchasesPlugin();
  if (!plugin) throw new BillingRequestError(NOT_IN_APP);
  // Tags the purchase with this household, so Apple's own notifications find it too.
  const { token } = await requestJson<{ token: string }>("GET", "/api/billing/account-token");
  let result: Awaited<ReturnType<PurchasesPlugin["purchase"]>>;
  try {
    result = await plugin.purchase({ productId, appAccountToken: token });
  } catch {
    throw new BillingRequestError(STORE_PROBLEM);
  }
  if (result.status === "cancelled") return { kind: "cancelled" };
  if (result.status === "pending") {
    return { kind: "pending", message: "Waiting for approval. When it's approved, your plan will update on its own; you can also tap Restore purchases." };
  }
  if (!result.signedTransaction) throw new BillingRequestError(STORE_PROBLEM);
  try {
    const linked = await linkTransaction({ signedTransaction: result.signedTransaction, signedRenewalInfo: result.signedRenewalInfo });
    return { kind: "linked", message: linked.message };
  } catch {
    return {
      kind: "unlinked",
      message: "Apple has your purchase, but we couldn't link it to your household just now. Tap Restore purchases in a moment. You won't be charged again.",
    };
  }
}

export async function restoreFromStore(): Promise<LinkResult> {
  const plugin = purchasesPlugin();
  if (!plugin) throw new BillingRequestError(NOT_IN_APP);
  let found: SignedTransaction[];
  try {
    found = (await plugin.restore()).transactions;
  } catch {
    throw new BillingRequestError("The App Store didn't answer. Check you're signed in to the App Store and try again.");
  }
  if (found.length === 0) {
    return { outcome: "nothing_to_restore", message: "There's no active Plenty subscription on this Apple ID." };
  }
  // Try each until one links; a refusal (another household's, or a different plan already in force) is told plainly.
  let refusal: unknown = null;
  for (const transaction of found) {
    try {
      return await linkTransaction(transaction);
    } catch (err) {
      refusal = err;
    }
  }
  throw refusal instanceof Error ? refusal : new BillingRequestError(STORE_PROBLEM);
}
