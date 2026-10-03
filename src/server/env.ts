import "server-only";
import { z } from "zod";
import { parseProductMap } from "@/lib/billing/product-ids";

/** `plan.period=product-id` pairs (see src/lib/billing/product-ids.ts), validated when the environment is read. */
function productMapSetting() {
  return z
    .string()
    .optional()
    .transform((v, ctx) => {
      const { map, problems } = parseProductMap(v);
      for (const problem of problems) ctx.addIssue({ code: "custom", message: problem });
      return map;
    });
}

/** An optional email address; blank means not set. */
function optionalEmail() {
  return z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      if (!z.email().safeParse(v).success) ctx.addIssue({ code: "custom", message: "must be an email address" });
      return v;
    });
}

/**
 * Server-side environment, validated once. Never import this from client
 * components — secrets must stay on the server.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  ANTHROPIC_API_KEY: z.string().optional().transform((v) => (v ? v : undefined)),
  AI_PROVIDER: z.enum(["auto", "local", "anthropic"]).default("auto"),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  SMTP_URL: z.string().optional().transform((v) => (v ? v : undefined)),
  EMAIL_FROM: z.string().default("Plenty <hello@plenty.local>"),
  /** Keep an outbox of unsent emails even in production (end-to-end tests only). */
  EMAIL_OUTBOX: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  STORAGE_DIR: z.string().default(".data/uploads"),
  CRON_SECRET: z.string().optional().transform((v) => (v ? v : undefined)),
  /**
   * Treat every household without a paid subscription as being on this plan.
   * For self-hosting and development, where there's no billing; leave unset in production.
   */
  PLAN_OVERRIDE: z.enum(["free", "plus", "family", "pro"]).optional(),
  // ─── Billing (all optional: a provider with missing settings is simply not offered) ───
  /** Secret that makes the per-household purchase tokens given to the store apps unforgeable (32+ characters). */
  BILLING_ACCOUNT_SECRET: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      if (v.length < 32) ctx.addIssue({ code: "custom", message: "must be at least 32 characters" });
      return v;
    }),
  STRIPE_SECRET_KEY: z.string().optional().transform((v) => (v ? v : undefined)),
  STRIPE_WEBHOOK_SECRET: z.string().optional().transform((v) => (v ? v : undefined)),
  /** `plus.monthly=price_…,plus.annual=price_…,family.monthly=price_…,family.annual=price_…` */
  STRIPE_PRICES: productMapSetting(),
  APPLE_BUNDLE_ID: z.string().optional().transform((v) => (v ? v : undefined)),
  /** The app's numeric Apple ID (App Store Connect → App Information). Needed to accept production notifications. */
  APPLE_APP_ID: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) ctx.addIssue({ code: "custom", message: "must be the app's numeric Apple ID" });
      return n;
    }),
  /** Apple root certificates: comma-separated file paths or base64 DER. */
  APPLE_ROOT_CERTS: z.string().optional().transform((v) => (v ? v : undefined)),
  APPLE_PRODUCTS: productMapSetting(),
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional().transform((v) => (v ? v : undefined)),
  /** A Google service account key (JSON, or base64 of it) allowed to read subscriptions in Play Console. */
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z.string().optional().transform((v) => (v ? v : undefined)),
  /** The Pub/Sub push endpoint URL (the OIDC token's audience). Defaults to APP_URL + /api/billing/webhooks/google. */
  GOOGLE_PUBSUB_AUDIENCE: z.string().optional().transform((v) => (v ? v : undefined)),
  /** The service account the Pub/Sub push subscription signs its token as. */
  GOOGLE_PUBSUB_SERVICE_ACCOUNT: z.string().optional().transform((v) => (v ? v : undefined)),
  GOOGLE_PRODUCTS: productMapSetting(),
  /**
   * How many reverse proxies you run in front of Plenty that append to
   * X-Forwarded-For. The client IP used for rate limiting is read that many
   * entries from the right, so a client can't pick its own address.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  DEMO_MODE: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  // ─── Legal, support and analytics (all optional) ───
  /** Who operates this Plenty, as the public Privacy and Terms pages name them. Never invented: unset means the line is left out. */
  LEGAL_ENTITY_NAME: z.string().trim().max(200).optional().transform((v) => (v ? v : undefined)),
  /** Where people get help; shown on /support and in the app. */
  SUPPORT_EMAIL: optionalEmail(),
  /** Where privacy requests (access, correction, deletion) go; falls back to SUPPORT_EMAIL. */
  PRIVACY_CONTACT_EMAIL: optionalEmail(),
  /**
   * Keys the pseudonymous household id used in first-party analytics (16+ characters).
   * In production, analytics records nothing until this is set.
   */
  ANALYTICS_SECRET: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      if (v.length < 16) ctx.addIssue({ code: "custom", message: "must be at least 16 characters" });
      return v;
    }),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const isProduction = () => env().NODE_ENV === "production";
