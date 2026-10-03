# Billing

How Plenty sells plans, decides what a household can do, and keeps that in step with Stripe, the App Store and Google Play. Read this before turning any provider on.

Status: the server side is built and tested with **synthetic** payloads only. Nothing here has been run against live Stripe, Apple or Google services (see [What is not verified](#what-is-not-implemented-or-not-verified-live)). Each provider switches itself off cleanly until it is configured.

## Principles

- **The household owns the subscription**, never a member. Only an owner (`manage_billing`) can buy, change, open the portal or restore.
- **The database is the source of truth.** What a household can do comes from its stored subscription row, resolved by `resolveEffectivePlan` (`src/lib/billing/subscription.ts`). Webhooks are the only thing that changes that row, as trusted system code (`systemDb`); the app role (`plenty_app`) can read its own household's subscription and usage and write neither (`drizzle/0004_rls_members_privacy.sql`).
- **The free plan is never blocked to force a purchase.** Limits only stop *adding more*. Finishing, removing, the shopping list and manual entry always work.
- **Never move a subscription silently.** A store subscription is linked to the household whose owner proves it with the store, and a subscription already linked to another household is refused with an explanation.
- **Never revoke on a guess, never grant after a refund.** The state machine ignores stale events, a late renewal can only push the paid-until date forward, and a refunded or expired period is only revived by a genuinely new paid period.
- **Only one subscription at a time.** A second one never replaces one that is giving access; the owners are told so they don't pay twice.
- **Pro exists but is not for sale.** It has no product ids, `startWebCheckout` refuses it, and nothing offers it. No free trial is offered (`TRIAL_DAYS = 0`) but the model supports trials end to end.

## Files

| Area | Path |
| --- | --- |
| Plans, prices, entitlements | `src/lib/billing/plans.ts` |
| What plan is in force | `src/lib/billing/subscription.ts` |
| Normalised events and the pure state machine | `src/lib/billing/events.ts` |
| Product id <-> plan/period mapping | `src/lib/billing/product-ids.ts` |
| Over-limit report after a downgrade | `src/lib/billing/over-limit.ts` |
| Where a subscription is managed, wording helpers | `src/lib/billing/management.ts` |
| Client platform detection (web / iOS / Android) | `src/lib/billing/platform.ts` |
| Apply an event to the database, idempotently | `src/server/billing/apply-event.ts` |
| Providers | `src/server/billing/providers/{stripe,apple,google,manual}.ts` |
| Service for the plan page | `src/server/billing/service.ts` |
| Limits (adding only) | `src/server/billing/limits.ts` |
| Loaders | `src/server/billing/entitlements.ts` |
| Notices to owners | `src/server/billing/notify.ts` |
| Store purchase token | `src/server/billing/account-token.ts` |
| Routes | `src/app/api/billing/**` |

## Event flow

```
 Stripe ──signed POST──►  /api/billing/webhooks/stripe ─┐
 Apple  ──signed JWS───►  /api/billing/webhooks/apple  ─┤  verify authenticity (raw body / certificate chain / OIDC token)
 Google ──Pub/Sub push─►  /api/billing/webhooks/google ─┤  400 if it can't be proven, 503 if unconfigured or to be retried
                                                        ▼
                         provider adapter: normalise to a BillingEvent
                         (Google: fetch the authoritative state from the Play API first)
                                                        ▼
        applyNormalizedEvent (one system transaction, serialised per household)
          1. insert billing_events (provider, event_id)  ── already processed? → "duplicate", stop
          2. find the household: existing subscription link → provider customer → purchase hint
          3. read the subscription row (FOR UPDATE)
          4. same subscription? a second one? a replacement purchase? → conflict / ignore / replace
          5. applyBillingEvent(state, event, now)  ── pure; stale and replayed events change nothing
          6. upsert the subscription row, mark the event processed
                                                        ▼
        after commit: analytics (subscription_started / subscription_cancelled),
                      owner notices (payment failed, paid twice)
                                                        ▼
 App request ─► resolveHouseholdPlan ─► resolveEffectivePlan(row, now) ─► ctx.plan (entitlements, limits)

 Owner in the web app ─► POST /api/billing/checkout ─► Stripe Checkout (hosted) ─► webhook (and /confirm on return)
 Owner in a native shell ─► store purchase sheet ─► store notification (and /restore on demand)
```

The reducer lives in `src/lib/billing/events.ts` and is pure: events carry `occurredAt`, and the stored `lastEventAt` makes it order-tolerant and idempotent.

## What each event does to access

| Event | Effect |
| --- | --- |
| started (monthly/annual, optional trial) | Plan applies; a trial is `trialing` until it ends |
| renewed | Next paid period begins; a scheduled plan change takes effect; grace is cleared |
| auto-renew off | Keeps the plan **until the period ends** (`canceled`), then free; a booked change is dropped |
| auto-renew on | Resumes, if the period hasn't ended |
| cancelled now | Access ends at that moment |
| payment failed | Grace period (`past_due`): access continues until `graceEndsAt`, then free; one calm notice per period; retries never stretch the grace |
| payment recovered | Back to active |
| paused / resumed | Free while paused; resumes with the stored period |
| expired | Free; the end date is kept as a record |
| refunded / revoked | Free **at once**, even mid-period; only a new paid period revives it |
| refund reversed | The refunded period is granted again |
| plan change | Upgrade: immediately. Downgrade or period-only change: scheduled (`pendingPlan`/`pendingPeriod`) for the next renewal; the household keeps what it paid for |
| snapshot (Stripe update, Google state) | The provider's own account of the subscription; never extends a grace period, never softens a refund |

Safety margins in `resolveEffectivePlan`: an auto-renewing subscription keeps its plan up to 3 days past its end while the renewal is confirmed (`RENEWAL_TOLERANCE_MS`), and a trial converting to paid gets the same tolerance. Paid time is never taken back early because a later payment failed.

## Idempotency and ordering

- Every delivery is recorded in `billing_events` (unique on provider + event id) in the same transaction as its effect. A repeat is a no-op, including two copies arriving at once.
- An event that arrives before its subscription (a renewal before the start) is recorded **unprocessed** and answered 503, so the provider redelivers it; it is applied then.
- An event older than the newest applied one cannot regress state. Events about an older period (a late expiry, a refund of last year's payment) never touch a newer one.
- A timestamp more than 5 minutes in the future is treated as "now", so one bad clock can't freeze a subscription.
- Events for one household are applied one at a time (an advisory lock).
- The audit trail stores only the event type, a short plain summary and the outcome. Never card details, names or free text.

## Downgrades and limits

Data is never deleted, hidden or locked. After a downgrade a household may be over a limit (people or items); `getBillingOverview(...).overLimit` says so in plain words, and only adding more is blocked (`assertRoomForMember`, `checkRoomForItems`, `consumeReceiptScan`) until the household is back under. Finishing and removing is always allowed, which is how it gets back under. Receipt scans are counted per calendar month in the household's time zone and reset on their own.

## Restoring purchases

`restorePurchases(ctx, "apple" | "google", proof)` (owner only):

1. The proof is verified **with the store**: Apple's signed transaction against the configured root certificates, bundle id and environment; Google's purchase token through `purchases.subscriptionsv2.get`. Nothing from the device is trusted.
2. If the purchase's account token names a household that exists and isn't this one, or the store subscription is already linked to another household, it is refused: *"A subscription belongs to one household and Plenty never moves it without that household's owner."*
3. If this household already has a different subscription giving access, it is refused (one at a time). A lapsed or refunded one is replaced.
4. Otherwise it is applied through the normal state machine and linked. Google purchases are then acknowledged (Google refunds unacknowledged purchases after three days).
5. Ended, refunded, family-shared and pending purchases say plainly why there is nothing to restore.

The household is found for later notifications by the store's own subscription id (Apple's original transaction id, Google's purchase token), never by the account-token hint once a link exists.

## Platform rules (no external purchase links in the apps)

Inside the iOS and Android shells there is **no web checkout, no billing-portal link and no price steering**. `detectPlatform(headers)` reads `X-Plenty-Platform: ios|android` (or a `PlentyApp/<version> (ios|android)` user-agent token); everything else is the web. `getBillingOverview(ctx, { platform })` and the `startWebCheckout` / `createPortalSession` routes enforce it. In a native shell a web subscription is explained in words ("managed on the web, from a browser") with no link, and the native shell buys through the store's own purchase sheet using `purchase.store.products` and the account token from `GET /api/billing/account-token`.

Apple's current guideline 3.1.1 (checked from the sandbox when this was written): apps must use in-app purchase to unlock features, need a restore mechanism, and outside the US storefront may not include buttons, external links or other calls to action that direct customers to other purchasing mechanisms. 3.1.2 requires clear disclosure of what the customer gets for the price and no inadvertent subscriptions to several variations of the same thing. Re-read both before every submission; they change.

## Setup

All of it is optional. Each provider is offered only when everything it needs is set. Secrets are server-side only.

### Common

```
BILLING_ACCOUNT_SECRET=<openssl rand -base64 48>   # 32+ chars; required for store purchases to find their household
APP_URL=https://your.domain                        # used for checkout return URLs and the Google audience
```

Product ids are `plan.period=id` pairs. The stores default to `app.plenty.<plan>.<period>` (`app.plenty.plus.monthly`, `app.plenty.plus.annual`, `app.plenty.family.monthly`, `app.plenty.family.annual`); override with `APPLE_PRODUCTS` / `GOOGLE_PRODUCTS`. Google products with a base plan may be written `app.plenty.plus:monthly`. Stripe has no defaults.

### Stripe (web)

1. Create two Products (Plenty Plus, Plenty Family), each with a monthly and a yearly recurring Price at the listed US-dollar amounts ($4.99 / $49.99 and $8.99 / $89.99). Do not create anything for Pro.
2. Set `STRIPE_SECRET_KEY` (a restricted key is better: Checkout Sessions, Customers, Billing Portal Sessions, Subscriptions, Invoices, Invoice Payments: write/read as needed) and `STRIPE_PRICES=plus.monthly=price_...,plus.annual=price_...,family.monthly=price_...,family.annual=price_...`.
3. Dashboard -> Developers -> Webhooks -> add `https://your.domain/api/billing/webhooks/stripe` and subscribe to: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `subscription_schedule.created`, `subscription_schedule.updated`, `subscription_schedule.released`, `subscription_schedule.canceled`, `checkout.session.completed`. Copy the signing secret to `STRIPE_WEBHOOK_SECRET`.
4. Dashboard -> Settings -> Billing -> Customer portal: allow updating payment method, cancelling, and switching between the four prices; set the return URL to `APP_URL/settings/plan`. Cancellation must be available and not hidden behind a retention flow.
5. Set the retry schedule (Settings -> Billing -> Subscriptions and emails) so the last retry is within `STRIPE_GRACE_DAYS` (7); Plenty gives a 7-day grace period from the first failure and stops access when Stripe gives up (`unpaid`).
6. Test with `stripe listen --forward-to localhost:3000/api/billing/webhooks/stripe` and test cards, in test mode, before going live.

### App Store (iOS)

1. App Store Connect: create one subscription group and the four auto-renewable products with the ids above. Subscription durations of one month and one year; prices matching the paywall. No introductory offer unless `TRIAL_DAYS` is raised and the paywall changes with it.
2. Download Apple's root certificates (https://www.apple.com/certificateauthority/ — Apple Root CA - G3 and G2) and set `APPLE_ROOT_CERTS=/path/AppleRootCA-G3.cer,/path/AppleRootCA-G2.cer` (or base64 DER).
3. Set `APPLE_BUNDLE_ID` and `APPLE_APP_ID` (the app's numeric id; production notifications are refused without it).
4. App Store Connect -> App Information -> App Store Server Notifications: set the production **and** sandbox URL to `https://your.domain/api/billing/webhooks/apple`, version 2. Sandbox notifications are accepted on the production server on purpose (App Review tests that way).
5. The native shell must, for each purchase, set `appAccountToken` to the value of `GET /api/billing/account-token`, show Apple's purchase sheet, include a **Restore Purchases** button (StoreKit `AppStore.sync()`, then send the current subscription transaction to `POST /api/billing/restore`), and link to Apple's subscription settings. The server verifies revocation (OCSP) over the network, so it needs outbound access to Apple.

### Google Play (Android)

1. Play Console: create one subscription with base plans (monthly, annual) per plan, product ids as above (or set `GOOGLE_PRODUCTS`).
2. Create a service account in Google Cloud, link it in Play Console -> Setup -> API access, grant it permission to view financial data and manage orders and subscriptions, and set `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (JSON, or base64 of it) and `GOOGLE_PLAY_PACKAGE_NAME`.
3. Real-time developer notifications: create a Pub/Sub topic, grant `google-play-developer-notifications@system.gserviceaccount.com` the Publisher role on it, and enter the topic in Play Console -> Monetization setup.
4. Create a **push** subscription to `https://your.domain/api/billing/webhooks/google` with authentication enabled, using a dedicated service account; set `GOOGLE_PUBSUB_SERVICE_ACCOUNT` to its email. `GOOGLE_PUBSUB_AUDIENCE` must equal the audience configured on the subscription (default: `APP_URL/api/billing/webhooks/google`).
5. The native shell sets `obfuscatedAccountId` to the account token, completes the purchase, and offers **Restore** (`POST /api/billing/restore` with the purchase token). Plenty acknowledges purchases itself once they reach a household.

### Manual grants

`src/server/billing/providers/manual.ts` (`grantPlan`, `revokeGrant`, `grantDemoPlan`) is for scripts and support only; there is deliberately no web route. A grant never overrides a paid subscription and is never counted as a sale.

## Routes

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /api/billing` | signed in, not a child | `BillingOverview` |
| `POST /api/billing/checkout` `{plan, period}` | owner, web client | `{ url }` to hosted Checkout |
| `POST /api/billing/portal` | owner, web client | `{ url }` to the billing portal |
| `POST /api/billing/confirm` `{sessionId}` | owner | confirm a web purchase on return from Checkout |
| `POST /api/billing/restore` `{provider, ...proof}` | owner | link a store purchase |
| `GET /api/billing/account-token` | owner | the household's store purchase token |
| `POST /api/billing/webhooks/{stripe,apple,google}` | the provider | signature / certificate / OIDC authenticated; 400 bad, 503 unconfigured or retry, 2xx handled |

Signed-in POSTs require `application/json`, check `Origin` when present, and are rate limited per household. A provider that isn't configured answers 503 `{ code: "not_configured" }`, and the overview reports it as unavailable so the UI never offers it.

## What is not implemented or not verified live

- **Nothing has run against live Stripe, Apple or Google.** Payloads in the tests are synthetic and shaped from the SDK types and public documentation. Field names, event timing and subtype behaviour (especially Apple `DID_CHANGE_RENEWAL_PREF`, Google `deferredItemReplacement`, Stripe subscription schedules) must be confirmed in each provider's sandbox/test mode.
- The Apple certificate chain in tests is a throwaway chain generated with OpenSSL, with online (OCSP) checks off. The production path, including revocation checks and Apple's real roots, is untested.
- The Google service-account call and the OIDC token verification are mocked at the module boundary in integration tests; the real calls are untested.
- No native iOS/Android code exists here: the purchase sheets, `appAccountToken` / `obfuscatedAccountId`, restore buttons and the platform header are the shells' job.
- Apple Family Sharing purchases are deliberately not supported. Offer codes, promotional offers, win-back offers, price-increase consent flows and Stripe coupons are ignored (access is unchanged; Apple and Stripe tell the customer directly).
- Taxes, invoices, receipts and regional pricing are the providers'. The paywall shows US-dollar list prices; the checkout or store shows the customer's real price.
- Disputes/chargebacks on Stripe (`charge.dispute.*`) aren't handled beyond the subscription ending when Stripe ends it.
- No admin UI for grants, replaying failed events, or reconciling against the providers. Failed events are left in `billing_events` (`processed_at is null`, with an `error`); the providers redeliver them.

## Pre-launch checklist

Compliance (audit against the **current** text; do not rely on this document):

- [ ] Re-read Apple App Store Review Guidelines 3.1.1 (in-app purchase, restore, external links), 3.1.2 (subscriptions, disclosure, trials, upgrade/downgrade), 2.3.2 (metadata) and Schedule 2 of the Developer Program License Agreement. Confirm the iOS shell shows no external purchase link or call to action.
- [ ] Re-read Google Play's Payments policy and subscription requirements (support.google.com / play.google.com are not reachable from the development sandbox).
- [ ] The paywall, in every client, shows before confirming: price, billing period, that it renews automatically, how to cancel, and what the plan includes — and nothing that isn't built.
- [ ] No button or copy calls something "free" that isn't; the free plan is never blocked to force a subscription.
- [ ] Store listings and screenshots say which features need a subscription (2.3.2).
- [ ] Cancellation is as easy as subscribing, from the place the subscription was bought.

Provider setup:

- [ ] Stripe: live products and prices match the paywall to the cent; webhook endpoint registered with the events above; portal configured; retry schedule set; a real small purchase, renewal, cancel, failed payment and refund walked through in test mode first.
- [ ] Apple: products approved; root certificates installed; sandbox **and** production notification URLs set; sandbox purchases, renewals, cancel, billing retry, refund and restore walked through; `APPLE_APP_ID` set.
- [ ] Google: products active; service account linked with the right permissions; Pub/Sub push subscription authenticated; license-testing purchases walked through, including an upgrade (`linkedPurchaseToken`), grace period, account hold and revoke.
- [ ] `BILLING_ACCOUNT_SECRET` set (32+ random characters), kept stable (changing it orphans in-flight purchases' household hints).
- [ ] `PLAN_OVERRIDE` is **unset** in production.
- [ ] Webhook endpoints are reachable only over HTTPS and not behind anything that rewrites the body (raw-body signature checks).
- [ ] Alerting on 5xx from the webhook routes and on `billing_events` rows with `processed_at is null` older than a day.

Behaviour:

- [ ] Walk a real household through: buy, renew, turn renewal off (keeps access to period end), fail a payment (grace, notice), recover, upgrade (immediate), downgrade (scheduled), refund (immediate), resubscribe.
- [ ] Downgrade a household over its limits and confirm nothing is deleted or hidden and only adding waits.
- [ ] Try to restore one household's store subscription from another household: it must be refused.
- [ ] Confirm Pro is not offered anywhere and `TRIAL_DAYS` is still 0 unless the paywall and store products were changed together.
- [ ] Privacy: the privacy policy and store data-safety / privacy-label entries mention the payment provider and the minimal billing data kept (household id, plan, dates, provider ids).

## Tests

```
TEST_DATABASE_URL=postgres://plenty:plenty@localhost:5432/plenty_test_billing \
  npx vitest run tests/unit/billing-events.test.ts tests/unit/billing-plans.test.ts tests/unit/billing-providers.test.ts tests/integration/billing.test.ts
```

Always point integration tests at their own database; the test setup drops and recreates it. The unit tests need no database and no network. The fixtures (`tests/helpers/billing-fixtures.ts`) are synthetic and labelled as such; the Apple tests need `openssl` and skip themselves without it.
