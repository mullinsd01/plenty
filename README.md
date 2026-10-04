# Plenty

**Your household, figured out.**

Plenty is a household grocery and meal-planning app that learns one household really well. It reads your receipts, keeps track of what's in your kitchen, learns how fast your household gets through things, predicts what's about to run out, plans meals around what you already have, and builds a shopping list containing only what's actually missing.

```
RECEIPT → INVENTORY → CONSUMPTION → LEARNING → PREDICTION → MEAL PLAN → SHOPPING LIST → NEXT RECEIPT
```

The rule behind every design decision: **you shouldn't have to maintain Plenty.** It infers whatever it can (pack sizes, where things are kept, expiry, when the old bottle of milk ran out) and only asks for a single tap when it isn't sure ("Did you finish the milk?").

---

## Quick start

Requirements: **Node 20.9+** and **PostgreSQL 14+**.

```bash
# 1. Postgres (skip if you already run one)
docker compose up -d

# 2. Configure
cp .env.example .env            # defaults work with the docker-compose database

# 3. Install, set up the database, load the demo household
npm install
npm run setup                   # migrations + row-level security + product catalog + recipe library
npm run db:seed                 # optional: a realistic demo household (9 weeks of simulated history)

# 4. Run
npm run dev                     # http://localhost:3000
```

Sign up to start your own household, or click **Explore the demo household** on the sign-in page (`demo@plenty.app` / `plenty-demo`).

> Using your own Postgres? The role in `DATABASE_URL` needs `CREATEROLE` (or superuser) the first time `npm run setup` runs, because the migrations create the restricted `plenty_app` role used for row-level security.

### Try it in the browser (GitHub Codespaces)

Nothing to install: on the repository's GitHub page choose **Code → Codespaces → Create codespace on this branch**. The first start takes a few minutes while it installs the packages, creates the database and loads the demo household. When it finishes, open the terminal, run `npm run dev`, and open the **Plenty** link under the **Ports** tab (port 3000). Sign in as `demo@plenty.app` / `plenty-demo`, or with one of the role accounts (`family@plenty.test`, `mate@plenty.test`, `kid@plenty.test`, `free@plenty.test`; password `plenty-tour`). The setup lives in `.devcontainer/`.

### Environment

| Variable | Required | What it does |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. |
| `APP_URL` | yes | Public base URL (used in password-reset and invite links). |
| `ANTHROPIC_API_KEY` | no | Enables Claude for reading receipt photos, writing new recipes and recognising groceries in photos (Plus; each also needs the household's OK in Settings → Privacy & data). Without it everything still works: receipts are read with on-device OCR (Tesseract) and meals come from Plenty's built-in library. |
| `AI_PROVIDER` | no | `auto` (default), `local` or `anthropic`. |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-opus-5-5`. |
| `SMTP_URL` / `EMAIL_FROM` | no | Real email delivery. Without SMTP, emails go to the dev outbox at `/dev/outbox` (disabled in production). |
| `BARCODE_LOOKUP` | no | `openfoodfacts` (default) or `off`. When a scanned barcode isn't one the household has already told Plenty about, Plenty can ask [Open Food Facts](https://world.openfoodfacts.org), a public product database, what it is. **That discloses the barcode number (and nothing else) to openfoodfacts.org.** Set `off` to never do that; Plenty then asks the person to name the product and remembers it. Barcode scanning is a Plus feature. |
| `STORAGE_DIR` | no | Where receipt photos are stored (private; served only to household members). |
| `CRON_SECRET` | no | Protects the scheduled notifications endpoint. In production it must be at least 24 characters. |
| `TRUSTED_PROXY_HOPS` | no | Reverse proxies in front of Plenty that append to `X-Forwarded-For` (default `1`). Used to find the real client IP for rate limiting. |
| `DEMO_MODE` | no | Shows the demo-household button on the sign-in page. |
| `PLAN_OVERRIDE` | no | `free`, `plus`, `family` or `pro`: gives every household on this server at least that plan. For self-hosting without billing, development and demos. If you sell plans, leave it unset: it would give everyone the plan for free. |
| `LEGAL_ENTITY_NAME` / `SUPPORT_EMAIL` / `PRIVACY_CONTACT_EMAIL` | no | Named on the public `/privacy`, `/terms` and `/support` pages. Plenty never invents these: an unset one is left out (and shown as a placeholder in development). Set them for production. |
| `ANALYTICS_SECRET` | no | 16+ random characters; keys the pseudonymous household id in first-party analytics. In production nothing is recorded until it's set. |
| `BILLING_ACCOUNT_SECRET` | no | 32+ random characters. Makes the token that tags App Store / Google Play purchases with their household unforgeable. Required for store purchases to find their household. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICES` | no | Web subscriptions through Stripe Checkout. `STRIPE_PRICES` is `plus.monthly=price_…,plus.annual=price_…,family.monthly=price_…,family.annual=price_…`. Without them the web option isn't shown. See [docs/billing.md](docs/billing.md). |
| `APPLE_BUNDLE_ID` / `APPLE_APP_ID` / `APPLE_ROOT_CERTS` / `APPLE_PRODUCTS` | no | App Store subscriptions (notifications and restore). `APPLE_ROOT_CERTS` lists Apple root certificate files (or base64 DER). `APPLE_PRODUCTS` overrides product ids (default `app.plenty.<plan>.<period>`). |
| `GOOGLE_PLAY_PACKAGE_NAME` / `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` / `GOOGLE_PUBSUB_SERVICE_ACCOUNT` / `GOOGLE_PUBSUB_AUDIENCE` / `GOOGLE_PRODUCTS` | no | Google Play subscriptions (notifications and restore). The audience defaults to `APP_URL/api/billing/webhooks/google`. |

### Scripts

| Command | |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js app |
| `npm run setup` | Migrate + load catalog + load recipes (idempotent) |
| `npm run db:seed` | Recreate the demo household |
| `npm run db:reset` | Development only: wipe the database, set up and seed |
| `npm test` | Unit + integration tests (integration tests use the `plenty_test` database) |
| `npm run test:e2e` | Playwright end-to-end test of the whole loop (uses `plenty_e2e`, builds the app) |
| `npm run lint` / `typecheck` | Static checks |
| `npm run cron:notifications` | Run the scheduled jobs once (resume interrupted receipts, then notifications) |
| `npm run receipts:fixtures` | Regenerate the sample receipt images |

In production, call the scheduled job hourly. It picks up any receipt whose reading was interrupted (for example by a restart) and generates notifications:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/cron/notifications"
```

---

## What's in the box

- **Auth** — sign up, sign in, sign out, password reset by email, 30-day sliding sessions, protected routes, rate-limited endpoints, account deletion.
- **Onboarding** — one question per screen, everything after the household basics is skippable. Plenty gets more accurate from use rather than questionnaires.
- **Home** — what you need to know right now: check-ins, what's running low (with an honest *Plenty estimate* vs *From your history* label), what to use soon, tonight's dinner, the next shop, the latest receipt, and things Plenty has noticed.
- **Kitchen** — every item with an estimated level, run-out prediction and use-by. Change levels with a tap (Full / Mostly / Half / Low / Empty, or − / + for counted things), mark things finished, thrown out or gone off (with undo), move, edit, search, filter and sort. Add by typing naturally ("2 milk, bread, 500g mince").
- **Receipts** — photo or upload (compressed on the device), read in the background by Claude or on-device OCR, normalised to canonical products ("W/M FULL CREAM 2L" → *Full cream milk*), then a quick review screen before anything changes. Duplicate photos and duplicate receipts are detected. When you buy something again, Plenty asks whether the old one is finished — which is how it learns without you doing anything extra. Confirmed corrections are remembered for next time.
- **Learning & prediction** — every finished/wasted item becomes a consumption observation. Plenty learns rates per household (median + recency-weighted, outlier-robust, scaled by household size, seasonal once there's a year of data), blends them with catalog priors until there's enough history, and predicts run-out with ranges and confidence — never false precision.
- **Shopping list** — combines items predicted to run out before the shop after next, meal-plan shortfalls (net of what you already have, rounded to real pack sizes), household staples and your own items; grouped by aisle, with reasons ("For Tuesday's chicken curry · running low") and waste advice. Tick off, edit, move, reorder, remove (auto items stay away until the next shop), finish the shop.
- **Meals** — plan tonight, tomorrow, 3 days or the week. The planner prioritises food that needs using, respects allergies and diets as hard rules, avoids dislikes, leans on favourites, keeps variety and weeknight time limits, and simulates the kitchen across the week so two meals never claim the same mince. Swap, dislike, move, change servings, mark cooked (ingredients are deducted automatically), edit recipes (copy-on-write), and — with an API key — get fresh recipes written around what's in your kitchen.
- **What can I make?** — ranked by ingredients on hand, food that needs using, preferences, time and difficulty.
- **What Plenty knows** — every learned rate, staple, shopping rhythm, spending trend, waste pattern and meal preference, with controls to correct or reset any of it.
- **People and ownership** — everyone in the household, with or without an account (a child, or a housemate who won't use the app). Food and shopping-list lines can belong to the household or to one person ("Pepsi Max — Dad" and "— Mum" are different things with their own pace), and on Plenty Family a person can keep their own things private. Roles: *owner* (runs the household, its people and plan), *member* (everyday use) and *child* (sees what's shared, can ask for things, changes only their own). Everyone's food rules (diets, allergies, dislikes) are personal and are combined for meal ideas without saying whose they are.
- **Requests** — anyone can ask for something ("Mum wants Pepsi Max"); it goes on the shared list under Requests with their name and the adults are told. Notes, regular purchases (set something to repeat) and Plenty's own suggestions with *Keep it / Not needed* sit on the same list.
- **Plans** — Free, Plus ($4.99 / $49.99) and Family ($8.99 / $89.99); Pro is defined but not offered. One definition of what each plan includes (`src/lib/billing/plans.ts`) drives the limits, the paywall and the store listing. Limits only ever stop something being *added*; nothing is hidden or deleted on a downgrade. See [docs/billing.md](docs/billing.md).
- **Privacy and consent** — receipt details (card, loyalty and phone numbers, addresses) are removed before anything is stored, photos are deleted after review by default, AI processing happens only with the household's explicit consent on a plan that includes it, analytics are first-party with an opt-out, and account and household deletion removes everything (guarded by a test that checks every table). Public `/privacy`, `/terms`, `/support` and `/delete-account` pages. See [docs/compliance](docs/compliance).
- **Sharing** — invite links; everyone in the household shares the kitchen, list and plans.
- **Notifications** — only useful ones (running low, check-ins, use-soon, shopping day, meal plan ready, weekly insight), with per-member preferences, a daily cap and quiet hours.
- **Search** — forgiving search across kitchen, list and meals (⌘K).
- **Settings** — account, household & sharing (people, roles, personal food rules), food preferences, shopping & budget, notifications, plan & billing, privacy & data (AI consent, photo retention, analytics), data export, delete household / account.

---

## Architecture

```
src/
  app/                 Next.js App Router pages, layouts, route handlers (api/)
  components/          Design system (ui/), layout, brand, shared food components
  features/<area>/     Client components + server actions per product area
  lib/                 Pure, deterministic domain logic (no DB, no React) — unit tested
    catalog/           ~400 canonical grocery products with shelf lives and consumption priors
    normalize/         Receipt-text cleaning and product matching
    receipts/          Receipt text parser, duplicate fingerprints, quality checks
    consumption/       Learning household consumption statistics
    prediction/        Run-out prediction (FIFO multi-batch), expiry, honest labels
    meals/             Ingredient ↔ inventory matching, plan requirements, planner, diet rules
    shopping/          Shopping needs + list reconciliation
    insights/          Shopping rhythm, waste patterns, spend
    recipes/           Built-in recipe library
  server/
    db/                Drizzle schema + client (withUser runs every query under RLS)
    auth/              Sessions, passwords (argon2id), rate limiting, guards
    ai/                Provider abstraction: Claude (structured outputs) + local provider
    receipts/          Image preparation (sharp) and on-device OCR (tesseract.js)
    services/          Business services wiring the engines to the database
    storage/, email/   Private file storage, email (SMTP or dev outbox)
drizzle/               SQL migrations, including row-level security policies
scripts/               setup, seed (simulation), reset, cron, receipt fixtures
tests/                 unit (engines) + integration (DB, permissions, learning loop)
e2e/                   Playwright end-to-end test of the full loop
```

### The database is the source of truth; AI only interprets

Quantities, consumption, predictions, list reconciliation, ingredient matching, permissions and membership are all deterministic code over PostgreSQL. AI is used where it helps — reading receipt photos, tidying product names, writing recipes — and its output is schema-validated, resolved against the product catalog, re-checked against allergies/diets deterministically, and confirmed by a person before it changes anything important. Swap providers by implementing `AIProvider` in `src/server/ai`.

### Security

- Every household-scoped query runs inside `withUser()`, which switches the transaction to the restricted `plenty_app` role with the user's id set. **PostgreSQL row-level security** then guarantees a user can only touch rows from households they belong to — even if application code forgot a filter. Auth tables are not readable by the app role at all. (Covered by `tests/integration/permissions.test.ts`.)
- Passwords use argon2id; session and reset tokens are random 256-bit values stored only as SHA-256 hashes; cookies are `httpOnly`, `SameSite=Lax`, `Secure` in production.
- Sign-in, sign-up, password reset, uploads and AI calls are rate limited (Postgres-backed, so it works across instances).
- All input is validated with zod on the server. Uploads are size-limited, decoded and re-encoded (stripping metadata), and stored outside `public/`.
- Inside a household, row-level security also enforces *who may see what*: a private item (and what's learned from it) is invisible to housemates at the database level, a child account can only change what it owns or asked for, only owners change people, invitations and the plan, and billing, usage and analytics tables can't be written by the app role at all. (Covered by `tests/integration/members-privacy.test.ts` and `billing.test.ts`.)
- Subscriptions belong to the household and are only ever changed by verified provider events (Stripe webhook signatures, Apple signed notifications, Google Pub/Sub tokens), applied idempotently; a purchase is never moved between households silently.
- Errors shown to users are always friendly; details are only logged server-side. API keys never reach the browser.

---

## Testing

```bash
npm test            # unit tests for every engine + DB integration tests
npm run test:e2e    # full loop in a real browser against a production build
```

The end-to-end test signs up, creates a household, scans a receipt (on-device OCR), confirms it, marks milk finished, checks that learning recorded it, plans the week, checks that missing ingredients land on the list, ticks items off in the shop, scans the next receipt, and checks the dashboard — plus password reset and route protection.
