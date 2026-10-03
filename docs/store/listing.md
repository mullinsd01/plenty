# Store listing preparation (App Store and Google Play)

Drafts for App Store Connect and Play Console. Everything here is limited to what exists in the code today and to the plans in `src/lib/billing/plans.ts`. Re-run the claims check at the bottom against the build you submit. Nothing here has been entered into either console.

Facts used: Plans **Free**, **Plus** ($4.99/month, $49.99/year) and **Family** ($8.99/month, $89.99/year). **Pro is not launched** and must not appear. **No free trial** (`TRIAL_DAYS = 0`). Prices are US-dollar list prices; each store shows the local price.

## 1. Basics

| Field | Value | Limit / note |
|---|---|---|
| App name | **Plenty** | ≤ 30 characters (Apple 2.3.7). Check uniqueness in both stores |
| Subtitle (Apple) | **Your kitchen, figured out** (25) | ≤ 30; no prices, no unverifiable claims, no other apps |
| Short description (Play) | **Know what you have, what's running low and what to buy.** (55) | ≤ 80 |
| Promotional text (Apple) | **Keep one list of what's in your kitchen, check each receipt before it counts, and see what's on its way out.** (108) | ≤ 170; can change without a new build |
| Keywords (Apple) | `pantry,grocery list,shopping list,meal planner,receipt,food waste,expiry,household,kitchen` (90) | ≤ 100 characters, comma-separated, no spaces, no competitor or trademark names |
| Category | Apple: Food & Drink (alternative: Lifestyle). Play: Food & drink | Pick the closest; Apple may change it (2.3.5) |
| Support URL | `${APP_URL}/support` | Public page; set `SUPPORT_EMAIL` |
| Privacy policy URL | `${APP_URL}/privacy` | Required by both stores and in the app |
| Terms of use (EULA) URL | `${APP_URL}/terms` | Link it in the Apple description and the paywall |
| Account deletion URL (Play) | `${APP_URL}/delete-account` | Enter in Play Console's designated field and Data safety form |
| Marketing URL (optional) | `${APP_URL}` | |
| Contact | `SUPPORT_EMAIL`, `PRIVACY_CONTACT_EMAIL`, entity `LEGAL_ENTITY_NAME` | Must be set in production or the public pages omit them |

## 2. Full description (draft)

Only the lines that exist today. Two Plus features, **barcode scanning** and **photo recognition**, are in the plan list but not built: **delete those lines from the description and screenshots unless they ship in the build you submit.**

> Plenty keeps track of what's in your kitchen, so you know what you have, what's running low and what to buy.
>
> **Start free**
> • One household for up to two people
> • Up to 50 items in your kitchen, added by hand
> • A shared shopping list, including requests from people in your household
> • Assign items to the people in your household
> • Scan 5 receipts a month, then check them before anything is added
> • Expiry reminders
> • Plenty records what you finish, waste and buy
> • "What can I make?" from what you have
>
> **Plenty Plus** — $4.99 a month or $49.99 a year
> • Everything in Free, for up to 6 people
> • Unlimited kitchen items and receipt scans
> • Optional AI-assisted receipt reading, only if you turn it on
> • Run-out predictions that explain themselves
> • Smart low-stock alerts and automatic shopping suggestions
> • Recurring purchases
> • Weekly meal plans that turn into shopping lists
> • Purchase history and email notifications
> • *(Only if shipped: barcode scanning and photo recognition.)*
>
> **Plenty Family** — $8.99 a month or $89.99 a year
> • Everything in Plus, for up to 12 people
> • Food owned by individuals or the household, with private items
> • Each person's own consumption pattern
> • Household grocery and waste analytics
> • Priority support
>
> **Your data stays yours.** Receipt photos are deleted once you've checked them, unless you choose to keep them. Nothing is sent to an outside AI service unless you turn that on. Delete your account any time in Settings.
>
> **Subscriptions.** Plenty Plus and Plenty Family are auto-renewing subscriptions, billed monthly or yearly to your App Store (or Google Play) account, and renew automatically unless you cancel at least 24 hours before the period ends. You can manage or cancel in your account settings in the store. Prices may vary by region. Plenty is a planning aid: estimates, expiry dates and meal suggestions can be wrong, and Plenty doesn't give medical, dietary or food-safety advice. Check labels, especially for allergies.
>
> Privacy Policy: {APP_URL}/privacy · Terms of Use: {APP_URL}/terms

(The renewal sentence is Apple's customary wording; confirm it against Schedule 2 and the subscription group set up in App Store Connect before submitting.)

## 3. Screenshot plan

Capture on the demo household (`npm run db:seed`), light mode, real UI only, no mock-ups. Apple requires iPhone sizes (and iPad if the app supports iPad); Play needs phone screenshots (7-inch and 10-inch tablets optional). Screenshots must show the app in use, not login or splash screens (Apple 2.3.3). Don't show Pro, a trial, or any price other than those above.

1. **Home**: what's running low, what to use soon.
2. **Kitchen**: items by location with expiry.
3. **Shopping list**: with reasons ("running low", "for Tuesday's pasta").
4. **Receipt review**: "Check your receipt", a few lines and the confirm button.
5. **Meals**: "What can I make?" or the weekly plan (weekly plan is Plus).
6. **What Plenty knows** (Family: household analytics), only if the demo household is on Family.
7. **Privacy & data**: the AI permission and receipt photo choices (a differentiator, and honest).
8. (Optional) **People & private items** on Family.

## 4. Age rating questionnaire (draft answers)

Apple's age-rating and Google's IARC questionnaires change over time; the wording below was **not** re-read for this draft. Answer from these facts and re-check each question.

| Topic | Answer | Because |
|---|---|---|
| Violence, sexual content, nudity, profanity, horror, drugs, alcohol/tobacco/drug references, gambling, contests | None | Grocery planning; no such content. (Receipts or catalog may include alcohol or tobacco products as shopping items: if a question asks about "references to alcohol/tobacco", answer for incidental product names, i.e. the lowest frequency, and check the question wording.) |
| User-generated content / social features | No public UGC; no messaging; household members see each other's names and notes in a private, invite-only household | Assessed under Apple 1.2 in the audit |
| Unrestricted web access | No | In-app links open the legal pages and store subscription pages |
| Medical or health information | None provided. Allergy and diet settings filter meals; Plenty states it gives no medical advice | Don't tick "medical or treatment information" |
| Location | Not collected | |
| Purchases | Yes, auto-renewing subscriptions | |
| AI features | Optional, off by default, disclosed | Check whether the current questionnaire asks about generative AI |
| Target audience (Play) | Adults (18+). Do not select under-13 groups | See the audit, decision 3 |

Expected result: Apple low age rating (4+ under the old scheme), Google "Everyone" or equivalent. Don't pick "Made for Kids".

## 5. App Privacy ("nutrition label") answers: Apple

Derived from `docs/compliance/data-map.md`. Re-check against Apple's data-type definitions when filling in; the wording below is a plan, not a verified form.

**Data used to track you:** none. (No advertising identifier, no third-party SDKs, no cross-app or cross-site tracking. ATT not needed unless this changes.)

| Data type | Collected? | Linked to the user? | Used for | Notes |
|---|---|---|---|---|
| Contact Info: email address, name | Yes | Yes | App functionality | Account sign-in; name is a display name |
| User Content: photos or videos | Yes (receipt photos) | Yes | App functionality | Deleted after review by default; sent to the AI provider only with consent. Declare the photo as collected, and that a third party receives it only if the person opts in |
| User Content: other user content | Yes (items, lists, notes, recipes, household names) | Yes | App functionality | |
| Purchases | Yes (subscription status and ids) | Yes | App functionality | Payment details are with Apple/Google/Stripe, not Plenty |
| Usage Data: product interaction | Yes (first-party counts) | Treat as linked (pseudonymous household key) | Analytics | See audit decision 1 (consent) |
| Identifiers: user ID | Yes (account id) | Yes | App functionality | |
| Health & Fitness | **Decision:** diets and allergies are entered for meal filtering. Declare conservatively (as health-related) unless Apple's definition clearly excludes dietary preferences | Yes | App functionality | Included in AI recipe requests only with consent |
| Diagnostics, location, contacts, browsing/search history, financial info, sensitive info | No | | | Receipts keep prices, not card or bank details (redacted) |

## 6. Data safety answers: Google Play

Same source. The Play form's definitions were **not** read (blocked); the answers are a plan to check.

| Question | Answer |
|---|---|
| Does the app collect or share user data? | Collects: yes. Shares: only the optional AI processing, which sends data to a service provider that processes it for Plenty. Check whether Google counts that as "sharing" (the provider processes on Plenty's behalf) and be conservative if unsure |
| Data types collected | Personal info: email address, name, user IDs. Photos and videos: photos (receipts). App activity: app interactions, other user-generated content. Financial info: purchase history (subscription status; no card details). Health and fitness: consider declaring for allergies and diets |
| Is all data encrypted in transit? | Yes, when served over HTTPS (set up TLS at the host) |
| Can users request data deletion? | Yes: in app (Settings → Account) and on the web at `${APP_URL}/delete-account` |
| Optional or required | Account data required; photos, AI processing and analytics optional |
| Purposes | App functionality, account management, analytics (first-party), fraud prevention and security (rate limiting) |
| Independent security review | No |

## 7. Subscription information block

Use on the paywall (Apple 3.1.2(c) and Schedule 2; Google's equivalent) and, in the same words, in App Store Connect's subscription descriptions. Show it before the purchase sheet.

> **Plenty Plus** — $4.99 per month or $49.99 per year. **Plenty Family** — $8.99 per month or $89.99 per year. *(Local price shown at purchase.)*
> Payment is charged to your Apple ID (or Google Play) account at confirmation of purchase. The subscription renews automatically at the same price and length unless cancelled at least 24 hours before the end of the current period. Manage or cancel it any time in your account settings in the store. The subscription belongs to your household and works on every device. There is no free trial.
> [Terms of Use] · [Privacy Policy] · [Restore Purchases]

Group both plans in one subscription group so a person can't hold two (Apple 3.1.2(b)). Never describe the price as "free trial", "free for N days" or "save N%" unless the products and `TRIAL_DAYS` are changed together (`docs/billing.md`).

## 8. Review notes and demo account (draft)

> **Demo account:** email `demo@plenty.app`, password `plenty-demo` (also: tap "Explore the demo household" on the sign-in screen). The demo household is shared, so name, email and password can't be changed and it can't be deleted; to see account creation and deletion, create a new account (Settings → Account → Delete my account shows exactly what is removed; it needs your password and the word DELETE).
> **What the app is:** a household grocery and meal planner. Sign-up is email and password only (no third-party login). There is no public or cross-household content: people only see their own household.
> **Camera:** used only when you tap "Take a photo" on Scan a receipt, to photograph a receipt. "Choose a photo" works without the camera.
> **AI:** optional and off by default. The first time a Plus household opens Scan a receipt it is asked for permission, with what is sent, to whom and how to turn it off (Settings → Privacy & data). Without permission receipts are read on Plenty's own server.
> **Purchases:** Plenty Plus and Plenty Family are auto-renewing subscriptions bought only through in-app purchase in this app, with Restore Purchases. [Describe where the reviewer finds them and sandbox steps.] No web checkout or external purchase link appears in the app.
> **Privacy:** Settings → Privacy & data; public pages: privacy, terms, support, delete-account.

## 9. Needs a human or an external credential

* Apple Developer Program (organisation account recommended), App Store Connect app record, subscription group and four auto-renewing products, sandbox testers, App Store Server Notification URLs, root certificates, `APPLE_BUNDLE_ID`, `APPLE_APP_ID` (see `docs/billing.md`).
* Google Play developer account, app record, four subscription products, a service account with Play permissions, Pub/Sub push subscription, `GOOGLE_PLAY_PACKAGE_NAME`, Data safety, content rating, target audience, account-deletion URL.
* Native shells (not in this repository): purchase sheets, Restore Purchases, camera permission string, platform header, no web checkout; Play Billing Library 8+, target API 36 (verified requirement as of 2026-10-01).
* Stripe account and webhook for web purchases.
* Production environment: `LEGAL_ENTITY_NAME`, `SUPPORT_EMAIL`, `PRIVACY_CONTACT_EMAIL`, `ANALYTICS_SECRET` (without it production records no analytics), `CRON_SECRET` plus a scheduler calling `/api/cron/notifications` at least hourly (it also deletes expired receipt photos and old analytics), `SMTP_URL`, `ANTHROPIC_API_KEY` (only if AI is offered; Plus only), `DEMO_MODE=true` for review.
* Legal review of Privacy Policy and Terms; a decision on analytics consent (opt-in), child accounts, and the AI "report" action (audit decisions 1–3).
* App icon, screenshots on devices, a support mailbox someone reads.

## 10. Claims check

Every marketing claim above, mapped to code. If a row can't be ticked for the build, remove the claim.

| Claim | Where it lives | Status |
|---|---|---|
| One household, up to 2 people on Free; 6 on Plus; 12 on Family | `max_household_members` in `src/lib/billing/plans.ts`; enforced by `assertRoomForMember` | Built |
| Up to 50 items on Free; unlimited on Plus | `max_inventory_items`; `assertRoomForItems` (`src/server/billing/limits.ts`) | Built |
| Shared shopping list with requests | `src/server/services/shopping.ts` (`addRequest`) | Built |
| Assign items to people; private items (Family) | `ownerMemberId`, `visibility` in `inventory_items`; RLS in `drizzle/0004_rls_members_privacy.sql`; `member_ownership` | Built |
| 5 receipt scans a month on Free; unlimited on Plus | `receipt_scans_per_month`; `receiptScanAllowance` | Built |
| Check each receipt before anything is added | `confirmReceipt` only changes the kitchen on confirmation (`src/server/services/receipts.ts`) | Built |
| Expiry reminders | `use_soon` notifications in `src/server/services/notification-jobs.ts` | Built |
| Records what you finish, waste and buy | `consumption_events`, `inventory_events` | Built |
| "What can I make?" | `src/app/(app)/meals/cook` | Built |
| Optional AI-assisted receipt reading, only if you turn it on | `src/server/ai/consent.ts`; `tests/integration/ai-consent.test.ts` | Built |
| Run-out predictions that explain themselves | `predictions.reason`; `consumption_predictions` | Built |
| Smart low-stock alerts and automatic shopping suggestions | `smart_replenishment`; `planFlags` | Built |
| Recurring purchases | `recurring_items`; `src/server/services/recurring.ts` | Built |
| Weekly meal plans that turn into shopping lists | `advanced_meal_planning`; `mealPlanToList` | Built |
| Purchase history; email notifications | `purchase_history`; `emailDigest` (`advanced_notifications`) | Built |
| Household grocery and waste analytics; each person's own pattern | `household_analytics`; `individualPatterns` | Built |
| Priority support | `priority_support` flag only | **Operational promise, not code**: only keep it if someone answers Family users first |
| Barcode scanning; photo recognition | `barcode_scanning`, `photo_recognition` flags and `product_barcodes` table | **Not built**: remove unless shipped |
| Receipt photos deleted once checked, unless you choose to keep them | `src/server/services/receipt-privacy.ts`; `tests/integration/receipt-privacy.test.ts` | Built |
| Nothing is sent to an AI service unless you turn it on | same as above; `tests/unit/ai-consent.test.ts` | Built |
| Delete your account any time | `src/features/privacy/delete-account.tsx`; `tests/integration/account-deletion.test.ts` | Built |
| Works on every device; belongs to the household | `subscriptions.householdId` | Built (server) |
| Renews automatically; cancel in the store; no free trial | `docs/billing.md`; `TRIAL_DAYS = 0` | Built (server); confirm in the shipped paywall |
| "Plenty doesn't give medical, dietary or food-safety advice" | `src/app/(legal)/terms/page.tsx` | Built |
| No ads, no tracking | no ad or analytics SDKs in `package.json`; `src/lib/privacy-content.ts` | True today; re-check if an SDK is added |
