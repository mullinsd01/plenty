import "server-only";
import { z } from "zod";

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
   * How many reverse proxies you run in front of Plenty that append to
   * X-Forwarded-For. The client IP used for rate limiting is read that many
   * entries from the right, so a client can't pick its own address.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  DEMO_MODE: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
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
