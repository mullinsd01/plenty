# Security notes

What protects Plenty's data today, and what doesn't yet. Written from the code on 2026-10-03; honest by design. "Relies on hosting" means Plenty doesn't do it itself and the operator must.

## What is in place

**Households are separated in the database, not just in code.** Every household table has row-level security. The app connects as the restricted role `plenty_app` with the signed-in user's id in the transaction (`withUser`), so a query that forgets its `WHERE household_id` still can't see another household (tested in `tests/integration/permissions.test.ts`). Roles (owner, member, child) and private items are enforced by policies too (`drizzle/0004_rls_members_privacy.sql`): private items and the learning from them are visible only to their owner; child accounts can't read receipts or prices or change settings; invite codes are owner-only; each person's food rules are readable by that person (and owners for profiles without accounts). A small set of trusted operations use the table-owner connection (`systemDb`: sign-in, invitations, scheduled jobs, billing webhooks, account deletion, the AI-permission check).

**Passwords and sessions.** Passwords are hashed with Argon2id (`@node-rs/argon2`, 19 MiB, 2 passes). Sessions are random tokens held in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production); only the SHA-256 of the token is stored. Sessions last 30 days sliding, can be revoked ("sign out everywhere", password change signs other devices out), and expired ones are deleted by the scheduled job. Password-reset links are single-use, hashed, and expire in 60 minutes. Reset requests give the same answer whether or not the account exists, and failed sign-ins take as long as real ones.

**Rate limits** (Postgres-backed, so they hold across instances): sign-in 8 per 15 minutes per email and 40 per 15 minutes per IP; sign-up 10 per hour per IP; password reset 3 per hour per email and 10 per hour per IP; password and email change 6 per 15 minutes; account deletion 5 per 15 minutes; receipt upload 30 per hour per household; receipt retry 20 per hour; AI recipe ideas 6 per hour; analytics 120 per minute per person. The client IP is read from `X-Forwarded-For` from the right (`TRUSTED_PROXY_HOPS`), so a client can't pick its own address.

**Receipts and photos.** Uploads are accepted only if they decode as an image (JPEG, PNG, WebP; HEIC refused), within 15 MB and 40 megapixels; the stored copy is resized, rotated and **stripped of all metadata (EXIF, GPS, ICC, XMP)** (`src/server/receipts/image.ts`). Files live outside `public/`, with mode 0600, and are served only through an authenticated route that checks household membership and role, with `X-Content-Type-Options: nosniff`. Storage keys are validated against a strict pattern and resolved inside the storage root (no path traversal). Photos are deleted by retention policy (default: once the receipt is checked). Receipt text is redacted (cards, loyalty, phones, emails, addresses, names) before it is stored (`src/lib/receipts/redact.ts`), with a linear-time matcher tested against pathological input.

**AI.** The AI provider's key is read only on the server (`import "server-only"`; there are no `NEXT_PUBLIC_*` variables). External AI is reachable only through one guard that checks configuration, plan and the household's recorded permission on every call and fails closed; a test fails if any other module imports the provider. AI output is validated (zod schemas), then goes through deterministic code and, for receipts, a person's confirmation, before it changes anything. The model never decides allergy or diet safety (`isMealAllowed`).

**Transport and headers.** `next.config.ts` sets `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()` and a CSP with `frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. Server actions use Next.js' built-in origin checks. Redirect targets are restricted to same-site paths (`safeRedirectPath`). Exports are sent with `Cache-Control: no-store`.

**Webhooks and jobs.** Stripe, Apple and Google notifications are verified (signature, certificate chain or OIDC token) and applied idempotently; the cron endpoint requires `Authorization: Bearer $CRON_SECRET` with a constant-time compare.

**Secrets.** Read from the environment, validated once in `src/server/env.ts` (billing secret ≥ 32 characters, analytics secret ≥ 16). `.env*` is git-ignored. Analytics keys are HMACs of the household id, so analytics rows don't contain it. (Store purchase tokens are the billing code's: see `docs/billing.md`.)

**Deletion.** Account and household deletion are real deletes, covered by a test that finds every `household_id` table from the database and fails when a new one isn't covered. Receipt photos, analytics and rate-limit counters are removed with them.

## Known gaps and limits

1. **Encryption in transit and at rest relies on hosting.** Plenty sets `Secure` cookies in production but doesn't terminate TLS; serve it only over HTTPS. Neither the database nor the stored receipt photos are encrypted by the app: use an encrypted volume or managed database. `STORAGE_DIR` is the local disk; for more than one server, swap `src/server/storage/files.ts` for object storage.
2. **No `script-src` Content-Security-Policy.** The CSP above blocks framing, base-tag and form-action abuse, but not inline or injected scripts. React escapes output and the code has no `dangerouslySetInnerHTML` on user data (check before adding any), but a CSP with nonces would be a real second layer.
3. **A deleted receipt photo may remain in a browser's cache for up to an hour** (`Cache-Control: private, max-age=3600` on the image route).
4. **Backups are the operator's.** Deleted data leaves the live database immediately but ages out of any backups on the provider's schedule; Plenty can't purge them.
5. **Rate-limit keys contain emails and IP addresses** for up to a day (`rate_limits`). They are deleted with the account when they name the person, and pruned daily otherwise.
6. **Without `SMTP_URL`, production drops emails and logs the recipient and subject** to the server log (`src/server/email/mailer.ts`). A log aggregator could therefore hold email addresses; configure SMTP, and treat logs as personal data.
7. **Unhandled errors are logged with server detail**: users only see friendly messages, but logs can contain database error text. Restrict log access.
8. **No two-factor authentication, no account lock-out beyond the rate limits, no sign-in notification emails, no breached-password check.** Passwords need 8 characters.
9. **No malware scanning of uploads.** Decoding with `sharp` validates the format and re-encoding removes anything that isn't pixels, which covers the usual image attacks; there's no separate scanner.
10. **No audit log** of who changed what in a household, and owners can't see who exported data.
11. **Analytics subject keys depend on `ANALYTICS_SECRET`.** Rotating it orphans old rows (they stay pseudonymous but can't be deleted by household until they age out after 395 days). Without a secret, production records nothing.
12. **The demo account is shared** and public by design (`DEMO_MODE`); never put real data in it, and don't enable `DEMO_MODE` on a production instance that holds real households unless reviewers need it.
13. **`PLAN_OVERRIDE` grants a plan to every household without a subscription.** It is for self-hosting and development; leave it unset in production (it would also enable the AI features, still behind the household's consent).
14. **Third-party handling is outside Plenty's control:** what the AI provider, Stripe, Apple, Google, the email and hosting providers do with data is governed by their terms. The Privacy Policy says so and links the AI provider's terms; Plenty makes no claim about the AI provider's retention.
15. **Child accounts have no age check** (see the audit, decision 3).
16. **The privacy and terms text is not legal advice**; it needs legal review before launch.
17. **A private item Plenty doesn't recognise gets a product that only its owner can see** (`products.owner_member_id`, with a policy). It becomes the household's if the item stops being private. Two people's private products with one name don't clash. The owner's own device and the system jobs (which run as the database owner for notifications) can still read it; nobody else in the household can.
18. **A receipt is shared with the household's adults, but a line filed as private keeps nothing readable**: once confirmed it is stored as "Private item" with no product, price or link to the item it became, and nothing is remembered from it. Before the person has confirmed the receipt, every line is visible to the adults who can open it.
19. **The app role can't read `users.password_hash` or the billing provider's identifiers** (column-level grants in migration 0005). Sign-in, billing and deletion run as the database owner.
20. **`/dev/outbox` shows every unsent email (reset links included) to anyone when `NODE_ENV` isn't `production` and `SMTP_URL` is unset.** Fine on a laptop; never run a reachable server that way. In production `CRON_SECRET` must be at least 24 characters (the app refuses to start its jobs endpoint otherwise): use a long random value, not the example `change-me`.

## When you change something

* New table with a `household_id`: add RLS, an export entry, a row in `populate()` in `tests/integration/account-deletion.test.ts`, and a row in `docs/compliance/data-map.md`.
* New outside service or SDK: it changes the Privacy Policy (`src/lib/privacy-content.ts`), the Apple privacy label and the Play Data safety form. Anything that sends household data to it must go through a consent guard like `src/server/ai/consent.ts`.
* New analytics event: add it to `src/lib/analytics-events.ts` with fixed property values; to let browsers send it, add it to `CLIENT_ANALYTICS_EVENTS` in `src/lib/analytics-validate.ts`.
* New place that stores receipt text: pass it through `redactReceiptText` / `redactReceiptLine` first.
