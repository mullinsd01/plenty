/**
 * SYNTHETIC billing fixtures. (Signed Apple payloads are stamped with the current time, because the
 * throwaway certificates below are valid from now: Apple's library checks a certificate against the
 * time the payload was signed.)
 *
 * SYNTHETIC billing fixtures. Nothing here came from Stripe, Apple or Google:
 * every payload is made up to match the documented shape, and the Apple
 * certificate chain below is generated on the fly with OpenSSL and is not
 * Apple's. Tests built on these prove Plenty's own handling (verification
 * logic, mapping, state changes), not that the real services accept or send
 * exactly this. See docs/billing.md for what still has to be proven live.
 */
import { createPrivateKey, createSign, X509Certificate, type KeyObject } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const opensslAvailable = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

export interface SyntheticAppleChain {
  /** DER of the synthetic root, to give the verifier as its trusted root. */
  rootDer: Buffer;
  /** A different root that signed nothing, to prove untrusted roots are refused. */
  strangerRootDer: Buffer;
  /** Sign a payload as the synthetic "App Store". */
  sign(payload: Record<string, unknown>, opts?: { chain?: "full" | "short" }): string;
  /** Sign with a key that isn't the leaf's, keeping the genuine chain: a forgery. */
  forge(payload: Record<string, unknown>): string;
  cleanup(): void;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** A root, an intermediate and a leaf carrying the Apple marker extensions the verifier looks for. Needs `openssl`. */
export function makeSyntheticAppleChain(): SyntheticAppleChain {
  const dir = mkdtempSync(join(tmpdir(), "plenty-synthetic-apple-"));
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  const genKey = (name: string) => run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);

  const makeRoot = (name: string) => {
    genKey(name);
    run("req", "-new", "-x509", "-key", `${name}.key`, "-out", `${name}.pem`, "-days", "36500", "-sha256", "-subj", `/CN=Synthetic ${name} CA`, "-addext", "basicConstraints=critical,CA:TRUE");
  };
  const makeChild = (name: string, issuer: string, extension: string, isCa: boolean) => {
    genKey(name);
    run("req", "-new", "-key", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=Synthetic ${name}`);
    writeFileSync(join(dir, `${name}.ext`), `basicConstraints=critical,CA:${isCa ? "TRUE" : "FALSE"}\n${extension}=ASN1:NULL\n`);
    run("x509", "-req", "-in", `${name}.csr`, "-CA", `${issuer}.pem`, "-CAkey", `${issuer}.key`, "-CAcreateserial", "-out", `${name}.pem`, "-days", "36500", "-sha256", "-extfile", `${name}.ext`);
  };

  makeRoot("root");
  makeRoot("stranger");
  makeChild("intermediate", "root", "1.2.840.113635.100.6.2.1", true);
  makeChild("leaf", "intermediate", "1.2.840.113635.100.6.11.1", false);
  genKey("forger");

  const der = (name: string) => new X509Certificate(readFileSync(join(dir, `${name}.pem`))).raw;
  const key = (name: string): KeyObject => createPrivateKey(readFileSync(join(dir, `${name}.key`)));
  const x5c = (full: boolean) => [der("leaf"), der("intermediate"), ...(full ? [der("root")] : [])].map((d) => d.toString("base64"));

  const jws = (payload: Record<string, unknown>, signer: KeyObject, chain: string[]) => {
    const header = b64url(JSON.stringify({ alg: "ES256", x5c: chain }));
    const body = b64url(JSON.stringify(payload));
    const signature = createSign("SHA256").update(`${header}.${body}`).sign({ key: signer, dsaEncoding: "ieee-p1363" });
    return `${header}.${body}.${b64url(signature)}`;
  };

  return {
    rootDer: der("root"),
    strangerRootDer: der("stranger"),
    sign: (payload, opts) => jws(payload, key("leaf"), x5c(opts?.chain !== "short")),
    forge: (payload) => jws(payload, key("forger"), x5c(true)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ─── Apple payload builders (synthetic) ──────────────────────────────────────

export const APPLE_BUNDLE = "app.plenty.test";
export const APPLE_APP_ID = 1234567890;

export function appleTransaction(over: Record<string, unknown> = {}) {
  return {
    transactionId: "2000000000000002",
    originalTransactionId: "2000000000000001",
    bundleId: APPLE_BUNDLE,
    productId: "app.plenty.plus.monthly",
    purchaseDate: Date.UTC(2026, 2, 1),
    originalPurchaseDate: Date.UTC(2026, 2, 1),
    expiresDate: Date.UTC(2026, 3, 1),
    quantity: 1,
    type: "Auto-Renewable Subscription",
    inAppOwnershipType: "PURCHASED",
    signedDate: Date.now(),
    environment: "Sandbox",
    transactionReason: "PURCHASE",
    storefront: "AUS",
    ...over,
  };
}

export function appleRenewal(over: Record<string, unknown> = {}) {
  return {
    originalTransactionId: "2000000000000001",
    autoRenewProductId: "app.plenty.plus.monthly",
    productId: "app.plenty.plus.monthly",
    autoRenewStatus: 1,
    environment: "Sandbox",
    signedDate: Date.now(),
    recentSubscriptionStartDate: Date.UTC(2026, 2, 1),
    renewalDate: Date.UTC(2026, 3, 1),
    ...over,
  };
}

export function appleNotification(
  chain: SyntheticAppleChain,
  args: { type: string; subtype?: string; uuid?: string; environment?: string; bundleId?: string; transaction?: Record<string, unknown> | null; renewal?: Record<string, unknown> | null; signedDate?: number },
) {
  const environment = args.environment ?? "Sandbox";
  const data: Record<string, unknown> = { environment, bundleId: args.bundleId ?? APPLE_BUNDLE, bundleVersion: "1", ...(environment === "Production" ? { appAppleId: APPLE_APP_ID } : {}) };
  if (args.transaction !== null) data.signedTransactionInfo = chain.sign(args.transaction ?? appleTransaction({ environment }));
  if (args.renewal !== null) data.signedRenewalInfo = chain.sign(args.renewal ?? appleRenewal({ environment }));
  return chain.sign({
    notificationType: args.type,
    ...(args.subtype ? { subtype: args.subtype } : {}),
    notificationUUID: args.uuid ?? "11111111-2222-4333-8444-555555555555",
    data,
    version: "2.0",
    signedDate: args.signedDate ?? Date.now(),
  });
}

// ─── Stripe payload builders (synthetic) ─────────────────────────────────────

export const STRIPE_PRICES = {
  "plus.monthly": "price_plus_monthly_synthetic",
  "plus.annual": "price_plus_annual_synthetic",
  "family.monthly": "price_family_monthly_synthetic",
  "family.annual": "price_family_annual_synthetic",
} as const;

export const SYNTHETIC_HOUSEHOLD = "0b6f2d94-8d0a-4c5e-9a53-6a3a1d6f7c11";
export const SYNTHETIC_USER = "7d1c3f20-2b7e-4f0b-8a31-9c5b1e4d2a66";

export function stripeSubscription(over: Record<string, unknown> = {}) {
  return {
    id: "sub_synthetic_1",
    object: "subscription",
    status: "active",
    customer: "cus_synthetic_1",
    cancel_at_period_end: false,
    cancel_at: null,
    ended_at: null,
    trial_end: null,
    metadata: { household_id: SYNTHETIC_HOUSEHOLD, purchaser_user_id: SYNTHETIC_USER },
    items: { data: [{ price: { id: STRIPE_PRICES["plus.monthly"] }, current_period_start: Date.UTC(2026, 2, 1) / 1000, current_period_end: Date.UTC(2026, 3, 1) / 1000 }] },
    ...over,
  };
}

export function stripeEvent(type: string, object: unknown, over: { id?: string; created?: number } = {}) {
  return { id: over.id ?? `evt_synthetic_${type}`, object: "event", type, created: over.created ?? Date.UTC(2026, 2, 1, 0, 1) / 1000, data: { object } };
}
