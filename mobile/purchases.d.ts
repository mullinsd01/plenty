/**
 * Types for the native `PlentyPurchases` plugin in the iPhone app
 * (mobile/ios/App/App/PlentyPurchases.swift).
 *
 * The app injects Capacitor's bridge into the hosted site, so inside the app the
 * website can reach the plugin as
 *
 *     window.Capacitor.Plugins.PlentyPurchases
 *
 * In a normal browser `window.Capacitor` does not exist, so always check first:
 *
 *     const plugin = (window as { Capacitor?: PlentyCapacitor }).Capacitor?.Plugins?.PlentyPurchases;
 *
 * This file only exports types. It deliberately does not augment `Window`, so
 * importing it can't change how the rest of the website is type-checked.
 *
 * Every method returns a promise. It rejects with a {@link PlentyPurchasesError}
 * whose `message` is plain English that is safe to show. A purchase the person
 * cancels is not an error: it resolves with `status: "cancelled"`.
 *
 * What the website does with the results (the server, not the phone, decides
 * what a household gets):
 *   purchase / restore -> POST /api/billing/restore { provider: "apple", signedTransaction, signedRenewalInfo }
 */

export type PlentyBillingPeriod = "monthly" | "annual";

export interface PlentyStoreProduct {
  /** The App Store product id, for example `app.plenty.plus.monthly`. */
  productId: string;
  /** The name the App Store shows, in the person's language. */
  displayName: string;
  /** What Apple will charge, already formatted in the person's currency (for example "$4.99"). */
  displayPrice: string;
  period: PlentyBillingPeriod;
}

/** A signed transaction as Apple's JWS string, and, when Apple can say, the signed renewal information. */
export interface PlentySignedTransaction {
  /** `VerificationResult.jwsRepresentation` of the StoreKit 2 transaction. Send it to the server as is. */
  signedTransaction: string;
  /** JWS of the renewal information (auto-renew on or off, next price). Absent when unavailable. */
  signedRenewalInfo?: string;
}

export type PlentyPurchaseResult =
  | ({ status: "purchased" } & PlentySignedTransaction)
  /** Waiting for approval (for example Ask to Buy). Apple tells the server when it completes. */
  | { status: "pending"; signedTransaction?: undefined; signedRenewalInfo?: undefined }
  | { status: "cancelled"; signedTransaction?: undefined; signedRenewalInfo?: undefined };

/** Short stable codes that go with the message. Use the message for people, the code for logic. */
export type PlentyPurchasesErrorCode =
  | "INVALID_ARGUMENT"
  | "PRODUCT_UNAVAILABLE"
  | "PURCHASES_DISABLED"
  | "NETWORK"
  | "UNVERIFIED"
  | "CANCELLED"
  | "UNAVAILABLE"
  | "UNKNOWN";

/** What a rejected call throws (a Capacitor exception). `message` is a plain sentence. */
export interface PlentyPurchasesError extends Error {
  message: string;
  code?: PlentyPurchasesErrorCode;
}

export interface PlentyPurchasesPlugin {
  /**
   * The monthly and yearly subscriptions the App Store knows about, in the order asked.
   * Ids the App Store does not know, and products that are not monthly or yearly
   * subscriptions, are left out. Use `displayPrice` on the paywall: it is the price
   * in the person's own currency.
   */
  products(options: { productIds: string[] }): Promise<{ products: PlentyStoreProduct[] }>;

  /**
   * Show Apple's purchase sheet for one product.
   *
   * `appAccountToken` is a UUID string (GET /api/billing/account-token). Apple stores it on
   * the transaction, which is how the server finds the household when Apple later reports a
   * renewal or refund.
   *
   * The phone marks the transaction as delivered only after this promise has been resolved
   * with the signed data, so send it to the server straight away.
   */
  purchase(options: { productId: string; appAccountToken: string }): Promise<PlentyPurchaseResult>;

  /**
   * Ask the App Store to refresh this person's purchases (it may ask them to sign in), then
   * return every active subscription as signed data. Empty when there is none.
   * Call it from a visible "Restore purchases" button.
   */
  restore(): Promise<{ transactions: PlentySignedTransaction[] }>;

  /** Open Apple's own sheet for changing or cancelling a subscription. */
  manageSubscriptions(): Promise<Record<string, never>>;
}

/** The part of `window.Capacitor` the website uses inside the app. */
export interface PlentyCapacitor {
  isNativePlatform?: () => boolean;
  getPlatform?: () => "ios" | "android" | "web";
  Plugins?: {
    PlentyPurchases?: PlentyPurchasesPlugin;
    /** Used by the "Can't reach Plenty" page that ships inside the app. */
    PlentyShell?: { retry(): Promise<Record<string, never>> };
  };
}
