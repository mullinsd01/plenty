# Plenty data map

What Plenty stores, why, who can see it, who else handles it, how long it is kept and how it is deleted. Verified against `src/server/db/schema.ts`, `drizzle/0003_members_privacy_billing.sql`, `drizzle/0004_rls_members_privacy.sql` and the code named in each row (state of the repository on 2026-10-03).

Keep this file in step with the code. The test `tests/integration/account-deletion.test.ts` finds every table with a `household_id` column from the database itself and fails if a new one has no row in its fixtures, so a new household table can't ship without being considered here and in deletion.

**Legal need** uses plain categories: *Service* (needed to provide what the person asked for), *Legit* (legitimate interests, kept to a minimum), *Consent* (only with the household's recorded permission), *Law* (a legal or accounting obligation). Legal review of these labels is still needed before publishing (see the audit's open items).

**Who can see** is what the database enforces (row-level security, role `plenty_app`) plus what the app shows. "System only" means no policy exists for the app role: only trusted server code (system connection) can read it.

## 1. Account and sign-in

| Table | Data | Purpose | Need | Who can see | Third parties | Retention | Deletion path |
|---|---|---|---|---|---|---|---|
| `users` | email, password hash (Argon2), email-verified time, demo flag | Sign in, security, email | Service | The person; housemates' rows are readable by RLS but only owners are shown email addresses in the app | Hosting/DB | Until account deletion | `deleteAccount` removes the row (cascades to the rows below) |
| `profiles` | display name, active household, analytics choice (off until the person turns it on) | Show a name, remember the household, honour the analytics choice | Service | Person and housemates (name) | Hosting/DB | Until account deletion | Cascade from `users` |
| `sessions` | SHA-256 of the session token, expiry, last seen, browser description | Keep someone signed in | Service | System only | Hosting/DB | 30 days sliding; expired rows deleted by the scheduled job (`pruneExpiredAuthRecords`) | Cascade; "sign out everywhere" deletes them |
| `password_reset_tokens` | SHA-256 of the token, expiry, used time | Password reset | Service | System only | Hosting/DB; the email provider carries the link | Expires in 60 minutes; spent/expired rows deleted by the scheduled job | Cascade |
| `rate_limits` | counter key (e.g. `signin:<email>`, `signin-ip:<ip>`, `receipt-upload:<household id>`), window start, count | Slow down guessing and abuse | Legit | System only | Hosting/DB | Deleted after one day (`pruneRateLimits`) | Keys naming the user, their email or a deleted household are deleted with the account/household |
| `email_outbox` | recipient, subject, body of unsent/dev emails | Development inbox only. In production mail is sent, not stored, unless `EMAIL_OUTBOX` is set for end-to-end tests | Service | System only | None | Development only | Rows addressed to a deleted person's email are deleted with the account |

## 2. Households and people

| Table | Data | Purpose | Need | Who can see | Third parties | Retention | Deletion path |
|---|---|---|---|---|---|---|---|
| `households` | name, adults/children counts, currency, time zone, demo flag | Run the household | Service | Members | Hosting/DB | Until deleted | Owner deletes household; or sole account holder deletes account |
| `household_members` | who is in a household: role, display name and colour; no account for managed profiles (children, others) | Roles, ownership of items, requests | Service | Members (names). Emails only to owners | Hosting/DB | Until removed/left/deleted | `removeMember`, `leaveHousehold`, account deletion (`detachMember`), household deletion |
| `member_food_rules` | one person's diets, allergies, dislikes | Safe meal suggestions | Service (health-adjacent: used only to filter meals) | That person; owners for profiles without accounts or children. Suggestions use the combined rules without attribution | Hosting/DB. Included in recipe requests to the AI provider only with consent | Until the person leaves or the household is deleted | `detachMember`; cascade |
| `household_invitations` | invite code, optional invitee email, role, who sent it, expiry | Invite people | Service | Owners only | Hosting/DB | Until used, revoked or the household/sender is deleted | Sender's invitations and ones addressed to a deleted person's email are deleted with the account; revoked on member removal |
| `preferences` | diets, allergies, dislikes, cuisines, budget, shops, shop day, **AI consent (flag, time, who)**, **receipt photo retention** | Personalise suggestions; record choices | Service; AI consent = Consent | Members read; adults write. AI consent and retention only change through dedicated, role-checked functions (`src/server/services/privacy.ts`) | Hosting/DB | Until household deletion. Withdrawing AI consent clears time and person | Cascade |
| `notification_settings` | per-person notification choices | Honour choices | Service | That person | Hosting/DB | Until account/household deletion | Cascade; `detachMember` |
| `notifications` | in-app notifications (title, body, link), read state | Nudges | Service | That person | Email provider if the person turned email digests on (Plus and above) | Until deleted | Cascade; `detachMember` |

## 3. Kitchen, lists, meals

| Table | Data | Purpose | Need | Who can see | Third parties | Retention | Deletion path |
|---|---|---|---|---|---|---|---|
| `inventory_items` | item name, amounts, location, expiry, price, notes, owner and visibility (household/private) | Kitchen | Service | Household items: all members. Private: only the owner (not owners/other members). Child accounts can only change their own | Hosting/DB. Names go to the AI provider in recipe requests only with consent | Until deleted | Item removal; private items hard-deleted when the owner leaves (`detachMember`); household deletion |
| `inventory_events` | what happened to an item (added, used, finished, wasted…) | History and learning | Service | Same as the item | Hosting/DB | Until the item or household is deleted | Cascade |
| `consumption_events` | finished/wasted/expired observations with scope (`household`, `member:<id>`, `private:<id>`) | Learn usage rates | Service | Scope rules: private only to owner | Hosting/DB | Until household deletion; a leaving person's private and personal history is deleted, shared history becomes the household's | `detachMember`; cascade |
| `consumption_stats` | learned rates per product and scope | Predictions | Service | Scope rules | Hosting/DB | As above | As above |
| `predictions` | run-out estimates with reasons | "Running low" | Service | Scope rules | Hosting/DB | Recomputed; as above | As above |
| `products` | household custom products (global catalog rows have no household) | Names for your own products | Service | Members | Hosting/DB | Until deleted | Cascade |
| `product_aliases` | receipt wording to product mappings | Recognise receipt wording | Service | Adults (not children) | Hosting/DB | Until household deletion | Cascade |
| `product_barcodes` | barcode, name, brand, size for household-added or cached products | Barcode scanning (Plus): a household's own barcode → product mapping, plus a shared cache of public answers (30 days; "not found" 3 days) | Service | Global (cache) rows: members read. Household rows: members (a child account can look up and add, but its barcodes are not saved to the household mapping) | The public product database receives only the barcode number, only when `BARCODE_LOOKUP=openfoodfacts` | Until household deletion | Cascade |
| `meals`, `meal_ingredients` | household recipes (user-added or AI-generated; library rows have no household) | Meals | Service | Members | Hosting/DB. AI-generated ones came from the provider only with consent | Until deleted | Cascade |
| `content_reports` | a report about an AI-written recipe: reason, optional note (up to 1,000 characters), the recipe's text as reported, who sent it | Letting people flag unsafe or inappropriate AI content, and reviewing it | Service | Only the person who sent it (the operator reads it directly) | Hosting/DB | Until the household is deleted; the sender's account link is cleared if their account goes first | Cascade |
| `meal_preferences` | likes/dislikes and counts | Better suggestions | Service | Members | Hosting/DB | Until household deletion | Cascade |
| `meal_plans`, `meal_plan_items` | plan dates, slots, chosen meals | Planning | Service | Members | Hosting/DB | Until deleted | Cascade |
| `shopping_lists`, `shopping_list_items`, `shopping_list_item_sources` | list, items with owner/requester/visibility, notes (300 characters max), reasons | Shopping | Service | Members; private lines only to their owner. Children can add their own requests | Hosting/DB | Until deleted | Private lines hard-deleted when the owner leaves; cascade |
| `recurring_items` | recurring purchases, owner, visibility | Recurring list lines | Service | As items | Hosting/DB | Until deleted | `detachMember` (a leaving person's private ones go; shared ones become the household's); cascade |

## 4. Receipts

| Table / store | Data | Purpose | Need | Who can see | Third parties | Retention | Deletion path |
|---|---|---|---|---|---|---|---|
| `receipts` | status, store name, date, subtotal/total, **redacted** text (card, loyalty, phone, email, address and name details removed: `src/lib/receipts/redact.ts`), provider (`local`/`anthropic`), quality warnings, photo path and removal times, photo hash and content fingerprint | Fill the kitchen, spot duplicates | Service | Adults (owners and members). Not child accounts | Hosting/DB | Row until household deletion. Photo: per household choice | Discard; household/account deletion |
| `receipt_items` | each line's redacted text, name, amount, price, match, accepted/ignored | Review and learning | Service | Adults | Hosting/DB | Until household deletion | Cascade |
| Receipt photo files (`STORAGE_DIR`, key `<household id>/<receipt id>.jpg`) | Resized JPEG with camera/location metadata stripped | Read and check the receipt | Service | Members of the owning household, through an authenticated route only. Not child accounts | **AI provider (Anthropic) only if the household consented and the plan includes it**; otherwise on-device OCR | **After review: deleted immediately (default); or 30 days after review; or kept.** Never-checked photos: 14 days. Discarded receipts: immediately. `deleteExpiredReceiptImages` runs in the scheduled job and right after a choice changes | Discard; retention sweep; household/account deletion removes the whole household folder |

## 5. Plans, billing, analytics

| Table | Data | Purpose | Need | Who can see | Third parties | Retention | Deletion path |
|---|---|---|---|---|---|---|---|
| `subscriptions` | plan, period, status, provider, provider customer and subscription ids, renewal/period dates | Entitlements | Service | Adults read; written by system code (webhooks, billing service) | Stripe (web), Apple, Google: the provider holds payment details; Plenty never does | Until household deletion | Cascade. **A web (Stripe) subscription is cancelled first by `prepareHouseholdDeletion` and the deletion stops if that fails. An App Store / Google Play subscription can only be cancelled in the store: the person is told, and Plenty never claims otherwise** |
| `billing_events` | provider event id, type, short summary, error text | Idempotent webhooks; accounting | Service / Law | System only | The provider that sent it | **Kept after deletion with the household link removed** (`household_id` set null) so a replayed notification isn't applied twice and for accounting | Not deleted with the household; link removed |
| `usage_counters` | per-month counters (e.g. receipt scans) | Plan limits | Service | Members read | Hosting/DB | Until household deletion | Cascade |
| `analytics_events` | event name, time, **HMAC of the household id** (`ANALYTICS_SECRET`), plan, platform, small fixed properties. No names, items, receipt text or IPs | Product improvement | Consent (opt-in, off until the person turns it on) | System only | None (first party) | **395 days** (`pruneAnalyticsEvents`), or until household deletion | `deleteAnalyticsFor(householdId)` on household and account deletion. Off in production without `ANALYTICS_SECRET` |

## 6. What leaves Plenty's server

| Recipient | What | When | Control |
|---|---|---|---|
| Hosting and database provider | Everything above | Always | Operator's choice of provider; not specified in code |
| Email provider (`SMTP_URL`) | Recipient address and message | Password resets, invitations, optional notification emails | Only if configured |
| Stripe | Customer email and plan for checkout; card details go to Stripe's hosted page | Web purchase | Only if `STRIPE_SECRET_KEY` is set |
| Apple / Google | Plenty receives status and ids; sends verification requests | Store purchases | Only if configured |
| **AI provider (Anthropic)** | Receipt photo + date, currency, chosen shops; **or** kitchen item names/amounts/use-by dates, diets, allergies, dislikes, cuisines, rejected meal names; **or** a grocery photo (feature later). Never names, emails, other household data | Only when that feature is used, the household has consented (recorded with who and when), the plan includes it and a key is configured. Re-checked on every call | `src/server/ai/consent.ts`; household can withdraw at any time |
| Public product database (Open Food Facts, `world.openfoodfacts.org`) | Barcode number only (fixed host, 3 s timeout, no redirects, a Plenty user-agent; no household, account or IP detail is sent by Plenty) | When a barcode isn't in the household's mapping or the shared cache and `BARCODE_LOOKUP=openfoodfacts` (the default outside tests; set `off` to disable) | Shipped; its own privacy terms apply to what it receives |
| **AI provider (Anthropic), photo recognition** | A grocery photo, downscaled with metadata stripped, plus a fixed instruction. Nothing about the household. The photo is processed in memory and **never stored** | Only with the household's explicit AI consent, on Plus or above, with an AI service configured | Shipped |

## 7. Deletion summary (verified by `tests/integration/account-deletion.test.ts`)

* **Delete account** (password and the word DELETE required): a household where the person is the only account holder is deleted entirely (every table above with a `household_id`, plus photos, analytics, rate-limit keys); in a household others use, the person leaves (private items, personal food rules, personal patterns, notifications, invitations they sent are deleted; shared items stay). If they are the only owner of a household others use, deletion is refused with a clear message until someone else is made an owner. Nothing is handed over silently.
* **Delete household** (owner; name must be typed): everything in it for everyone; other members keep their accounts.
* **Not deleted:** `billing_events` (household link removed); the provider's own records (Stripe, Apple, Google); the hosting provider's backups (age out on their schedule).
* **Export** (`/api/export`): everything the household holds except photos. It includes the person's own food rules (and those of people they look after), recurring items, barcodes, the subscription row and usage counters; analytics are pseudonymous, system-only and not exported.
