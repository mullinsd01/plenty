/**
 * The checks behind `npm run check:prod` (scripts/check-prod.ts).
 *
 * Pure where it can be: `checkEnvironment` takes an environment object and returns a list of results, so it
 * is unit tested without touching the process. `checkDatabase` takes one open database connection.
 *
 * Nothing in here ever puts a secret value in a result: messages name the setting and say what is wrong,
 * never what it is set to (a web address, a bucket name or a database name is not a secret; a key, password
 * or connection string is).
 */
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

export type Level = "PASS" | "WARN" | "FAIL";

export interface Check {
  level: Level;
  /** What was checked: a setting name, or a short label. */
  name: string;
  /** What was found. */
  message: string;
  /** What to do about it (WARN and FAIL). */
  hint?: string;
}

export type EnvSource = Record<string, string | undefined>;

const pass = (name: string, message: string): Check => ({ level: "PASS", name, message });
const warn = (name: string, message: string, hint?: string): Check => ({ level: "WARN", name, message, hint });
const fail = (name: string, message: string, hint?: string): Check => ({ level: "FAIL", name, message, hint });

/** A value counts as set when it has something other than spaces in it. */
function value(env: EnvSource, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/** The same reading of "on" as src/server/env.ts uses for DEMO_MODE and friends. */
function isOn(v: string | undefined): boolean {
  return v === "true" || v === "1";
}

function parseUrl(v: string): URL | null {
  try {
    return new URL(v);
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** True for a host only reachable from the same machine or the same private network (no TLS expected). */
function isPrivateHost(host: string): boolean {
  if (LOCAL_HOSTS.has(host)) return true;
  // A bare name like `postgres` is a container-network service name; `.internal` / `.flycast` are Fly's private network.
  if (!host.includes(".")) return true;
  if (host.endsWith(".internal") || host.endsWith(".flycast") || host.endsWith(".local")) return true;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

export interface EnvironmentIO {
  /** Reads a certificate file named in APPLE_ROOT_CERTS. */
  readFile?: (path: string) => Buffer;
  now?: Date;
}

// ─── Environment ────────────────────────────────────────────────────────────

export function checkEnvironment(env: EnvSource, io: EnvironmentIO = {}): Check[] {
  const checks: Check[] = [];
  const add = (...c: Check[]) => checks.push(...c);

  // Database
  const databaseUrl = value(env, "DATABASE_URL");
  if (!databaseUrl) {
    add(fail("DATABASE_URL", "is not set.", "Set it to your Postgres connection string, e.g. postgres://user:password@host:5432/plenty"));
  } else {
    const url = parseUrl(databaseUrl);
    if (!url || !/^postgres(ql)?:$/.test(url.protocol)) {
      add(fail("DATABASE_URL", "is not a Postgres connection string.", "It should start with postgres:// or postgresql://."));
    } else {
      add(pass("DATABASE_URL", "is set."));
      const sslmode = url.searchParams.get("sslmode");
      if (!isPrivateHost(url.hostname) && !sslmode && !url.searchParams.has("ssl")) {
        add(
          warn(
            "DATABASE_URL",
            "points at a database on the internet but doesn't ask for an encrypted connection.",
            "Add ?sslmode=require to the connection string (most managed Postgres hosts require it anyway).",
          ),
        );
      } else if (sslmode === "disable" && !isPrivateHost(url.hostname)) {
        add(warn("DATABASE_URL", "turns encryption off (sslmode=disable) for a database on the internet.", "Use sslmode=require."));
      }
      if (LOCAL_HOSTS.has(url.hostname)) {
        add(warn("DATABASE_URL", "points at this same machine (localhost).", "Fine if Postgres runs next to the app; wrong if you meant a hosted database."));
      }
    }
  }

  // Public address
  const appUrl = value(env, "APP_URL");
  if (!appUrl) {
    add(fail("APP_URL", "is not set (it defaults to http://localhost:3000).", "Set it to your public address, e.g. https://app.example.com. Reset-password and invitation links are built from it."));
  } else {
    const url = parseUrl(appUrl);
    if (!url) {
      add(fail("APP_URL", "is not a valid web address.", "Write it in full, e.g. https://app.example.com"));
    } else if (url.protocol !== "https:") {
      add(fail("APP_URL", `starts with ${url.protocol}// instead of https://.`, "Serve Plenty over https only (session cookies are marked Secure in production) and set APP_URL to the https address."));
    } else if (LOCAL_HOSTS.has(url.hostname)) {
      add(fail("APP_URL", "points at localhost.", "Set it to the public address people and the iOS app will use."));
    } else {
      add(pass("APP_URL", `is https://${url.host}`));
      if (appUrl.endsWith("/") || (url.pathname !== "/" && url.pathname !== "")) {
        add(warn("APP_URL", "has a trailing slash or a path.", "Use just the address, like https://app.example.com. Links are built by adding paths to it."));
      }
    }
  }

  // Scheduled jobs
  const cron = value(env, "CRON_SECRET");
  if (!cron) {
    add(fail("CRON_SECRET", "is not set, so the scheduled-jobs endpoint stays closed.", "Set a random value of 24+ characters (openssl rand -hex 24) and call /api/cron/notifications hourly with it."));
  } else if (cron.length < 24) {
    add(fail("CRON_SECRET", "is shorter than 24 characters.", "Use a longer random value: openssl rand -hex 24"));
  } else {
    add(pass("CRON_SECRET", "is set and long enough."));
  }

  // Who runs this Plenty (public Privacy, Terms and Support pages; the stores require them)
  const entity = value(env, "LEGAL_ENTITY_NAME");
  add(
    entity
      ? pass("LEGAL_ENTITY_NAME", "is set.")
      : fail("LEGAL_ENTITY_NAME", "is not set, so the Privacy Policy and Terms don't say who runs Plenty.", "Set the legal name of the person or company that operates the service."),
  );
  const support = value(env, "SUPPORT_EMAIL");
  add(
    support
      ? pass("SUPPORT_EMAIL", "is set.")
      : fail("SUPPORT_EMAIL", "is not set, so /support has no way to reach you.", "Set an address you read. The App Store listing needs working support contact details."),
  );
  const privacy = value(env, "PRIVACY_CONTACT_EMAIL");
  if (privacy) add(pass("PRIVACY_CONTACT_EMAIL", "is set."));
  else if (support) add(pass("PRIVACY_CONTACT_EMAIL", "is not set; privacy requests go to SUPPORT_EMAIL."));
  else add(fail("PRIVACY_CONTACT_EMAIL", "is not set and there is no SUPPORT_EMAIL to fall back on.", "Set an address for privacy requests (access, correction, deletion)."));

  // Analytics
  const analytics = value(env, "ANALYTICS_SECRET");
  add(
    analytics
      ? pass("ANALYTICS_SECRET", "is set.")
      : warn("ANALYTICS_SECRET", "is not set, so Plenty records no analytics in production.", "That is fine if you don't want any. To measure usage, set 16+ random characters (openssl rand -hex 24)."),
  );

  // Email
  const smtp = value(env, "SMTP_URL");
  if (!smtp) {
    add(fail("SMTP_URL", "is not set, so password-reset and invitation emails are dropped.", "Set your email provider's SMTP address, e.g. smtps://user:password@smtp.example.com:465"));
  } else if (!/^smtps?:\/\//i.test(smtp)) {
    add(warn("SMTP_URL", "doesn't start with smtp:// or smtps://.", "Check the format your email provider gives you."));
  } else {
    add(pass("SMTP_URL", "is set."));
  }
  const from = value(env, "EMAIL_FROM");
  if (!from || /@plenty\.local\b/i.test(from)) {
    add(
      warn(
        "EMAIL_FROM",
        "is still the development sender (hello@plenty.local).",
        'Set it to an address on a domain you have verified with your email provider, e.g. EMAIL_FROM="Plenty <hello@example.com>". Most providers refuse unverified senders.',
      ),
    );
  } else {
    add(pass("EMAIL_FROM", "is set."));
  }
  if (isOn(value(env, "EMAIL_OUTBOX"))) {
    add(warn("EMAIL_OUTBOX", "is on, which keeps unsent emails (reset links included) in the database.", "It is for end-to-end tests only. Remove it in production."));
  }

  // Receipt photos
  checkStorage(env, add);

  // Things that must not be on
  const planOverride = value(env, "PLAN_OVERRIDE");
  add(
    planOverride
      ? fail("PLAN_OVERRIDE", "is set, which gives a plan to every household for free.", "Remove it. It is for self-hosting and development only.")
      : pass("PLAN_OVERRIDE", "is not set."),
  );

  // Demo household
  if (isOn(value(env, "DEMO_MODE"))) {
    add(pass("DEMO_MODE", "is on: the sign-in page offers the demo household App Review needs (seed it with the seed command)."));
  } else {
    add(warn("DEMO_MODE", "is not on, so the sign-in page has no demo login.", "Apple's App Review needs a way to look around without your personal data: set DEMO_MODE=true and seed the demo household."));
  }

  // Rate limiting by client address
  if (value(env, "TRUSTED_PROXY_HOPS") === undefined) {
    add(
      warn(
        "TRUSTED_PROXY_HOPS",
        "is not set, so it defaults to 1.",
        "Plenty reads the visitor's address from X-Forwarded-For, counting this many proxies in from the right, to rate-limit sign-ins. 1 is right when exactly one proxy or load balancer sits in front (Fly, Render, Caddy). " +
          "Use 2 if there are two (for example Cloudflare in front of Fly). Too low and every visitor looks like the same address (they share one limit, so a few failed sign-ins can lock everyone out); too high and a visitor can invent their own address and dodge the limits. Set it explicitly once you know.",
      ),
    );
  } else {
    add(pass("TRUSTED_PROXY_HOPS", `is set to ${value(env, "TRUSTED_PROXY_HOPS")}.`));
  }

  // Billing
  checkBilling(env, io, add);

  // The runtime mode
  const nodeEnv = value(env, "NODE_ENV");
  if (nodeEnv && nodeEnv !== "production") {
    add(warn("NODE_ENV", `is "${nodeEnv}".`, "Run the server with NODE_ENV=production (the Docker image does). Development mode turns off protections such as Secure cookies."));
  }

  return checks;
}

function checkStorage(env: EnvSource, add: (...c: Check[]) => void): void {
  const driver = value(env, "STORAGE_DRIVER") ?? "local";
  if (driver !== "local" && driver !== "s3") {
    add(fail("STORAGE_DRIVER", "must be local or s3.", "Use s3 for object storage, local for the server's own disk."));
    return;
  }
  if (driver === "s3") {
    const missing = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter((n) => !value(env, n));
    if (missing.length > 0) {
      add(fail("STORAGE_DRIVER", `is s3 but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.`, "Create a private bucket and an access key that can read, write, list and delete in it."));
      return;
    }
    add(pass("STORAGE_DRIVER", `is s3 (bucket ${value(env, "S3_BUCKET")}).`));
    const endpoint = value(env, "S3_ENDPOINT");
    if (endpoint && !parseUrl(endpoint)) add(fail("S3_ENDPOINT", "is not a valid web address.", "Write it in full, e.g. https://<account>.r2.cloudflarestorage.com"));
    if (!endpoint && !value(env, "S3_REGION")) {
      add(warn("S3_REGION", "is not set, so it defaults to us-east-1.", "AWS S3 needs the bucket's real region (for example ap-southeast-2). Other providers say which value to use."));
    }
    return;
  }
  // Local disk
  const dir = value(env, "STORAGE_DIR");
  const name = "STORAGE_DIR";
  if (!dir) {
    add(
      warn(
        name,
        "is not set, so receipt photos go to .data/uploads inside the app folder. A redeploy or a new container would lose them.",
        "Set STORAGE_DIR to a mounted volume (the Docker image uses /data/uploads), or use STORAGE_DRIVER=s3.",
      ),
    );
  } else if (!dir.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(dir)) {
    add(warn(name, `is a relative path (${dir}), which lives inside the app folder and is lost on redeploy.`, "Use an absolute path on a mounted volume, e.g. /data/uploads."));
  } else if (/^\/(tmp|var\/tmp|app)(\/|$)/.test(dir)) {
    add(warn(name, `is ${dir}, which doesn't survive a redeploy.`, "Use a mounted volume, e.g. /data/uploads."));
  } else {
    add(pass(name, `is ${dir}. Make sure that path is a volume that survives redeploys; local storage also means one server only.`));
  }
}

const STRIPE_TEST_KEY = /^(sk|rk)_test_/;

function checkBilling(env: EnvSource, io: EnvironmentIO, add: (...c: Check[]) => void): void {
  const account = value(env, "BILLING_ACCOUNT_SECRET");
  add(
    account
      ? pass("BILLING_ACCOUNT_SECRET", "is set.")
      : warn("BILLING_ACCOUNT_SECRET", "is not set, so App Store and Google Play purchases can't be matched to a household and store purchases are unavailable.", "Set 32+ random characters (openssl rand -base64 48) and never change it afterwards."),
  );

  // Stripe (web checkout)
  const stripe = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICES"];
  const stripeMissing = stripe.filter((n) => !value(env, n));
  if (stripeMissing.length === stripe.length) {
    add(warn("STRIPE", "is not configured, so web checkout is off.", "Fine if you only sell through the App Store. See docs/billing.md to turn it on."));
  } else if (stripeMissing.length > 0) {
    add(warn("STRIPE", `is only partly set (${stripeMissing.join(", ")} missing), so web checkout is off.`, "Set all three of STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICES, or none."));
  } else {
    add(pass("STRIPE", "is configured: web checkout is on. Webhook: <APP_URL>/api/billing/webhooks/stripe"));
    if (STRIPE_TEST_KEY.test(value(env, "STRIPE_SECRET_KEY")!)) {
      add(warn("STRIPE_SECRET_KEY", "is a test-mode key.", "Real customers can't pay with it. Use the live key (and the live webhook secret and prices) when you go live."));
    }
  }

  // Apple (App Store subscriptions)
  const apple = ["APPLE_BUNDLE_ID", "APPLE_APP_ID", "APPLE_ROOT_CERTS"];
  const appleMissing = apple.filter((n) => !value(env, n));
  if (appleMissing.length === apple.length) {
    add(warn("APPLE", "is not configured, so App Store subscriptions can't be verified or restored.", "Needed before the app sells subscriptions: set APPLE_BUNDLE_ID, APPLE_APP_ID and APPLE_ROOT_CERTS (docs/billing.md)."));
  } else if (appleMissing.length > 0) {
    const needsRoots = appleMissing.includes("APPLE_ROOT_CERTS") || appleMissing.includes("APPLE_BUNDLE_ID");
    add(
      warn(
        "APPLE",
        `is only partly set (${appleMissing.join(", ")} missing).`,
        needsRoots
          ? "Without a bundle id and root certificates App Store subscriptions stay off; without APPLE_APP_ID only sandbox purchases are accepted."
          : "Without APPLE_APP_ID only sandbox purchases are accepted, so real purchases won't be applied.",
      ),
    );
  } else {
    add(pass("APPLE", "is configured. Notification URL: <APP_URL>/api/billing/webhooks/apple"));
  }
  const roots = value(env, "APPLE_ROOT_CERTS");
  if (roots) add(checkAppleRoots(roots, io));

  // Google Play (optional: only if there is an Android app)
  const google = ["GOOGLE_PLAY_PACKAGE_NAME", "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "GOOGLE_PUBSUB_SERVICE_ACCOUNT"];
  const googleMissing = google.filter((n) => !value(env, n));
  if (googleMissing.length === google.length) {
    add(pass("GOOGLE_PLAY", "is not configured (fine if you only ship on iOS)."));
  } else if (googleMissing.length > 0) {
    add(warn("GOOGLE_PLAY", `is only partly set (${googleMissing.join(", ")} missing), so Google Play purchases are off.`, "Set all three, or none."));
  } else {
    add(pass("GOOGLE_PLAY", "is configured. Push URL: <APP_URL>/api/billing/webhooks/google"));
  }
}

/** Each entry is a certificate file path or base64 DER, as the app reads them (src/server/billing/providers/apple.ts). */
function checkAppleRoots(raw: string, io: EnvironmentIO): Check {
  const readFile = io.readFile ?? ((p: string) => readFileSync(p));
  const now = io.now ?? new Date();
  const entries = raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) return warn("APPLE_ROOT_CERTS", "has no certificates in it.", "List Apple's root certificates, comma-separated.");
  let n = 0;
  for (const entry of entries) {
    n += 1;
    try {
      const buf = /^[./~]/.test(entry) ? readFile(entry) : Buffer.from(entry, "base64");
      const cert = new X509Certificate(buf);
      if (new Date(cert.validTo) < now) return warn("APPLE_ROOT_CERTS", `certificate ${n} has expired.`, "Download the current Apple root certificates from apple.com/certificateauthority.");
    } catch {
      return warn(
        "APPLE_ROOT_CERTS",
        `entry ${n} can't be read as a certificate.`,
        "Each entry is a path to a certificate file that exists inside the running container, or the certificate itself as base64 (base64 -i AppleRootCA-G3.cer | tr -d '\\n'). Without a readable root certificate Apple purchases stay off.",
      );
    }
  }
  return pass("APPLE_ROOT_CERTS", `${entries.length} certificate${entries.length === 1 ? "" : "s"} read and in date.`);
}

// ─── Database ───────────────────────────────────────────────────────────────

/** One open connection (a pg Client). Everything runs on it, in order. */
export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface JournalEntry {
  tag: string;
  when: number;
}

/** What the database says it is: a safe description of where we connected, without credentials. */
export function describeDatabaseUrl(databaseUrl: string): string {
  const url = parseUrl(databaseUrl);
  if (!url) return "the database";
  const db = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return `${url.hostname}${url.port ? `:${url.port}` : ""}/${db}`;
}

/** The app's own database role (migration 0002 creates it). */
export const APP_ROLE = "plenty_app";

export async function checkDatabase(db: Db, opts: { journal: JournalEntry[] | null; target: string }): Promise<Check[]> {
  const checks: Check[] = [];

  // Connected, and which server.
  const info = await db.query("select current_user as u, current_database() as d, current_setting('server_version') as v, (select rolsuper from pg_roles where rolname = current_user) as su");
  const row = info.rows[0] ?? {};
  checks.push(pass("Database connection", `connected to ${opts.target} (PostgreSQL ${String(row.v ?? "?")}).`));
  if (row.su === true) {
    checks.push(warn("Database user", "is a superuser.", "It works, but give the app a user that owns only its own database. Superusers bypass every protection."));
  }

  // Migrations.
  checks.push(await checkMigrations(db, opts.journal));

  // The restricted role.
  const role = await db.query("select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = $1", [APP_ROLE]);
  if (role.rows.length === 0) {
    checks.push(
      fail(
        `Role ${APP_ROLE}`,
        "does not exist, so household separation (row-level security) can't work.",
        "The first migration creates it and needs a database user that can CREATE ROLE (see docs/deploy.md). Run the setup command with such a user.",
      ),
    );
  } else if (role.rows[0].rolsuper === true || role.rows[0].rolbypassrls === true) {
    checks.push(fail(`Role ${APP_ROLE}`, "can bypass row-level security (it is a superuser or has BYPASSRLS).", `Run: ALTER ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS;`));
  } else {
    checks.push(pass(`Role ${APP_ROLE}`, "exists and is subject to row-level security."));
  }

  // Row-level security on every table in public.
  const tables = await db.query(
    `select c.relname as name, c.relrowsecurity as rls
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition and c.relname not like '\\_\\_%'
      order by c.relname`,
  );
  const unprotected = tables.rows.filter((t) => t.rls !== true).map((t) => String(t.name));
  if (tables.rows.length === 0) {
    checks.push(fail("Row-level security", "there are no tables in the public schema.", "Run the setup command."));
  } else if (unprotected.length > 0) {
    checks.push(fail("Row-level security", `is off for ${unprotected.length} table(s): ${unprotected.join(", ")}.`, "Every table must have it. Run: ALTER TABLE public.<name> ENABLE ROW LEVEL SECURITY; and add a migration."));
  } else {
    checks.push(pass("Row-level security", `is on for all ${tables.rows.length} tables.`));
  }

  // Nothing below can work without the tables; the failures above already say so.
  if (tables.rows.length === 0) return checks;

  // The app role works, and sees nothing without a signed-in user.
  checks.push(await smokeAsAppRole(db));

  // The built-in catalog and recipes (loaded by the setup command, not by migrations).
  checks.push(await checkLibrary(db));

  return checks;
}

async function checkMigrations(db: Db, journal: JournalEntry[] | null): Promise<Check> {
  const name = "Migrations";
  let applied: number[];
  try {
    const present = await db.query("select to_regclass('drizzle.__drizzle_migrations') is not null as present");
    if (present.rows[0]?.present !== true) {
      return fail(name, "have not been applied (the database is empty).", "Run the setup command (node tools/setup.cjs in the Docker image, npm run setup elsewhere).");
    }
    const rows = await db.query("select created_at from drizzle.__drizzle_migrations");
    applied = rows.rows.map((r) => Number(r.created_at));
  } catch (err) {
    return fail(name, `couldn't be read: ${safeMessage(err)}`);
  }
  if (!journal) {
    return applied.length > 0
      ? warn(name, `${applied.length} applied, but the list of migrations that belong to this version couldn't be read, so they can't be compared.`, "Run the check from the app folder (it reads drizzle/meta/_journal.json).")
      : fail(name, "have not been applied.", "Run the setup command.");
  }
  const appliedSet = new Set(applied);
  const pending = journal.filter((j) => !appliedSet.has(j.when));
  if (pending.length > 0) {
    return fail(name, `${pending.length} of ${journal.length} not applied yet (${pending.map((p) => p.tag).join(", ")}).`, "Run the setup command before starting this version.");
  }
  const known = new Set(journal.map((j) => j.when));
  const unknown = applied.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    return warn(name, `all ${journal.length} applied, and the database has ${unknown.length} more that this version doesn't know.`, "You may be running an older version of Plenty than the database was migrated by.");
  }
  return pass(name, `all ${journal.length} applied (latest ${journal[journal.length - 1]?.tag}).`);
}

/** Do what the app does for a signed-in request, as a person who belongs to no household. Always rolled back. */
async function smokeAsAppRole(db: Db): Promise<Check> {
  const name = `Query as ${APP_ROLE}`;
  const nobody = "00000000-0000-4000-8000-000000000000";
  try {
    await db.query("begin");
    try {
      await db.query("select set_config('role', $1, true), set_config('app.user_id', $2, true)", [APP_ROLE, nobody]);
      const who = await db.query("select current_user as u, 1 as one");
      if (who.rows[0]?.u !== APP_ROLE || who.rows[0]?.one !== 1) return fail(name, `ran, but not as ${APP_ROLE}.`, "SET ROLE did not take effect: check the database user can switch to the role.");
      const visible = await db.query("select (select count(*) from households)::int as h, (select count(*) from household_members)::int as m");
      const seen = Number(visible.rows[0]?.h ?? 0) + Number(visible.rows[0]?.m ?? 0);
      if (seen > 0) return fail(name, "can see households that a person without a household shouldn't.", "Row-level security isn't doing its job. Do not go live: check drizzle/0002_rls.sql was applied.");
      return pass(name, "works (select 1), and sees no household data without a signed-in member.");
    } finally {
      await db.query("rollback").catch(() => undefined);
    }
  } catch (err) {
    const message = safeMessage(err);
    if (/permission denied to set role|must be member/i.test(message)) {
      return fail(
        name,
        `the database user in DATABASE_URL can't switch to ${APP_ROLE}.`,
        `Migration 0002 grants the role to the user that ran the migrations, so run them as the same user the app connects as. Or, as an administrator: GRANT ${APP_ROLE} TO <that user>;`,
      );
    }
    return fail(name, `failed: ${message}`);
  }
}

async function checkLibrary(db: Db): Promise<Check> {
  const name = "Product catalog and recipes";
  try {
    const counts = await db.query("select (select count(*) from products where household_id is null)::int as p, (select count(*) from meals where household_id is null)::int as m");
    const p = Number(counts.rows[0]?.p ?? 0);
    const m = Number(counts.rows[0]?.m ?? 0);
    if (p === 0 || m === 0) {
      return fail(name, `are not loaded (${p === 0 ? "no products" : "products ok"}, ${m === 0 ? "no recipes" : "recipes ok"}).`, "The setup command loads them; migrations alone don't. Run it once and again after upgrades.");
    }
    return pass(name, `loaded (${p} products, ${m} recipes).`);
  } catch (err) {
    return warn(name, `couldn't be checked: ${safeMessage(err)}`);
  }
}

/** An error's message with anything that looks like a connection string or a long token removed. */
export function safeMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, "<address>")
    .replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, "<redacted>")
    .slice(0, 300);
}

// ─── Report ─────────────────────────────────────────────────────────────────

export function summarize(checks: Check[]): { pass: number; warn: number; fail: number } {
  return {
    pass: checks.filter((c) => c.level === "PASS").length,
    warn: checks.filter((c) => c.level === "WARN").length,
    fail: checks.filter((c) => c.level === "FAIL").length,
  };
}

/** Exit status for the command: 1 when anything failed. */
export function exitCode(checks: Check[]): number {
  return checks.some((c) => c.level === "FAIL") ? 1 : 0;
}

const COLORS: Record<Level, string> = { PASS: "\x1b[32m", WARN: "\x1b[33m", FAIL: "\x1b[31m" };

/** Break text into lines of at most `width` characters (words are never split), each starting with `indent`. */
function wrap(text: string, width: number, indent: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && indent.length + line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = `   ${word}`;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

export function formatReport(checks: Check[], opts: { color?: boolean; hints?: boolean } = {}): string {
  const paint = (level: Level) => (opts.color ? `${COLORS[level]}${level}\x1b[0m` : level);
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`  ${paint(c.level)}  ${c.name}: ${c.message}`);
    if (c.hint && c.level !== "PASS" && opts.hints !== false) lines.push(...wrap(`-> ${c.hint}`, 100, "        "));
  }
  const s = summarize(checks);
  lines.push("", `${s.pass} passed, ${s.warn} warning${s.warn === 1 ? "" : "s"}, ${s.fail} failed.`);
  lines.push(
    s.fail > 0
      ? "Not ready: fix every FAIL before going live."
      : s.warn > 0
        ? "Ready to go live once you've read each WARN and decided it is acceptable."
        : "Ready to go live.",
  );
  return lines.join("\n");
}
