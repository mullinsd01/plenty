# Deploying Plenty to production

A step-by-step guide to putting Plenty on a real server, written so that someone who has never run a web service can follow it in an afternoon. The iPhone app loads this hosted site, so it has to be reachable, over https, all the time, including while Apple reviews the app.

What you will have at the end:

```
 iPhone app ─┐
 web browser ─┴─ https://plenty.example.com ──► Plenty (one container)
                                                  │         │         │
                                                  ▼         ▼         ▼
                                              Postgres   photo     email
                                              (data)     storage   (SMTP)
                       an hourly call to /api/cron/notifications keeps the housekeeping running
```

Everything in this guide that says **tested** was run while writing it (on Linux, with Postgres 16 and Docker). Everything marked **not tested** could not be, and the last section lists them all in one place. Read that section before you rely on this guide for something you can't undo.

## Contents

1. [Before you start](#1-before-you-start)
2. [Choose where it runs](#2-choose-where-it-runs)
3. [Choose a Postgres host](#3-choose-a-postgres-host-important)
4. [Path A: Fly.io + Neon + Cloudflare R2 (recommended)](#4-path-a-flyio--neon--cloudflare-r2-recommended)
5. [Path B: one server with Docker Compose](#5-path-b-one-server-with-docker-compose)
6. [Every setting](#6-every-setting)
7. [Migrations](#7-migrations)
8. [Domain and https](#8-domain-and-https)
9. [The demo household for App Review](#9-the-demo-household-for-app-review)
10. [The hourly jobs](#10-the-hourly-jobs)
11. [Payment webhooks](#11-payment-webhooks)
12. [Backups](#12-backups)
13. [Logs and personal data](#13-logs-and-personal-data)
14. [Updating, and going back](#14-updating-and-going-back)
15. [When something is wrong](#15-when-something-is-wrong)
16. [Go-live checklist](#16-go-live-checklist)
17. [What was not tested](#17-what-was-not-tested)

---

## 1. Before you start

**Accounts and things to buy.** Prices change, so none are quoted here; all of these have free or low-cost starting tiers, but check each before relying on it for a production app.

| You need | What for | Examples |
|---|---|---|
| A domain name | The address people and the iPhone app use. | Any registrar. Buy it now: DNS changes can take hours to spread. |
| A place to run the app | Runs the container. | Fly.io (Path A) or a small server you rent (Path B). |
| A Postgres database | All households, lists, plans. | Neon (Path A), or Postgres in the same Compose file (Path B). |
| Somewhere to keep receipt photos | Photos while a receipt is being checked. | Cloudflare R2 or any S3-compatible bucket (Path A), or a disk on the server (Path B). |
| An email sender (SMTP) | Password-reset and invitation emails. **Required**: without it people who forget their password are locked out. | Any provider that gives you an SMTP address and lets you verify your domain (Postmark, Resend, Amazon SES, Mailgun…). |
| A GitHub account | To run the hourly job (or use any other scheduler). | github.com |
| Stripe (optional) | Web subscriptions. Skip it if you only sell through the App Store. | stripe.com |
| Apple Developer Program, App Store Connect | The app and in-app purchases. | developer.apple.com |

**On your own computer** you need Git, Docker, and (for the checks) Node 22 or newer. You do not need Docker to deploy on Fly.io (Fly builds the image for you), but you do need it to try the image locally.

**Two decisions to make now:**

* **Where do receipt photos live?** Object storage (S3-compatible, recommended) survives anything and lets you run more than one server later. A disk on one server is simpler, but only works with one server and the disk must be a volume that survives redeploys.
* **Who is "the operator"?** `LEGAL_ENTITY_NAME`, `SUPPORT_EMAIL` and `PRIVACY_CONTACT_EMAIL` are printed on the public Privacy Policy, Terms and Support pages. Apple requires working contact details. Plenty never invents them: if they are unset the pages say nothing, and `npm run check:prod` fails.

## 2. Choose where it runs

| | **Path A: Fly.io + Neon + Cloudflare R2** | **Path B: one rented server + Docker Compose** |
|---|---|---|
| Who looks after the machine | The providers. | You (updates, firewall, backups). |
| https certificates | Automatic. | Automatic (the Compose file includes Caddy). |
| Database | Managed Postgres with point-in-time restore. | Postgres in a container on the same server, backed up by you. |
| Photos | Object storage. | Disk on the server (or object storage). |
| Number of accounts | 3 (plus email and domain). | 1 (plus email and domain). |
| Good for | Going live this week without becoming a system administrator. | The lowest cost, and people comfortable with SSH. |

**Recommendation: Path A.** A mistake on Path B (a full disk, an unpatched server, a missed backup) takes the app down or loses data with nobody to call. Path A costs more per month and removes those risks.

Either path uses the same Docker image, built from the `Dockerfile` in this repository.

### What is in the image

* `server.js`: the Next.js web server (standalone output; Node 22, Debian slim; runs as an unprivileged user).
* `tools/*.cjs`: the operational commands, each a single file that needs only Node:

| Command (inside the image) | What it does |
|---|---|
| `docker run … <image>` | Starts the web server (the default). |
| `… <image> setup` (= `node tools/setup.cjs`) | Applies database migrations, loads the product catalog and the recipe library. Safe to repeat. **Run it before every new version starts.** |
| `… <image> migrate` | Migrations only. Use `setup`: the app needs the catalog and recipes too. |
| `… <image> seed` | Recreates the demo household for App Review ([section 9](#9-the-demo-household-for-app-review)). |
| `… <image> cron` | Runs the hourly jobs once, from inside the container (an alternative to calling the web endpoint). |
| `… <image> check` (= `node tools/check-prod.cjs`) | The go-live check. Same as `npm run check:prod`. |
| `… <image> smoke` | Proves the image can hash passwords, process photos and read a receipt. |

* The English text-recognition (OCR) engine and model, and the native modules for the platform the image was built on. **Tested:** the build reads a sample receipt as its last step and fails if it can't.
* Receipt reading works without any AI service. With `ANTHROPIC_API_KEY` set, households that consent can use Claude instead.

**Building for arm64 as well as amd64.** `docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/plenty:<tag> --push .` works from any machine with buildx. Each platform runs `npm ci` itself, so it fetches that platform's native modules, and each platform's build runs the receipt-reading check. Most hosts (Fly.io, Render, a typical server) are amd64: build amd64 unless you know you need arm64 (for example an Ampere or Graviton server). See [section 17](#17-what-was-not-tested) for how far the arm64 build was tested.

## 3. Choose a Postgres host (important)

Plenty keeps households apart **inside the database**, not just in code. The app connects as one database user (the table owner) and, for each signed-in request, switches into a restricted role called `plenty_app` for which row-level security applies. The very first migration therefore does things many managed databases don't allow by default.

**What the database user in `DATABASE_URL` must be able to do** (the first run only, except the last two):

| Needed | Where | Why |
|---|---|---|
| Own the database (create tables, schemas, functions) | every migration | normal for the user that created the database |
| `CREATE EXTENSION pg_trgm` | `drizzle/0000_extensions.sql` | forgiving search. Allowed for a database owner on Postgres 13+ and on most hosts |
| `CREATE ROLE plenty_app NOLOGIN NOBYPASSRLS` | `drizzle/0002_rls.sql` | the restricted role. **Needs the `CREATEROLE` attribute** |
| `GRANT plenty_app TO CURRENT_USER` | `drizzle/0002_rls.sql` | so the app can switch into the role. Needs the right to grant it (automatic for the user that created it) |
| `SET ROLE plenty_app` on every request | `src/server/db/client.ts` | needs membership in the role (the grant above) |
| Be the same user in the migrations and the app | | tables are not `FORCE`d: the owner bypasses row-level security by design, and the app relies on that for sign-in, webhooks and the hourly jobs |

**Check before you commit to a host** (30 seconds, changes nothing that stays behind):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/probe-database.sql
# no psql installed?
docker run --rm -i postgres:16 psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < deploy/probe-database.sql
```

It ends with `OK: this database user can do everything the first migration needs`, or stops at the first thing the host refuses.

**What was tested** (Postgres 16.13, a fresh cluster, a database user that is not a superuser):

| Database user | Result |
|---|---|
| Owns the database and has `CREATEROLE` (nothing else) | Works from an empty database. |
| Owns the database, **no** `CREATEROLE` | Fails: `permission denied to create role`. |
| No `CREATEROLE`, but an administrator first runs `CREATE ROLE plenty_app NOLOGIN NOBYPASSRLS; GRANT plenty_app TO plenty_owner;` | Fails: `permission denied to grant role "plenty_app"`. |
| No `CREATEROLE`, but an administrator first runs `CREATE ROLE plenty_app NOLOGIN NOBYPASSRLS; GRANT plenty_app TO plenty_owner WITH ADMIN OPTION;` | **Works.** Use this when a host won't give your user `CREATEROLE` but someone with admin rights can run two statements once. |

**Which hosts.** I could not test any host. From the providers' own documentation as I could read it:

* **Neon**: the role created with a project (and any role made in its console, CLI or API) is a member of `neon_superuser`, which has `CREATEROLE` and `CREATEDB`. It should pass the probe. Use the **direct** connection string, not the pooled one (the host name has `-pooler` in it), and check the project's settings for suspending the database when idle (an idle suspend adds a delay to the first request after a quiet spell; for production, switch it off if your plan allows).
* **Every other host: I could not check.** Many managed databases give their admin user `CREATEROLE` and many don't; the probe is the test, not a list. (If a host offers a "Data API" or similar automatic web access to your tables, turn it off for this database: Plenty has its own server, and every table already has row-level security with no public policy.)
* A host that refuses `CREATE ROLE` and has no one who can run the two statements above is not usable. Choose another.
* **Connection poolers** (PgBouncer and similar): connect directly. Plenty's per-request role switch is transaction-scoped, which is compatible with transaction pooling in principle, but it was not tested through one.
* **Postgres version:** 16 is what Plenty is developed and tested on. Choose 16 or newer.
* **TLS to the database:** hosted databases want `?sslmode=require` on the end of `DATABASE_URL`. `check:prod` warns when it is missing.

## 4. Path A: Fly.io + Neon + Cloudflare R2 (recommended)

Budget about three hours the first time, most of it waiting for DNS and the first build. **Not tested:** the Fly, Neon and Cloudflare steps themselves (I had no accounts and those sites were not reachable from where this was written). The files they use were tested: the image, the setup command, the S3 code and the checks.

### 4.1 Database (Neon)

1. Create a project. Choose Postgres 16 and the region nearest the Fly region you will use.
2. Copy the **direct** (not pooled) connection string. Add `?sslmode=require` if it isn't there. This is your `DATABASE_URL`.
3. Run the probe from [section 3](#3-choose-a-postgres-host-important).
4. Look at the project's backup settings: note how far back point-in-time restore goes on your plan, and see [section 12](#12-backups).

### 4.2 Photo storage (Cloudflare R2)

1. In the Cloudflare dashboard open R2 and create a bucket, for example `plenty-photos`. **Leave public access off** (no `r2.dev` URL, no custom domain). Photos are private; the app serves them only to members of the household.
2. Create an API token with **Object Read & Write**, limited to that bucket. Copy the Access Key ID and Secret Access Key (shown once).
3. Note your account's S3 address: `https://<account id>.r2.cloudflarestorage.com`.
4. Your settings are `STORAGE_DRIVER=s3`, `S3_ENDPOINT=<that address>`, `S3_REGION=auto`, `S3_BUCKET=plenty-photos`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.

Other S3-compatible storage works the same way; `deploy/production.env.example` shows the lines for AWS S3 (no endpoint, real region), Backblaze B2 and MinIO. The token needs to put, get, **list** and delete objects: deleting a household lists and deletes everything under its prefix. **Tested:** the same code against a local S3-compatible server, with 1,500 photos in one household (two listing pages) and a second household left untouched, and the SDK setting R2 needs. **Not tested:** R2, B2 or AWS themselves.

### 4.3 Your settings

1. `cp deploy/production.env.example production.env` and fill it in. It holds your passwords and keys: never commit it and never copy it anywhere shared. (The repository's `.gitignore` and `.dockerignore` both exclude `production.env` in the project folder, so it can't be committed or baked into the image by accident.)
2. Make the random values:

```bash
openssl rand -hex 24      # CRON_SECRET
openssl rand -hex 24      # ANALYTICS_SECRET
openssl rand -base64 48   # BILLING_ACCOUNT_SECRET (never change it later)
```

3. Check what you have so far, without touching anything:

```bash
npm install                                             # first time only
npm run check:prod -- --env-file production.env --env-only
```

### 4.4 Deploy to Fly.io

```bash
# once: install flyctl (fly.io/docs/flyctl/install) and sign in
fly auth login

cp fly.example.toml fly.toml            # edit: app name, region, APP_URL, legal name, support email, R2 address
fly apps create <your app name>

# the secret settings (these never go in fly.toml)
fly secrets set DATABASE_URL='postgres://…?sslmode=require' \
  CRON_SECRET=… SMTP_URL='smtps://…' \
  S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
  BILLING_ACCOUNT_SECRET=… ANALYTICS_SECRET=…

fly deploy
```

`fly deploy` builds the Dockerfile on Fly's builder (about 5 to 10 minutes the first time), then runs `node tools/setup.cjs` in a temporary machine **before** the new version starts (that is the `release_command` in `fly.example.toml`): migrations, product catalog, recipes. If it fails the deploy stops and the previous version keeps running. Fly passes the release command to the image's entrypoint, which runs it as given. It has your secrets but not your volumes, which is all `setup` needs.

Then:

```bash
fly status                              # a machine in the "started" state with 1/1 checks passing
curl https://<your app>.fly.dev/api/health    # {"ok":true,"database":"up"}
fly logs                                # watch the first minutes
```

The sizing in `fly.example.toml` is 1 GB: reading a receipt took the whole server up to about 260 MB in the tests, and 512 MB is too tight once photos are big or two are read at once.

### 4.5 Domain and https

See [section 8](#8-domain-and-https). Then set `APP_URL` in `fly.toml` to the https address and `fly deploy` again.

### 4.6 Seed, check, schedule

```bash
fly ssh console -C "/app/docker-entrypoint.sh seed"     # the demo household (section 9)
fly ssh console -C "/app/docker-entrypoint.sh check"    # the go-live check, with your real settings
```

Then set up the hourly job ([section 10](#10-the-hourly-jobs)) and register the webhooks you use ([section 11](#11-payment-webhooks)).

## 5. Path B: one server with Docker Compose

`docker-compose.prod.example.yml` runs four containers: Postgres 16, a one-shot `migrate` step (the `setup` command), Plenty, and Caddy (https certificates and a reverse proxy). **Tested:** Postgres, the one-shot step and the app, started through Compose with healthchecks, then `seed` and `check` run in it. **Not tested:** Caddy (the sandbox had no way to get a public certificate), so check that step on your own server.

1. **Rent a server.** Ubuntu 24.04, at least 2 GB of memory and 20 GB of disk. Point your domain's `A` record at its IP address.
2. **Prepare it:** log in over SSH, then `sudo apt-get update && sudo apt-get -y upgrade`, install Docker (docs.docker.com/engine/install/ubuntu), and open only what you need:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
sudo apt-get install -y unattended-upgrades
```

3. **Get the code:** `git clone <your repository> plenty && cd plenty`.
4. **Settings:** `cp deploy/production.env.example production.env` and fill it in. For this path set `PLENTY_DOMAIN` and `POSTGRES_PASSWORD` too (Compose builds `APP_URL` and `DATABASE_URL` from them). Leave `STORAGE_DRIVER=local` (delete the `S3_*` lines) or point it at a bucket.
5. **Start:**

```bash
docker compose --env-file production.env -f docker-compose.prod.example.yml up -d --build
docker compose --env-file production.env -f docker-compose.prod.example.yml ps       # postgres, app, caddy "healthy"; migrate "exited (0)"
docker compose --env-file production.env -f docker-compose.prod.example.yml run --rm app seed
docker compose --env-file production.env -f docker-compose.prod.example.yml run --rm app check
```

The bundled Postgres user is a superuser, so `check` shows one **WARN** ("Database user is a superuser"). That is expected here (the database is private to the Compose network and holds only Plenty).

6. **Backups are yours.** Add a daily dump and copy it off the server ([section 12](#12-backups)). Photos on the `plenty-photos` volume are not in the database dump.
7. **Updating:** `git pull` then the same `up -d --build` command. The `migrate` step runs first.

## 6. Every setting

All settings are environment variables, read when the server starts and never baked into the image. **Required** means `check:prod` fails without it. `deploy/production.env.example` has all of them in a fill-in template.

| Variable | Required? | Default | What it is, and where to get it |
|---|---|---|---|
| `DATABASE_URL` | **Required** | none | Postgres connection string. From your database host (use the direct connection; add `?sslmode=require`). |
| `DATABASE_POOL_SIZE` | No | `10` | Connections the server keeps open. Keep it below your database plan's limit divided by the number of servers. |
| `APP_URL` | **Required** | `http://localhost:3000` | The public **https** address, no trailing slash. Reset and invite links, Stripe's return pages and the Google Play audience are built from it. Must match the address the iPhone app uses. |
| `CRON_SECRET` | **Required** | none (jobs endpoint closed) | 24+ random characters: `openssl rand -hex 24`. Sent by whatever calls the hourly job. Anyone with it can run the jobs. |
| `LEGAL_ENTITY_NAME` | **Required** | none | Legal name of the person or company running the service, for the Privacy Policy and Terms. |
| `SUPPORT_EMAIL` | **Required** | none | Address shown on `/support`. You must read it. |
| `PRIVACY_CONTACT_EMAIL` | **Required** (or `SUPPORT_EMAIL`) | `SUPPORT_EMAIL` | Where privacy requests go. |
| `SMTP_URL` | **Required** | none | `smtps://user:password@host:465` from your email provider. Without it password-reset email is dropped (and the recipient and subject are logged: see [section 13](#13-logs-and-personal-data)). |
| `EMAIL_FROM` | Strongly advised | `Plenty <hello@plenty.local>` | The sender. Must be on a domain verified with your email provider, or they refuse the mail. Write it without quotes: `Plenty <hello@example.com>`. |
| `STORAGE_DRIVER` | No | `local` | `local` (server disk) or `s3` (object storage). |
| `STORAGE_DIR` | local only | `.data/uploads` (the image: `/data/uploads`) | Where photos go. Must be on a volume that survives redeploys. The image creates and owns `/data/uploads`. |
| `S3_BUCKET` | s3 only | none | The private bucket. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | s3 only | none | An access key that can put, get, list and delete in that bucket only. |
| `S3_ENDPOINT` | No | none (AWS) | The service's address for R2, B2, MinIO: `https://<account id>.r2.cloudflarestorage.com`. Leave out for AWS S3. |
| `S3_REGION` | No | `us-east-1` | AWS: the bucket's real region. R2: `auto`. B2: its region name. |
| `S3_FORCE_PATH_STYLE` | No | `false` | `true` for MinIO and some self-hosted services (`endpoint/bucket` instead of `bucket.endpoint`). |
| `TRUSTED_PROXY_HOPS` | Set it | `1` | How many proxies add to `X-Forwarded-For` in front of Plenty. 1 for Fly, Render, Railway or Caddy alone; 2 with Cloudflare in front of one of those. Too low: everyone shares one rate limit. Too high: visitors can fake their address. |
| `DEMO_MODE` | For App Review | off | `true` shows "Explore the demo household" on the sign-in page. The demo account is shared and public: never put real data in it. |
| `ANALYTICS_SECRET` | Optional | none | 16+ random characters. In production Plenty records no analytics at all until it is set. |
| `BILLING_ACCOUNT_SECRET` | For store purchases | none | 32+ random characters (`openssl rand -base64 48`). Ties App Store and Google Play purchases to a household. Never change it afterwards. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICES` | For web checkout | none | From Stripe ([`docs/billing.md`](billing.md)). All three or none. Use live values, not test ones. |
| `APPLE_BUNDLE_ID`, `APPLE_APP_ID`, `APPLE_ROOT_CERTS` | For App Store purchases | none | Bundle id and numeric app id from App Store Connect; Apple's root certificates as base64 (`base64 -i AppleRootCA-G3.cer \| tr -d '\n'`, several separated by commas) so no file has to be mounted. Without `APPLE_APP_ID` only sandbox purchases are accepted. `APPLE_PRODUCTS` overrides product ids (default `app.plenty.<plan>.<period>`). |
| `GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, `GOOGLE_PUBSUB_SERVICE_ACCOUNT`, `GOOGLE_PUBSUB_AUDIENCE`, `GOOGLE_PRODUCTS` | Android only | none | See [`docs/billing.md`](billing.md). Not needed for iPhone-only. |
| `ANTHROPIC_API_KEY`, `AI_PROVIDER`, `ANTHROPIC_MODEL` | Optional | none, `auto`, `claude-opus-5-5` | With a key, households that consent (on a plan that includes it) can have receipts read and recipes written by Claude. Without one, receipts use the built-in OCR and meals come from the built-in library. Using it changes your privacy disclosures. |
| `BARCODE_LOOKUP` | Optional | `openfoodfacts` | `off` stops Plenty asking Open Food Facts what an unknown barcode is (that discloses the barcode number, and nothing else, to them). |
| `PLAN_OVERRIDE` | **Never** | none | Gives a plan to every household for free. `check:prod` fails if it is set. |
| `EMAIL_OUTBOX` | **Never** | off | Test-only: keeps unsent emails (reset links included) in the database. |
| `PORT` | No | `3000` | The port the container listens on. |
| `PLENTY_SETUP_ON_START` | No | off | `true` runs `setup` every time the container starts. Fine for one server; with several instances starting together, run `setup` once per release instead. |
| `PLENTY_DOMAIN`, `POSTGRES_PASSWORD`, `PLENTY_IMAGE` | Compose only | none | Used by `docker-compose.prod.example.yml` only. |

`NODE_ENV=production` is set by the image. Don't set anything starting with `NEXT_PUBLIC_`: Plenty has none, and anything with that prefix would be sent to every browser.

**Check your settings any time:**

```bash
npm run check:prod -- --env-file production.env       # from a checkout; connects to the database and the storage
docker run --rm --env-file production.env <image> check      # from the image, exactly as the server will see it
fly ssh console -C "/app/docker-entrypoint.sh check"    # on Fly, with the real secrets
```

It prints PASS, WARN or FAIL for each setting, then checks the database (migrations applied, `plenty_app` exists, row-level security on every table, a query as `plenty_app`, the catalog loaded) and writes, reads and removes one test photo in your storage. It exits with status 1 if anything FAILs and never prints a secret value. Add `--env-only` to skip the database and storage.

## 7. Migrations

`setup` (the container command; `npm run setup` from a checkout) does three things, in order, and is safe to repeat:

1. **Migrations**: creates and updates tables, indexes, the `plenty_app` role, row-level security. Applied migrations are recorded in the database and never re-run.
2. **Product catalog** (about 400 products) and 3. **recipe library** (about 60 recipes): upserted. **Migrations alone do not load these**, which is why every deploy runs `setup`, not just `migrate`. `check:prod` fails when they are missing.

When to run it:

| Where | How |
|---|---|
| Fly.io | Automatic: the `release_command` in `fly.toml` runs it before each new version starts. |
| Compose | Automatic: the `migrate` service runs it on every `up`, and `app` waits for it. |
| Anywhere else | `docker run --rm --env-file production.env <image> setup`, before starting the new version. |
| A single server, nothing else | `PLENTY_SETUP_ON_START=true` runs it before the server starts. Don't use it with several instances. |
| From a checkout | `DATABASE_URL=… npm run setup` |

**First run.** The database user must satisfy [section 3](#3-choose-a-postgres-host-important). When it can't, setup stops with `permission denied to create role` (or `…to grant role`) and a note saying what to ask for.

**Going back.** Migrations only go forward; there are no "down" scripts. Before deploying a version that adds files to `drizzle/`, take a database backup ([section 12](#12-backups)).

## 8. Domain and https

The iPhone app, like any modern browser, only loads the site over https, and Plenty marks its sign-in cookie `Secure`, so plain http cannot sign anyone in.

**Fly.io** (**not tested**): add your domain and follow what Fly prints:

```bash
fly certs add plenty.example.com
fly certs show plenty.example.com       # tells you which DNS records to create
fly ips list                            # the addresses, if it asks for A / AAAA records
```

Create those records at your registrar, wait (minutes to hours), and run `fly certs show` until the certificate is issued. Fly then renews it automatically. Update `APP_URL`, redeploy, and open `https://plenty.example.com/api/health`.

**Path B:** the Compose file's Caddy gets and renews a Let's Encrypt certificate for `PLENTY_DOMAIN` on its own, once the domain's `A` record points at the server and ports 80 and 443 are open. Keep the `caddy-data` volume. (**Not tested.**)

**Behind your own proxy or CDN:** pass the original `Host` header through unchanged and set `TRUSTED_PROXY_HOPS` to the number of proxies. Next.js checks that a form's `Origin` matches the `Host`; a proxy that rewrites `Host` makes sign-in and sign-up fail (the server log says "Invalid Server Actions request"). **Not tested.**

Tell whoever builds the iPhone app the exact address: it must equal `APP_URL` (the project's `PLENTY_URL`, [`docs/ios-release.md`](ios-release.md)).

## 9. The demo household for App Review

Apple's reviewers need to look around without your data. Plenty ships a demo household and a one-tap "Explore the demo household" button.

1. Set `DEMO_MODE=true` and keep it on while the app is in review (and for as long as you want the button).
2. Create the demo data:

```bash
docker run --rm --env-file production.env <image> seed          # any host with Docker
docker compose --env-file production.env -f docker-compose.prod.example.yml run --rm app seed    # Path B
fly ssh console -C "/app/docker-entrypoint.sh seed"             # Fly.io
DATABASE_URL=… STORAGE_DIR=… npm run db:seed                     # from a checkout
```

   It takes about ten seconds. It simulates nine weeks of a household's life, leaves one receipt ready to check, and prints the sign-in: **`demo@plenty.app` / `plenty-demo`**. Running it again deletes and recreates only that demo household, nothing else. It stores one sample receipt photo with your configured storage, so run it after storage works.
3. Put those credentials in App Store Connect under App Review Information. The reviewer notes are drafted in `docs/store/listing.md`.

The demo account is **shared and public by design**. Never type real data into it, and don't expect it to be private. Check that sign-in works on the live site yourself before you submit. **Tested:** the seed ran inside the image, against a database, with the sample receipt read by the built-in OCR and saved to disk and to S3-compatible storage.

## 10. The hourly jobs

Plenty needs one call an hour:

```bash
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/cron/notifications"
```

It answers `{"ok":true,…}` with counts only. Each run:

* picks up receipts whose reading was interrupted (a restart in the middle of reading leaves them stuck on "reading" until this runs),
* creates the notifications people see (running low, check-ins, the weekly insight),
* **deletes receipt photos whose retention time is up** (the privacy promise: photos are removed after review by default),
* deletes expired sign-in sessions, spent reset links and old analytics.

**If it stops, photos are kept longer than people were told.** Make sure you notice. Without the right secret the endpoint answers 401 (**tested**).

Where to run the call from: **fly.toml has no cron**, so use one of these.

* **GitHub Actions** (free, easy to see failures): copy `deploy/cron-notifications.example.yml` to `.github/workflows/plenty-hourly-jobs.yml` in a repository you control, add the `CRON_SECRET` secret and the `PLENTY_URL` variable, and enable Actions. A failed run emails you. GitHub starts scheduled runs on a best-effort basis (they can be late) and, on a public repository, switches them off after 60 days without repository activity.
* **An external scheduler** (cron-job.org or similar): an hourly `POST` with the header `Authorization: Bearer <CRON_SECRET>`.
* **The server's own crontab** (Path B): `17 * * * * cd /path/to/plenty && docker compose --env-file production.env -f docker-compose.prod.example.yml run --rm app cron`
* `… <image> cron` runs the same jobs from inside a container (it needs the same settings).

Also set up an uptime monitor (UptimeRobot, Better Stack, anything) on `https://<your domain>/api/health`, which answers 200 when the server and database are up and 503 when the database is not.

## 11. Payment webhooks

All three live under your `APP_URL`. A provider that isn't fully configured answers `503 {"code":"not_configured"}` (**tested**); once configured, an unsigned request answers `400 {"code":"invalid"}`. **Tested** with a fake Stripe key; real providers were not available.

| Provider | URL | Where to set it |
|---|---|---|
| Stripe (web checkout) | `https://<APP_URL host>/api/billing/webhooks/stripe` | Dashboard → Developers → Webhooks → add endpoint. Subscribe to the events listed in [`docs/billing.md`](billing.md) (Stripe → "Stripe (web)", step 3). Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`. Do the whole thing in test mode first, then repeat with live keys. |
| Apple (App Store Server Notifications, version 2) | `https://<APP_URL host>/api/billing/webhooks/apple` | App Store Connect → your app → App Information → App Store Server Notifications: set **both** the Production Server URL **and** the Sandbox Server URL to that address, Version 2. Plenty accepts sandbox notifications on the production server on purpose (App Review tests that way). Needs `APPLE_BUNDLE_ID`, `APPLE_APP_ID`, `APPLE_ROOT_CERTS` and `BILLING_ACCOUNT_SECRET`. |
| Google Play (Android only) | `https://<APP_URL host>/api/billing/webhooks/google` | A Pub/Sub push subscription; see [`docs/billing.md`](billing.md). Not needed for iPhone-only. |

Webhook requests need the raw body untouched: don't put anything in front of these URLs that rewrites it. Alert on 5xx from them and on rows in `billing_events` with `processed_at` empty for more than a day.

## 12. Backups

**Database: two layers.**

1. **The host's point-in-time restore.** Find out how far back your plan goes (Neon calls it history retention) and write it down. This is for "I made a mistake an hour ago".
2. **Your own daily dump, stored somewhere else** (a different account or provider from the database). This is for "the host lost it" or "the account was closed".

```bash
# a dump (any machine with the Postgres 16 client; the file contains all your users' data, so keep it private)
pg_dump --format=custom --no-owner --file="plenty-$(date +%F).dump" "$DATABASE_URL"
# no pg_dump installed?
docker run --rm postgres:16 pg_dump --format=custom --no-owner "$DATABASE_URL" > "plenty-$(date +%F).dump"
```

Run it daily from the same scheduler as the hourly job, copy the file off, and delete old ones. Path B: `docker compose … exec -T postgres pg_dump -U plenty --format=custom --no-owner plenty > plenty-$(date +%F).dump`.

**Restoring** (**tested**: a dump with the demo household, restored into a new database on the same server and onto a brand-new server; `check:prod` passed on both):

```bash
# 1. An empty database, owned by the user the app will connect as.
# 2. A brand-new server doesn't have the app role yet: create it first, as that user (it needs CREATEROLE), or use the
#    WITH ADMIN OPTION recipe from section 3. On the same server it already exists.
psql "$NEW_DATABASE_URL" -c "create role plenty_app nologin nobypassrls" -c "grant plenty_app to current_user"
# 3. Restore. Do NOT add --no-acl: the permissions for plenty_app are in the dump.
pg_restore --no-owner --exit-on-error -d "$NEW_DATABASE_URL" plenty-2026-10-04.dump
# 4. Check it, then point DATABASE_URL at it.
npm run check:prod -- --env-file production.env
```

**Do a restore test once before launch.** A backup you have never restored is a hope, not a backup.

**Receipt photos.** By default Plenty deletes a photo as soon as a receipt is checked (households can choose to keep photos for 30 days, or until deleted), so the bucket holds few photos for a short time and most operators don't back them up. Think before you change that:

* Plenty promises deletion: after review, on discard, on account and household deletion. **Don't turn on bucket versioning, replication or backups that keep deleted photos** unless you tell people (privacy policy, `src/lib/privacy-content.ts`). If you do enable versioning, add a lifecycle rule that expires old versions within days.
* Deleted data also lingers in database backups until they age out (documented in [`docs/compliance/security-notes.md`](compliance/security-notes.md), known gap 4). Know your retention and state it.
* If a database restore is older than a photo, the receipt row is missing but the photo is still in the bucket (harmless but untidy); if a photo is missing, the receipt just shows without it.
* If deleting a household's photos fails (storage briefly down), the server logs `[deletion] photo files not removed` and the objects stay under `<household id>/`. Delete them by hand: with the AWS CLI, `aws s3 rm s3://<bucket>/<household id>/ --recursive --endpoint-url <S3_ENDPOINT>`.

**Local-disk photos (Path B):** they live in the `plenty-photos` volume. If you keep photos at all, back the volume up separately, with the same care about retention.

## 13. Logs and personal data

The server writes to standard output and standard error; your host keeps them for a while. Plenty does not log requests, but some lines name people or carry database error text:

* **Without `SMTP_URL`, production logs the recipient and subject of every email it drops** (`[email] SMTP_URL not configured…`). Set `SMTP_URL`. Even with it, a failed send (`[email] send failed:`) can include the address the mail server rejected.
* **Unhandled errors are logged with server detail**; people only see a friendly message, but the log can contain database error text.
* Rate-limit keys (emails and IP addresses) are in the database, not the logs ([`docs/compliance/security-notes.md`](compliance/security-notes.md), known gaps 5 to 7).

So: **treat logs as personal data.** Limit who can read them; keep them for days, not months (the Compose file rotates to five 10 MB files); don't ship them to a third-party log service without checking it against your Privacy Policy and the data map ([`docs/compliance/data-map.md`](compliance/data-map.md)), because that service would become one of your processors.

Other lines you will see: `[storage]` (photo storage problems), `[ocr]` (receipt reading), `[db]` (database connection errors), `[deletion]`, `[billing.*]`. None of them carry secrets (**tested** for the storage and check output: an access key never appears).

## 14. Updating, and going back

1. `git pull` (or choose the version to deploy).
2. If `drizzle/` has new files, take a database backup first ([section 12](#12-backups)).
3. **Fly.io:** `fly deploy`. **Compose:** `up -d --build`. **Anywhere else:** build and push the new image, run `setup` once, then start it.
4. `check:prod` again, and open the site.

**Going back** to the previous version is safe as long as the new version added no migration. If it did, the older code is running on a newer database: it usually still works (migrations add things), but that is not guaranteed. Restoring from the backup you took in step 2 is the sure way. On Fly: `fly releases` lists versions and `fly deploy --image <image ref of the earlier release>` redeploys one (the release command runs again, harmlessly). **Not tested.**

## 15. When something is wrong

| What you see | Likely cause and fix |
|---|---|
| Deploy stops at the release command with `permission denied to create role` | The database user can't create roles. [Section 3](#3-choose-a-postgres-host-important): use the probe, another host, or the `WITH ADMIN OPTION` recipe. |
| The server won't start: `Invalid environment configuration — …` | A setting is wrong; the message names it (never its value). Run `check`. |
| `check` says `Migrations … not applied` or `catalog … not loaded` | Run `setup` (section 7). |
| `check` says `Query as plenty_app` failed: `permission denied to set role` | The app connects as a different user than the one that ran the migrations. Use one user, or `GRANT plenty_app TO <that user>`. |
| `check` says the database connection failed | The message says which part (refused, password, unknown database). Add `?sslmode=require`; check the host's allow-list or firewall; use the direct connection (not the pooler). |
| Sign-in or sign-up does nothing; the log says `Invalid Server Actions request` | A proxy is changing the `Host` header: pass it through unchanged ([section 8](#8-domain-and-https)). **Not tested.** |
| Receipts stay on "reading" | The hourly job isn't running ([section 10](#10-the-hourly-jobs)), or the server ran out of memory and restarted (`fly logs` shows "Out of memory": use 1 GB or more). |
| "We couldn't save that photo" | Photo storage. `check` has a `Receipt photo storage` line and the log has a `[storage]` line with the reason. S3: wrong key, bucket, endpoint or region, or the key can't write. Local: the volume isn't mounted at `STORAGE_DIR`. |
| Photos disappear after a redeploy | `STORAGE_DRIVER=local` with a folder that isn't a volume. Mount one, or use S3. |
| Password-reset email never arrives | `SMTP_URL`, or `EMAIL_FROM` is on a domain your email provider hasn't verified. The log has `[email] send failed:` with the provider's reason. |
| Everyone gets "too many attempts" after a few sign-ins | `TRUSTED_PROXY_HOPS` is too low: all visitors look like the proxy's address. |
| The first request after a quiet spell is slow | A database host that suspends when idle (see Neon in section 3). |
| `/api/billing/webhooks/…` answers 503 | That provider isn't fully configured ([`docs/billing.md`](billing.md)). 400 means it is. |

## 16. Go-live checklist

Work down it in order. Tick a box only when you have seen it work, not when you have set it up.

**Accounts and domain**
- [ ] Domain bought; DNS pointing at the host; `https://<domain>/api/health` returns `{"ok":true,"database":"up"}` with a valid certificate.
- [ ] `APP_URL` is that https address, no trailing slash; the iPhone project's `PLENTY_URL` is the same.

**Data**
- [ ] The Postgres probe printed `OK` (or you used the `WITH ADMIN OPTION` recipe); `setup` ran; `check` shows migrations, `plenty_app`, row-level security and the catalog all PASS.
- [ ] A backup exists and **you restored it somewhere once**. You know how far back the host's point-in-time restore reaches.
- [ ] The photo bucket is private; the key can put, get, list and delete; versioning isn't silently keeping deleted photos.

**Settings**
- [ ] `PLAN_OVERRIDE` is not set. `EMAIL_OUTBOX` is not set.
- [ ] `LEGAL_ENTITY_NAME`, `SUPPORT_EMAIL`, `PRIVACY_CONTACT_EMAIL` are set, and the Privacy and Terms pages at `/privacy` and `/terms` show them. Lawyer has read the text.
- [ ] `SMTP_URL` and `EMAIL_FROM` work: use "Forgot password" on the live site and receive the email.
- [ ] `TRUSTED_PROXY_HOPS` is set deliberately.
- [ ] `CRON_SECRET` is 24+ random characters, and the hourly job has run at least once (look for the run).
- [ ] An uptime monitor watches `/api/health` and tells you.

**App Review and money**
- [ ] `DEMO_MODE=true`, the demo household seeded, `demo@plenty.app` / `plenty-demo` signs in on the live site, and the credentials are in App Store Connect.
- [ ] `BILLING_ACCOUNT_SECRET` set. Apple settings set; both Server Notification URLs entered (version 2). Stripe live keys, price ids and webhook set, if you sell on the web.
- [ ] A sandbox purchase and a restore worked against this server.

**Last step: run the check, from the real environment, and read all of it.**

```bash
fly ssh console -C "/app/docker-entrypoint.sh check"          # Fly.io
docker run --rm --env-file production.env <image> check  # anywhere with Docker
npm run check:prod -- --env-file production.env          # from a checkout
```

- [ ] **`npm run check:prod` ends with no FAIL**, and you have read every WARN and can say why each is acceptable (a missing Stripe configuration is fine if you don't sell on the web; a missing analytics secret is fine if you want no analytics; an unset `TRUSTED_PROXY_HOPS` is not).

## 17. What was not tested

Written on 2026-10-04 from a Linux sandbox with Docker, Postgres 16 and Node 22, no cloud accounts, and no access to the Fly.io, Neon or Cloudflare websites.

**Tested**

* The Docker image (linux/amd64): built from the `Dockerfile` (the build in the sandbox needed two extra lines trusting the sandbox's proxy certificate for `npm ci`; they are not in the repository's Dockerfile and don't affect the result). The build's last step ran the receipt-reading check inside the final image as the unprivileged user, and it caught a real packaging mistake during development (the OCR engine files tracing missed).
* Running that image: `setup` on an empty database, `seed`, `check`, `serve` with health checks passing, `PLENTY_SETUP_ON_START`, uploading a receipt over HTTP and having it read, stored, fetched back (and refused without a session), the hourly endpoint with and without its secret, and a bind-mounted photo folder owned by root being taken over by the entrypoint.
* The S3 driver: unit tests with a mocked client (save, read, delete, listing in pages, missing object, invalid keys, failures), and the real driver and SDK against a local S3-compatible server (moto), through the app in the container as well, including 1,500 photos in one household.
* Docker Compose (Postgres, `migrate`, `app` and their health conditions), `seed` and `check` run through it.
* The first migration as a Postgres user that is not a superuser (four permission scenarios in section 3), `check:prod` against a good setup, a bad one, an empty database, a table without row-level security, a wrong password and an unreachable server, and a dump and restore (same server and a new one).
* Webhook endpoints answering 503 unconfigured, 400 configured without a signature.

**Not tested: do these yourself**

* **linux/arm64.** If an arm64 build was run, it is described in the notes that came with this change; otherwise: the lockfile has the arm64 native packages, and the Dockerfile has no platform-specific step, but no arm64 image was built or run.
* **Any real provider:** Fly.io (`fly deploy`, `release_command`, certificates, secrets), Neon (the probe on its role, pooler behaviour, idle suspend), Cloudflare R2, Backblaze, AWS S3 (only a local S3-compatible server was used), your email provider, GitHub Actions scheduling, Stripe, App Store Connect notifications, Google Play.
* **Caddy and https** in the Compose file, and any proxy that rewrites the `Host` header (Next.js refuses sign-in forms then).
* **Postgres hosts other than a local server**, including every statement in section 3 about which hosts allow `CREATE ROLE`. Run the probe.
* **Memory and speed on your plan.** About 170 to 260 MB for the server with one sample receipt at a time; a 40-megapixel photo, or several at once, will use more.
* **More than one server instance**, apart from the design (rate limits are in Postgres; photos need S3).
* **The iOS app** loading the site, and Apple's reviewers using the demo account.
