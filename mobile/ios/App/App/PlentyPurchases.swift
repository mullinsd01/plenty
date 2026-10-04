import Foundation
import UIKit
import StoreKit
import Capacitor

/// In-app purchases for Plenty's subscriptions, with StoreKit 2 and no third-party SDK.
///
/// Reachable from the hosted website as `window.Capacitor.Plugins.PlentyPurchases`
/// (types: mobile/purchases.d.ts). The website asks, the App Store answers, and the
/// website sends the signed result to Plenty's server (`POST /api/billing/restore`),
/// which verifies it with Apple. Nothing from this device is trusted on its own.
///
/// Every method returns a promise. A failure rejects with a plain English message
/// (and a short `code`); a purchase the person cancels is not a failure, it resolves
/// with `status: "cancelled"`.
@objc(PlentyPurchasesPlugin)
public class PlentyPurchasesPlugin: CAPInstancePlugin, CAPBridgedPlugin {
    public let identifier = "PlentyPurchasesPlugin"
    public let jsName = "PlentyPurchases"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manageSubscriptions", returnType: CAPPluginReturnPromise)
    ]

    // MARK: - products({ productIds })

    /// The subscriptions the App Store knows about, with the price to show in the
    /// person's own currency.
    @objc func products(_ call: CAPPluginCall) {
        guard let ids = call.getArray("productIds", String.self), !ids.isEmpty else {
            call.reject("productIds must be a list of product ids.", "INVALID_ARGUMENT")
            return
        }
        Task {
            do {
                let found = try await Product.products(for: ids)
                var byId = [String: Product]()
                for product in found {
                    byId[product.id] = product
                }
                var list: [[String: Any]] = []
                var seen = Set<String>()
                // Keep the order the website asked for. Anything that is not a monthly
                // or yearly subscription is left out: Plenty sells nothing else.
                for id in ids where !seen.contains(id) {
                    seen.insert(id)
                    guard let product = byId[id], let period = PlentyPurchasesPlugin.period(of: product) else { continue }
                    list.append([
                        "productId": product.id,
                        "displayName": product.displayName,
                        "displayPrice": product.displayPrice,
                        "period": period
                    ])
                }
                call.resolve(["products": list])
            } catch {
                self.fail(call, error)
            }
        }
    }

    // MARK: - purchase({ productId, appAccountToken })

    /// Shows Apple's purchase sheet. `appAccountToken` (a UUID string from
    /// `GET /api/billing/account-token`) is stored by Apple on the transaction, which is
    /// how Plenty's server finds the household when Apple later reports a renewal.
    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId"), !productId.isEmpty else {
            call.reject("productId is required.", "INVALID_ARGUMENT")
            return
        }
        guard let tokenText = call.getString("appAccountToken"), let token = UUID(uuidString: tokenText) else {
            call.reject("appAccountToken must be a UUID.", "INVALID_ARGUMENT")
            return
        }
        Task {
            do {
                guard let product = try await Product.products(for: [productId]).first else {
                    throw PlentyPurchaseFailure(
                        message: "That plan isn't available from the App Store right now. Please try again later.",
                        code: "PRODUCT_UNAVAILABLE"
                    )
                }
                let result = try await product.purchase(options: [.appAccountToken(token)])
                switch result {
                case .success(let verification):
                    switch verification {
                    case .verified(let transaction):
                        var payload: [String: Any] = [
                            "status": "purchased",
                            "signedTransaction": verification.jwsRepresentation
                        ]
                        if let renewal = await PlentyPurchasesPlugin.signedRenewalInfo(for: transaction) {
                            payload["signedRenewalInfo"] = renewal
                        }
                        // Hand the signed purchase to the website first. Only then tell
                        // the App Store it has been delivered.
                        call.resolve(payload)
                        await transaction.finish()
                    case .unverified:
                        // Not finished on purpose: it stays in the queue, and Restore can find it.
                        call.reject(
                            "The App Store couldn't verify this purchase, so Plenty hasn't applied it. If you were charged, choose Restore purchases.",
                            "UNVERIFIED"
                        )
                    }
                case .pending:
                    // Ask to Buy or another approval step. Apple reports it when it completes.
                    call.resolve(["status": "pending"])
                case .userCancelled:
                    call.resolve(["status": "cancelled"])
                @unknown default:
                    call.reject("The App Store gave an answer Plenty doesn't understand. Please try again.", "UNKNOWN")
                }
            } catch let error as StoreKitError {
                if case .userCancelled = error {
                    call.resolve(["status": "cancelled"])
                } else {
                    self.fail(call, error)
                }
            } catch {
                self.fail(call, error)
            }
        }
    }

    // MARK: - restore()

    /// Asks the App Store to refresh this person's purchases (it may ask them to sign in),
    /// then returns every active subscription as signed data for the server to verify.
    @objc func restore(_ call: CAPPluginCall) {
        Task {
            do {
                try await AppStore.sync()
            } catch let error as StoreKitError {
                if case .userCancelled = error {
                    call.reject("Restoring was cancelled.", "CANCELLED")
                } else {
                    self.fail(call, error)
                }
                return
            } catch {
                self.fail(call, error)
                return
            }

            var transactions: [[String: Any]] = []
            for await result in StoreKit.Transaction.currentEntitlements {
                guard case .verified(let transaction) = result, transaction.productType == .autoRenewable else { continue }
                var item: [String: Any] = ["signedTransaction": result.jwsRepresentation]
                if let renewal = await PlentyPurchasesPlugin.signedRenewalInfo(for: transaction) {
                    item["signedRenewalInfo"] = renewal
                }
                transactions.append(item)
            }
            call.resolve(["transactions": transactions])
        }
    }

    // MARK: - manageSubscriptions()

    /// Apple's own sheet for changing or cancelling a subscription.
    @objc func manageSubscriptions(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let scene = self.bridge?.viewController?.view.window?.windowScene else {
                call.reject(
                    "Couldn't open subscription settings. Open the Settings app, tap your name, then Subscriptions.",
                    "UNAVAILABLE"
                )
                return
            }
            do {
                try await AppStore.showManageSubscriptions(in: scene)
                call.resolve()
            } catch {
                self.fail(call, error)
            }
        }
    }

    // MARK: - Helpers

    /// "monthly" or "annual", from the product's subscription period; nil for anything else.
    private static func period(of product: Product) -> String? {
        guard let period = product.subscription?.subscriptionPeriod else { return nil }
        switch (period.unit, period.value) {
        case (.month, 1):
            return "monthly"
        case (.year, 1), (.month, 12):
            return "annual"
        default:
            return nil
        }
    }

    /// The signed renewal information (auto-renew on or off, next price) for the
    /// subscription a transaction belongs to. Nil when the App Store can't say.
    private static func signedRenewalInfo(for transaction: StoreKit.Transaction) async -> String? {
        guard let groupID = transaction.subscriptionGroupID,
              let statuses = try? await Product.SubscriptionInfo.status(for: groupID) else { return nil }
        for status in statuses {
            guard case .verified(let statusTransaction) = status.transaction,
                  statusTransaction.originalID == transaction.originalID else { continue }
            if case .verified = status.renewalInfo {
                return status.renewalInfo.jwsRepresentation
            }
        }
        return nil
    }

    private func fail(_ call: CAPPluginCall, _ error: Error) {
        let failure = PlentyPurchasesPlugin.describe(error)
        call.reject(failure.message, failure.code)
    }

    /// Plain English for what went wrong, and a short stable code for the website.
    private static func describe(_ error: Error) -> (message: String, code: String) {
        if let failure = error as? PlentyPurchaseFailure {
            return (failure.message, failure.code)
        }
        if let purchaseError = error as? Product.PurchaseError {
            switch purchaseError {
            case .productUnavailable:
                return ("That plan isn't available from the App Store right now. Please try again later.", "PRODUCT_UNAVAILABLE")
            case .purchaseNotAllowed:
                return ("Purchases are turned off on this iPhone, for example by Screen Time or a restriction.", "PURCHASES_DISABLED")
            default:
                break
            }
        }
        if let storeError = error as? StoreKitError {
            switch storeError {
            case .networkError:
                return ("Couldn't reach the App Store. Check your internet connection and try again.", "NETWORK")
            case .userCancelled:
                return ("Cancelled.", "CANCELLED")
            default:
                break
            }
        }
        return ("The App Store couldn't complete that: \(error.localizedDescription)", "UNKNOWN")
    }
}

/// A failure with its own message, for the places where StoreKit throws nothing.
private struct PlentyPurchaseFailure: Error {
    let message: String
    let code: String
}

/// Keeps the App Store's transaction queue clean for the whole life of the app.
///
/// `Transaction.updates` delivers purchases that did not come from `purchase()`:
/// renewals while the app is open, an Ask to Buy that was approved, a purchase
/// made on another device. Plenty's server learns about those from Apple's own
/// server notifications, so all this does is mark verified ones as delivered
/// (`finish()`). Unverified ones are left alone.
///
/// Started once from `AppDelegate.application(_:didFinishLaunchingWithOptions:)`:
/// StoreKit asks apps to listen from launch, not from the first purchase.
enum PlentyTransactions {
    private static let observer: Task<Void, Never> = Task.detached(priority: .utility) {
        for await result in StoreKit.Transaction.updates {
            if case .verified(let transaction) = result {
                await transaction.finish()
            }
        }
    }

    static func startListening() {
        _ = observer
    }
}
