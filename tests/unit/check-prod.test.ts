/**
 * `npm run check:prod`: the pure checks (scripts/lib/prod-checks.ts). Environments go in, PASS/WARN/FAIL lists come out;
 * the database checks run against a scripted stand-in connection (the real thing is in tests/integration/check-prod-db.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  checkDatabase,
  checkEnvironment,
  describeDatabaseUrl,
  exitCode,
  formatReport,
  safeMessage,
  summarize,
  type Check,
  type Db,
  type EnvSource,
  type Level,
} from "../../scripts/lib/prod-checks";

/** A throwaway self-signed certificate (public part only, valid to 2056). Stands in for an Apple root. */
const TEST_CERT_BASE64 =
  "MIIDOTCCAiGgAwIBAgIUSzYN3x99bTMYn7cqyTCyOItVZugwDQYJKoZIhvcNAQELBQAwKzEpMCcGA1UEAwwgUGxlbnR5IFRlc3QgUm9vdCAobm90IGEgcmVhbCBDQSkwIBcNMjYxMDA0MDYzNjUzWhgPMjA1NjA5MjYwNjM2NTNaMCsxKTAnBgNVBAMMIFBsZW50eSBUZXN0IFJvb3QgKG5vdCBhIHJlYWwgQ0EpMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkrzf33ZaShsIh/3LstZhxWfIx1+fZXMzotwZjFjidPVelpXimCxAo7+QCYdQlUN+nJ8Dx9W/5bR3GDkjiWu1YAZ8eqVV6PeXM0o0MMgvIXalf9tk+pAyvpXcbBbdrq8ClNkATFdbI41lllxhFOW1lMGGo+5OSdeYY5FXnowl7kaC4m1QERARCrAVKOcL1L1k9wSMNTpO3nzfYN/bZKicMysG0e3yLi+8Qxy4jBp9qyqU6NxeEXbQuBf+dwIVoeCDX61T0VEckVWFk6VlQmaa7oJgkjq8fBaJ67t1s4w84cf0Nv+FLpWj43o+wIrMNPF4ofzIAFkjaajibkzdjDISpwIDAQABo1MwUTAdBgNVHQ4EFgQU12+zKTwQuRxe6bo7mgYkTjnhNt0wHwYDVR0jBBgwFoAU12+zKTwQuRxe6bo7mgYkTjnhNt0wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAEGOPgFnU92gjhy3X1JeptSiR7crHnGkm9IU205FsKcYMXLp5KGKg8Jx6CSNUZNqt2gFpgADfd0d0q5n4NawH1zHuPH3w0fQpse0Vzcx8+1dmtPx9JtJ0pj+XK9u3qPXR+oTx2mesaziRz9J0Ojrls1mDUFdRpZeEcmEJerSXmwxF+22wxT3cQFGeVA1OV+Mu/RnhrI2LMy5xWePhHPlNrxCjCbutsvpAIXOktjL33+gpwBi5Ifj/Xz5DdOabEdLCDxjZToosoXHESyh7TSSx+FnPaqtxly3XxlcO2+x6o9T0kXIBboDlD4F5MUhpwo3dUe+kNWIEgusz03u0xcbP4A==";

const SECRETS = {
  DATABASE_URL: "postgres://plenty:pw-db-sEcReT-123@db.internal:5432/plenty",
  CRON_SECRET: "cron-sEcReT-0123456789abcdef0123456789",
  SMTP_URL: "smtps://mailer:pw-smtp-sEcReT-123@smtp.example.com:465",
  ANALYTICS_SECRET: "analytics-sEcReT-0123456789",
  BILLING_ACCOUNT_SECRET: "billing-sEcReT-0123456789abcdef0123456789",
  STRIPE_SECRET_KEY: "sk_live_sEcReT0123456789",
  STRIPE_WEBHOOK_SECRET: "whsec_sEcReT0123456789",
  S3_ACCESS_KEY_ID: "AKIAsEcReTKEYID0123",
  S3_SECRET_ACCESS_KEY: "s3-sEcReT-0123456789",
};

/** Everything a real production setup has, with every optional extra on. */
const GOOD: EnvSource = {
  ...SECRETS,
  DATABASE_URL: "postgres://plenty:pw-db-sEcReT-123@db.example.com:5432/plenty?sslmode=require",
  APP_URL: "https://plenty.example.com",
  LEGAL_ENTITY_NAME: "Example Pty Ltd",
  SUPPORT_EMAIL: "help@example.com",
  PRIVACY_CONTACT_EMAIL: "privacy@example.com",
  EMAIL_FROM: "Plenty <hello@example.com>",
  STORAGE_DRIVER: "s3",
  S3_BUCKET: "plenty-photos",
  S3_REGION: "auto",
  S3_ENDPOINT: "https://abc.r2.cloudflarestorage.com",
  TRUSTED_PROXY_HOPS: "1",
  DEMO_MODE: "true",
  STRIPE_PRICES: "plus.monthly=price_1,plus.annual=price_2,family.monthly=price_3,family.annual=price_4",
  APPLE_BUNDLE_ID: "app.plenty.ios",
  APPLE_APP_ID: "1234567890",
  APPLE_ROOT_CERTS: TEST_CERT_BASE64,
  NODE_ENV: "production",
};

const levels = (checks: Check[], name: string): Level[] => checks.filter((c) => c.name === name).map((c) => c.level);
const only = (checks: Check[], name: string): Check => {
  const found = checks.filter((c) => c.name === name);
  expect(found.length, `checks named ${name}`).toBeGreaterThan(0);
  return found[0];
};
const without = (env: EnvSource, ...names: string[]): EnvSource => {
  const copy = { ...env };
  for (const n of names) delete copy[n];
  return copy;
};
const withEnv = (extra: EnvSource) => ({ ...GOOD, ...extra });

describe("checkEnvironment: a complete setup", () => {
  const checks = checkEnvironment(GOOD);
  it("has no failures and no warnings", () => {
    expect(checks.filter((c) => c.level !== "PASS").map((c) => `${c.level} ${c.name}: ${c.message}`)).toEqual([]);
    expect(exitCode(checks)).toBe(0);
  });
});

describe("checkEnvironment: an empty one", () => {
  const checks = checkEnvironment({});
  it.each(["DATABASE_URL", "APP_URL", "CRON_SECRET", "LEGAL_ENTITY_NAME", "SUPPORT_EMAIL", "PRIVACY_CONTACT_EMAIL", "SMTP_URL"])("fails %s", (name) => {
    expect(levels(checks, name)).toContain("FAIL");
  });
  it.each(["ANALYTICS_SECRET", "DEMO_MODE", "TRUSTED_PROXY_HOPS", "BILLING_ACCOUNT_SECRET", "STRIPE", "APPLE", "STORAGE_DIR", "EMAIL_FROM"])("warns about %s", (name) => {
    expect(levels(checks, name)).toEqual(["WARN"]);
  });
  it("passes the things that are fine when absent", () => {
    expect(levels(checks, "PLAN_OVERRIDE")).toEqual(["PASS"]);
    expect(levels(checks, "GOOGLE_PLAY")).toEqual(["PASS"]);
  });
  it("exits 1", () => expect(exitCode(checks)).toBe(1));
  it("says what to do about each failure", () => {
    for (const c of checks.filter((c) => c.level === "FAIL")) expect(c.hint, c.name).toBeTruthy();
  });
});

describe("checkEnvironment: DATABASE_URL", () => {
  it("fails a value that isn't a Postgres address", () => {
    expect(levels(checkEnvironment(withEnv({ DATABASE_URL: "mysql://u:p@h/db" })), "DATABASE_URL")).toEqual(["FAIL"]);
    expect(levels(checkEnvironment(withEnv({ DATABASE_URL: "not a url" })), "DATABASE_URL")).toEqual(["FAIL"]);
  });
  it("accepts postgres:// and postgresql://", () => {
    expect(levels(checkEnvironment(withEnv({ DATABASE_URL: "postgresql://u:p@db.example.com/plenty?sslmode=require" })), "DATABASE_URL")).toEqual(["PASS"]);
  });
  it("warns about an internet database without sslmode, but not about a private one", () => {
    expect(levels(checkEnvironment(withEnv({ DATABASE_URL: "postgres://u:p@db.example.com:5432/plenty" })), "DATABASE_URL")).toEqual(["PASS", "WARN"]);
    for (const host of ["postgres", "db.internal", "plenty-db.flycast", "10.0.0.5", "192.168.1.9"]) {
      expect(levels(checkEnvironment(withEnv({ DATABASE_URL: `postgres://u:p@${host}:5432/plenty` })), "DATABASE_URL"), host).toEqual(["PASS"]);
    }
  });
  it("warns when encryption is explicitly off for an internet database", () => {
    expect(levels(checkEnvironment(withEnv({ DATABASE_URL: "postgres://u:p@db.example.com/plenty?sslmode=disable" })), "DATABASE_URL")).toEqual(["PASS", "WARN"]);
  });
  it("warns about localhost", () => {
    expect(levels(checkEnvironment(withEnv({ DATABASE_URL: "postgres://u:p@localhost:5432/plenty" })), "DATABASE_URL")).toEqual(["PASS", "WARN"]);
  });
});

describe("checkEnvironment: APP_URL", () => {
  it.each([
    ["http://plenty.example.com", "plain http"],
    ["https://localhost:3000", "localhost"],
    ["https://127.0.0.1", "loopback"],
    ["plenty.example.com", "no scheme"],
    ["", "blank"],
  ])("fails %j (%s)", (value) => {
    expect(levels(checkEnvironment(withEnv({ APP_URL: value })), "APP_URL")).toEqual(["FAIL"]);
  });
  it("fails when it is missing", () => expect(levels(checkEnvironment(without(GOOD, "APP_URL")), "APP_URL")).toEqual(["FAIL"]));
  it("passes https and says the host", () => {
    const c = only(checkEnvironment(GOOD), "APP_URL");
    expect(c.level).toBe("PASS");
    expect(c.message).toContain("plenty.example.com");
  });
  it("warns about a trailing slash or a path", () => {
    expect(levels(checkEnvironment(withEnv({ APP_URL: "https://plenty.example.com/" })), "APP_URL")).toEqual(["PASS", "WARN"]);
    expect(levels(checkEnvironment(withEnv({ APP_URL: "https://plenty.example.com/app" })), "APP_URL")).toEqual(["PASS", "WARN"]);
  });
});

describe("checkEnvironment: CRON_SECRET", () => {
  it("fails when missing, blank or under 24 characters", () => {
    expect(levels(checkEnvironment(without(GOOD, "CRON_SECRET")), "CRON_SECRET")).toEqual(["FAIL"]);
    expect(levels(checkEnvironment(withEnv({ CRON_SECRET: "   " })), "CRON_SECRET")).toEqual(["FAIL"]);
    expect(levels(checkEnvironment(withEnv({ CRON_SECRET: "x".repeat(23) })), "CRON_SECRET")).toEqual(["FAIL"]);
  });
  it("passes at exactly 24", () => expect(levels(checkEnvironment(withEnv({ CRON_SECRET: "x".repeat(24) })), "CRON_SECRET")).toEqual(["PASS"]));
});

describe("checkEnvironment: who runs Plenty", () => {
  it("fails each of the three contact settings when missing", () => {
    const env = without(GOOD, "LEGAL_ENTITY_NAME", "SUPPORT_EMAIL", "PRIVACY_CONTACT_EMAIL");
    const checks = checkEnvironment(env);
    expect(levels(checks, "LEGAL_ENTITY_NAME")).toEqual(["FAIL"]);
    expect(levels(checks, "SUPPORT_EMAIL")).toEqual(["FAIL"]);
    expect(levels(checks, "PRIVACY_CONTACT_EMAIL")).toEqual(["FAIL"]);
  });
  it("lets the privacy address fall back to the support address", () => {
    const c = only(checkEnvironment(without(GOOD, "PRIVACY_CONTACT_EMAIL")), "PRIVACY_CONTACT_EMAIL");
    expect(c.level).toBe("PASS");
    expect(c.message).toMatch(/SUPPORT_EMAIL/);
  });
  it("fails the privacy address when there is nothing to fall back on", () => {
    expect(levels(checkEnvironment(without(GOOD, "PRIVACY_CONTACT_EMAIL", "SUPPORT_EMAIL")), "PRIVACY_CONTACT_EMAIL")).toEqual(["FAIL"]);
  });
  it("treats a blank value as missing", () => {
    expect(levels(checkEnvironment(withEnv({ LEGAL_ENTITY_NAME: "  " })), "LEGAL_ENTITY_NAME")).toEqual(["FAIL"]);
  });
});

describe("checkEnvironment: analytics, email, plan, demo", () => {
  it("only warns when ANALYTICS_SECRET is missing: it is optional by design", () => {
    expect(levels(checkEnvironment(without(GOOD, "ANALYTICS_SECRET")), "ANALYTICS_SECRET")).toEqual(["WARN"]);
  });
  it("fails without SMTP_URL (password reset needs email) and warns about an odd one", () => {
    expect(levels(checkEnvironment(without(GOOD, "SMTP_URL")), "SMTP_URL")).toEqual(["FAIL"]);
    expect(levels(checkEnvironment(withEnv({ SMTP_URL: "mail.example.com:25" })), "SMTP_URL")).toEqual(["WARN"]);
  });
  it("warns about the development sender", () => {
    expect(levels(checkEnvironment(withEnv({ EMAIL_FROM: "Plenty <hello@plenty.local>" })), "EMAIL_FROM")).toEqual(["WARN"]);
    expect(levels(checkEnvironment(without(GOOD, "EMAIL_FROM")), "EMAIL_FROM")).toEqual(["WARN"]);
  });
  it("warns when the test outbox is on", () => {
    expect(levels(checkEnvironment(withEnv({ EMAIL_OUTBOX: "true" })), "EMAIL_OUTBOX")).toEqual(["WARN"]);
    expect(levels(checkEnvironment(withEnv({ EMAIL_OUTBOX: "false" })), "EMAIL_OUTBOX")).toEqual([]);
  });
  it("fails PLAN_OVERRIDE whatever it is set to", () => {
    for (const v of ["family", "plus", "pro", "free"]) expect(levels(checkEnvironment(withEnv({ PLAN_OVERRIDE: v })), "PLAN_OVERRIDE"), v).toEqual(["FAIL"]);
    expect(levels(checkEnvironment(withEnv({ PLAN_OVERRIDE: "" })), "PLAN_OVERRIDE")).toEqual(["PASS"]);
  });
  it("warns unless DEMO_MODE is on, reading it as the app does", () => {
    expect(levels(checkEnvironment(withEnv({ DEMO_MODE: "true" })), "DEMO_MODE")).toEqual(["PASS"]);
    expect(levels(checkEnvironment(withEnv({ DEMO_MODE: "1" })), "DEMO_MODE")).toEqual(["PASS"]);
    for (const v of ["false", "0", "yes", "", "TRUE"]) expect(levels(checkEnvironment(withEnv({ DEMO_MODE: v })), "DEMO_MODE"), v).toEqual(["WARN"]);
    expect(levels(checkEnvironment(without(GOOD, "DEMO_MODE")), "DEMO_MODE")).toEqual(["WARN"]);
  });
});

describe("checkEnvironment: TRUSTED_PROXY_HOPS", () => {
  it("warns, and explains, when left at the default", () => {
    const c = only(checkEnvironment(without(GOOD, "TRUSTED_PROXY_HOPS")), "TRUSTED_PROXY_HOPS");
    expect(c.level).toBe("WARN");
    expect(c.hint).toMatch(/X-Forwarded-For/);
    expect(c.hint).toMatch(/proxy/);
  });
  it("passes once it is set, including to 0 or 2", () => {
    for (const v of ["0", "1", "2"]) expect(levels(checkEnvironment(withEnv({ TRUSTED_PROXY_HOPS: v })), "TRUSTED_PROXY_HOPS"), v).toEqual(["PASS"]);
  });
});

describe("checkEnvironment: photo storage", () => {
  const local = (extra: EnvSource) => checkEnvironment({ ...without(GOOD, "STORAGE_DRIVER", "S3_BUCKET", "S3_REGION", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"), ...extra });
  it("warns when local storage has no explicit STORAGE_DIR", () => expect(levels(local({}), "STORAGE_DIR")).toEqual(["WARN"]));
  it("warns about a relative path, /tmp and the app folder", () => {
    for (const dir of [".data/uploads", "uploads", "/tmp/uploads", "/var/tmp/x", "/app/uploads", "/app"]) expect(levels(local({ STORAGE_DIR: dir }), "STORAGE_DIR"), dir).toEqual(["WARN"]);
  });
  it("passes an absolute path on a volume", () => {
    expect(levels(local({ STORAGE_DIR: "/data/uploads" }), "STORAGE_DIR")).toEqual(["PASS"]);
    expect(levels(local({ STORAGE_DRIVER: "local", STORAGE_DIR: "/mnt/volume/uploads" }), "STORAGE_DIR")).toEqual(["PASS"]);
  });
  it("fails an unknown driver", () => expect(levels(local({ STORAGE_DRIVER: "gcs" }), "STORAGE_DRIVER")).toEqual(["FAIL"]));
  it("passes a complete S3 setup and doesn't ask about STORAGE_DIR", () => {
    const checks = checkEnvironment(GOOD);
    expect(levels(checks, "STORAGE_DRIVER")).toEqual(["PASS"]);
    expect(levels(checks, "STORAGE_DIR")).toEqual([]);
  });
  it.each(["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])("fails S3 without %s", (name) => {
    const c = only(checkEnvironment(without(GOOD, name)), "STORAGE_DRIVER");
    expect(c.level).toBe("FAIL");
    expect(c.message).toContain(name);
  });
  it("warns when AWS has no region", () => {
    expect(levels(checkEnvironment(without(GOOD, "S3_ENDPOINT", "S3_REGION")), "S3_REGION")).toEqual(["WARN"]);
    expect(levels(checkEnvironment(without(GOOD, "S3_REGION")), "S3_REGION")).toEqual([]);
  });
});

describe("checkEnvironment: billing", () => {
  it("warns without BILLING_ACCOUNT_SECRET: store purchases are unavailable", () => {
    const c = only(checkEnvironment(without(GOOD, "BILLING_ACCOUNT_SECRET")), "BILLING_ACCOUNT_SECRET");
    expect(c.level).toBe("WARN");
    expect(c.message).toMatch(/store purchases/);
  });
  it("warns when Stripe is missing or partial, and passes when whole", () => {
    expect(levels(checkEnvironment(GOOD), "STRIPE")).toEqual(["PASS"]);
    expect(levels(checkEnvironment(without(GOOD, "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICES")), "STRIPE")).toEqual(["WARN"]);
    for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICES"]) {
      const c = only(checkEnvironment(without(GOOD, name)), "STRIPE");
      expect(c.level, name).toBe("WARN");
      expect(c.message, name).toContain(name);
    }
  });
  it("warns about a Stripe test key", () => {
    expect(levels(checkEnvironment(withEnv({ STRIPE_SECRET_KEY: "sk_test_abc" })), "STRIPE_SECRET_KEY")).toEqual(["WARN"]);
    expect(levels(checkEnvironment(withEnv({ STRIPE_SECRET_KEY: "rk_test_abc" })), "STRIPE_SECRET_KEY")).toEqual(["WARN"]);
    expect(levels(checkEnvironment(GOOD), "STRIPE_SECRET_KEY")).toEqual([]);
  });
  it("warns when the APPLE settings are missing or partial, and passes when whole", () => {
    expect(levels(checkEnvironment(GOOD), "APPLE")).toEqual(["PASS"]);
    expect(levels(checkEnvironment(without(GOOD, "APPLE_BUNDLE_ID", "APPLE_APP_ID", "APPLE_ROOT_CERTS")), "APPLE")).toEqual(["WARN"]);
    for (const name of ["APPLE_BUNDLE_ID", "APPLE_APP_ID", "APPLE_ROOT_CERTS"]) {
      const c = only(checkEnvironment(without(GOOD, name)), "APPLE");
      expect(c.level, name).toBe("WARN");
      expect(c.message, name).toContain(name);
    }
  });
  it("reads APPLE_ROOT_CERTS the way the app does", () => {
    expect(levels(checkEnvironment(GOOD), "APPLE_ROOT_CERTS")).toEqual(["PASS"]);
    // a file path
    const readFile = (p: string) => (p === "/certs/root.cer" ? Buffer.from(TEST_CERT_BASE64, "base64") : Buffer.from("nope"));
    expect(levels(checkEnvironment(withEnv({ APPLE_ROOT_CERTS: "/certs/root.cer" }), { readFile }), "APPLE_ROOT_CERTS")).toEqual(["PASS"]);
    // several, comma separated
    expect(only(checkEnvironment(withEnv({ APPLE_ROOT_CERTS: `${TEST_CERT_BASE64}, /certs/root.cer` }), { readFile }), "APPLE_ROOT_CERTS").message).toMatch(/^2 certificates/);
    // a path that isn't there, and junk
    const missing = () => {
      throw new Error("ENOENT");
    };
    expect(levels(checkEnvironment(withEnv({ APPLE_ROOT_CERTS: "/certs/missing.cer" }), { readFile: missing }), "APPLE_ROOT_CERTS")).toEqual(["WARN"]);
    expect(levels(checkEnvironment(withEnv({ APPLE_ROOT_CERTS: "bm90IGEgY2VydA==" })), "APPLE_ROOT_CERTS")).toEqual(["WARN"]);
  });
  it("warns about an expired root certificate", () => {
    expect(levels(checkEnvironment(GOOD, { now: new Date("2060-01-01") }), "APPLE_ROOT_CERTS")).toEqual(["WARN"]);
  });
  it("warns about a half-configured Google Play, and not about an absent one", () => {
    expect(levels(checkEnvironment(withEnv({ GOOGLE_PLAY_PACKAGE_NAME: "app.plenty" })), "GOOGLE_PLAY")).toEqual(["WARN"]);
    expect(levels(checkEnvironment(GOOD), "GOOGLE_PLAY")).toEqual(["PASS"]);
  });
});

describe("checkEnvironment: NODE_ENV", () => {
  it("says nothing when it is production or absent, and warns for anything else", () => {
    expect(levels(checkEnvironment(GOOD), "NODE_ENV")).toEqual([]);
    expect(levels(checkEnvironment(without(GOOD, "NODE_ENV")), "NODE_ENV")).toEqual([]);
    expect(levels(checkEnvironment(withEnv({ NODE_ENV: "development" })), "NODE_ENV")).toEqual(["WARN"]);
  });
});

describe("checkEnvironment never prints a secret", () => {
  it("keeps every secret value out of every message and hint, whatever is wrong", () => {
    const scenarios: EnvSource[] = [
      GOOD,
      withEnv({ APP_URL: "http://plenty.example.com", CRON_SECRET: "short", STRIPE_SECRET_KEY: "sk_test_sEcReT0123456789" }),
      withEnv({ DATABASE_URL: "mysql://plenty:pw-db-sEcReT-123@db.example.com/plenty", SMTP_URL: "mail.example.com pw-smtp-sEcReT-123" }),
      withEnv({ STORAGE_DRIVER: "s3", S3_BUCKET: "" }),
      withEnv({ APPLE_ROOT_CERTS: "pw-apple-sEcReT-cert-not-a-cert" }),
      { ...SECRETS, DATABASE_URL: "postgres://plenty:pw-db-sEcReT-123@localhost:5432/plenty" },
    ];
    const secretValues = [...Object.values(SECRETS), "pw-db-sEcReT-123", "pw-smtp-sEcReT-123", "pw-apple-sEcReT-cert-not-a-cert", "sEcReT"];
    for (const env of scenarios) {
      const text = JSON.stringify(checkEnvironment(env));
      for (const secret of secretValues) expect(text, secret).not.toContain(secret);
    }
  });
});

describe("report", () => {
  const checks: Check[] = [
    { level: "PASS", name: "A", message: "is fine." },
    { level: "WARN", name: "B", message: "is odd.", hint: "Look at it." },
    { level: "FAIL", name: "C", message: "is broken.", hint: "Fix it." },
  ];
  it("counts and exits 1 on a failure only", () => {
    expect(summarize(checks)).toEqual({ pass: 1, warn: 1, fail: 1 });
    expect(exitCode(checks)).toBe(1);
    expect(exitCode(checks.slice(0, 2))).toBe(0);
    expect(exitCode([])).toBe(0);
  });
  it("prints every result with its level, hints for WARN and FAIL, and a verdict", () => {
    const text = formatReport(checks);
    expect(text).toContain("PASS  A: is fine.");
    expect(text).toContain("WARN  B: is odd.");
    expect(text).toContain("FAIL  C: is broken.");
    expect(text).toContain("-> Look at it.");
    expect(text).toContain("-> Fix it.");
    expect(text).toContain("1 passed, 1 warning, 1 failed.");
    expect(text).toContain("Not ready");
  });
  it("gives no hint for a PASS, and no colour codes unless asked", () => {
    const text = formatReport([{ level: "PASS", name: "A", message: "ok", hint: "never shown" }]);
    expect(text).not.toContain("never shown");
    expect(text).not.toContain("\x1b[");
    expect(text).toContain("Ready to go live.");
    expect(formatReport(checks, { color: true })).toContain("\x1b[31mFAIL");
  });
  it("wraps long hints", () => {
    const long = "word ".repeat(80).trim();
    const lines = formatReport([{ level: "WARN", name: "A", message: "m", hint: long }]).split("\n");
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(110);
  });
});

describe("describeDatabaseUrl and safeMessage", () => {
  it("shows where, never who or with what password", () => {
    expect(describeDatabaseUrl("postgres://user:pw-sEcReT@db.example.com:5432/plenty?sslmode=require")).toBe("db.example.com:5432/plenty");
    expect(describeDatabaseUrl("garbage")).toBe("the database");
  });
  it("scrubs addresses and long tokens from an error", () => {
    const text = safeMessage(new Error("bad postgres://u:p@h/db and token abcdefghijklmnopqrstuvwxyz0123456789ABCD"));
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});

// ─── Database checks, against a scripted connection ─────────────────────────

type Reply = Array<Record<string, unknown>> | Error;
/** Answers each query by matching its text; unanswered ones return no rows. */
function fakeDb(replies: Array<[RegExp, Reply]>): Db & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async query(text: string) {
      log.push(text);
      for (const [pattern, reply] of replies) {
        if (pattern.test(text)) {
          if (reply instanceof Error) throw reply;
          return { rows: reply };
        }
      }
      return { rows: [] };
    },
  };
}

const JOURNAL = [
  { tag: "0000_a", when: 1000 },
  { tag: "0001_b", when: 2000 },
];
const HEALTHY: Array<[RegExp, Reply]> = [
  [/current_setting\('server_version'\)/, [{ u: "plenty", d: "plenty", v: "16.4", su: false }]],
  [/to_regclass/, [{ present: true }]],
  [/from drizzle\.__drizzle_migrations/, [{ created_at: "1000" }, { created_at: "2000" }]],
  [/from pg_roles where rolname = \$1/, [{ rolsuper: false, rolbypassrls: false, rolcanlogin: false }]],
  [/from pg_class c/, [{ name: "households", rls: true }, { name: "products", rls: true }]],
  [/select current_user as u, 1 as one/, [{ u: "plenty_app", one: 1 }]],
  [/count\(\*\) from households/, [{ h: 0, m: 0 }]],
  [/from products where household_id is null/, [{ p: 411, m: 64 }]],
];
const withReplies = (...overrides: Array<[RegExp, Reply]>) => [...overrides, ...HEALTHY];
const run = (replies: Array<[RegExp, Reply]>, journal: typeof JOURNAL | null = JOURNAL) => checkDatabase(fakeDb(replies), { journal, target: "db.example.com:5432/plenty" });

describe("checkDatabase", () => {
  it("passes a healthy database", async () => {
    const checks = await run(HEALTHY);
    expect(checks.filter((c) => c.level !== "PASS")).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual(["Database connection", "Migrations", "Role plenty_app", "Row-level security", "Query as plenty_app", "Product catalog and recipes"]);
  });

  it("always rolls back the smoke test transaction, and runs it as plenty_app with a person who has no household", async () => {
    const db = fakeDb(HEALTHY);
    await checkDatabase(db, { journal: JOURNAL, target: "t" });
    const begin = db.log.indexOf("begin");
    const rollback = db.log.indexOf("rollback");
    expect(begin).toBeGreaterThan(-1);
    expect(rollback).toBeGreaterThan(begin);
    expect(db.log.some((q) => q.includes("set_config('role'"))).toBe(true);
    expect(db.log.filter((q) => /\b(insert|update|delete|create|drop|alter)\b/i.test(q))).toEqual([]);
  });

  it("fails when migrations are pending, naming them", async () => {
    const checks = await run(withReplies([/from drizzle\.__drizzle_migrations/, [{ created_at: "1000" }]]));
    const c = only(checks, "Migrations");
    expect(c.level).toBe("FAIL");
    expect(c.message).toContain("0001_b");
    expect(c.message).not.toContain("0000_a");
  });
  it("fails when the migrations table doesn't exist (an empty database)", async () => {
    const checks = await run(withReplies([/to_regclass/, [{ present: false }]]));
    expect(only(checks, "Migrations").level).toBe("FAIL");
  });
  it("warns when the database is ahead of this version", async () => {
    const checks = await run(withReplies([/from drizzle\.__drizzle_migrations/, [{ created_at: "1000" }, { created_at: "2000" }, { created_at: "3000" }]]));
    expect(only(checks, "Migrations").level).toBe("WARN");
  });
  it("can't compare without the journal, and says so", async () => {
    expect(only(await run(HEALTHY, null), "Migrations").level).toBe("WARN");
  });

  it("fails when the plenty_app role doesn't exist", async () => {
    const checks = await run(withReplies([/from pg_roles where rolname = \$1/, []]));
    const c = only(checks, "Role plenty_app");
    expect(c.level).toBe("FAIL");
    expect(c.hint).toMatch(/CREATE ROLE/);
  });
  it("fails when plenty_app could bypass row-level security", async () => {
    for (const role of [{ rolsuper: true, rolbypassrls: false }, { rolsuper: false, rolbypassrls: true }]) {
      expect(only(await run(withReplies([/from pg_roles where rolname = \$1/, [role]])), "Role plenty_app").level).toBe("FAIL");
    }
  });

  it("fails and names every table that doesn't have row-level security", async () => {
    const checks = await run(withReplies([/from pg_class c/, [{ name: "households", rls: true }, { name: "notes", rls: false }, { name: "extras", rls: false }]]));
    const c = only(checks, "Row-level security");
    expect(c.level).toBe("FAIL");
    expect(c.message).toContain("notes");
    expect(c.message).toContain("extras");
    expect(c.message).not.toContain("households");
  });
  it("stops after the structure checks when there are no tables at all", async () => {
    const checks = await run(withReplies([/to_regclass/, [{ present: false }]], [/from pg_class c/, []]));
    expect(checks.map((c) => c.name)).not.toContain("Query as plenty_app");
    expect(only(checks, "Row-level security").level).toBe("FAIL");
  });

  it("fails when plenty_app can see households without a signed-in member", async () => {
    const c = only(await run(withReplies([/count\(\*\) from households/, [{ h: 3, m: 7 }]])), "Query as plenty_app");
    expect(c.level).toBe("FAIL");
    expect(c.message).toMatch(/can see households/);
  });
  it("explains a database user that can't switch to plenty_app", async () => {
    const c = only(await run(withReplies([/set_config\('role'/, new Error('permission denied to set role "plenty_app"')])), "Query as plenty_app");
    expect(c.level).toBe("FAIL");
    expect(c.hint).toMatch(/GRANT plenty_app/);
  });
  it("fails when the query doesn't run as plenty_app", async () => {
    expect(only(await run(withReplies([/select current_user as u, 1 as one/, [{ u: "plenty", one: 1 }]])), "Query as plenty_app").level).toBe("FAIL");
  });
  it("still rolls back when the smoke test throws", async () => {
    const db = fakeDb(withReplies([/set_config\('role'/, new Error("boom")]));
    await checkDatabase(db, { journal: JOURNAL, target: "t" });
    expect(db.log.filter((q) => q === "rollback")).toHaveLength(1);
  });

  it("fails when the catalog or recipes haven't been loaded (migrations alone don't load them)", async () => {
    for (const row of [{ p: 0, m: 64 }, { p: 411, m: 0 }, { p: 0, m: 0 }]) {
      const c = only(await run(withReplies([/from products where household_id is null/, [row]])), "Product catalog and recipes");
      expect(c.level).toBe("FAIL");
      expect(c.hint).toMatch(/setup/);
    }
  });
  it("warns when the database user is a superuser", async () => {
    const checks = await run(withReplies([/current_setting\('server_version'\)/, [{ u: "postgres", d: "plenty", v: "16.4", su: true }]]));
    expect(only(checks, "Database user").level).toBe("WARN");
  });
  it("keeps the connection string out of what it reports", async () => {
    const text = JSON.stringify(await run(withReplies([/to_regclass/, new Error("could not connect to postgres://plenty:pw-sEcReT@db/plenty")])));
    expect(text).not.toContain("pw-sEcReT");
  });
});
