import "server-only";
import { eq } from "drizzle-orm";
import { entitlementsFor } from "@/lib/billing/plans";
import {
  decideExternalAi,
  denialMessage,
  type AiAccessInputs,
  type AiDecision,
  type AiDenial,
  type AiPurpose,
} from "@/lib/ai/consent";
import { resolveHouseholdPlan } from "@/server/billing/entitlements";
import { systemDb, type Queryable } from "@/server/db/client";
import { preferences } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { externalConfigured, localProvider, unguardedExternalProvider } from "./providers";
import type { AIProvider } from "./types";

/** What a household has agreed to and whether it can be used right now. */
export interface AiAccess {
  configured: boolean;
  entitled: boolean;
  consent: { allowed: boolean; at: Date | null; by: string | null };
  decision: AiDecision;
}

/**
 * Work out, from the database, whether this household's data may go to the
 * outside AI service. Trusted (system) read: callers have already authorised
 * access to the household. Reads the plan and the stored answer fresh each
 * time, so withdrawing permission or downgrading takes effect on the next call.
 */
export async function resolveAiAccess(householdId: string, now = new Date(), db: Queryable = systemDb): Promise<AiAccess> {
  const [prefs] = await db
    .select({ allowed: preferences.allowAiProcessing, at: preferences.aiConsentAt, by: preferences.aiConsentBy })
    .from(preferences)
    .where(eq(preferences.householdId, householdId))
    .limit(1);
  const plan = await resolveHouseholdPlan(householdId, now, db);
  const inputs: AiAccessInputs = {
    configured: externalConfigured(),
    entitled: entitlementsFor(plan.plan).receipt_extraction === "advanced",
    // No preferences row means nobody has ever answered: that is a no.
    consent: { allowed: prefs?.allowed ?? false, at: prefs?.at ?? null },
  };
  return {
    configured: inputs.configured,
    entitled: inputs.entitled,
    consent: { allowed: inputs.consent.allowed, at: prefs?.at ?? null, by: prefs?.by ?? null },
    decision: decideExternalAi(inputs),
  };
}

export class AiPermissionError extends AppError {
  constructor(
    public readonly reason: AiDenial,
    purpose: AiPurpose,
  ) {
    // "forbidden" for a missing yes or plan; the message says what to do.
    super(reason === "not_configured" ? "ai_unavailable" : "forbidden", denialMessage(reason, purpose));
    this.name = "AiPermissionError";
  }
}

export interface ChosenProvider {
  provider: AIProvider;
  /** True when the provider is an outside service (data leaves Plenty's server). */
  external: boolean;
  access: AiAccess;
}

/**
 * The provider to read or generate with for this household. The outside
 * service only when permission, plan and set-up all allow it; otherwise
 * Plenty's own on-device reader, which sends nothing anywhere. Use this where
 * the on-device reader is an acceptable fallback (receipts).
 */
export async function providerFor(householdId: string, now = new Date()): Promise<ChosenProvider> {
  const access = await resolveAiAccess(householdId, now);
  if (access.decision.allowed) {
    const external = unguardedExternalProvider();
    if (external) return { provider: external, external: true, access };
  }
  return { provider: localProvider(), external: false, access };
}

/**
 * The outside provider, or a clear error. Use this where there is no local
 * equivalent (new recipe ideas, photo recognition): it never falls back to
 * sending, and never falls back silently to anything.
 */
export async function requireExternalProvider(householdId: string, purpose: AiPurpose, now = new Date()): Promise<ChosenProvider & { external: true }> {
  const access = await resolveAiAccess(householdId, now);
  if (!access.decision.allowed) throw new AiPermissionError(access.decision.reason, purpose);
  const provider = unguardedExternalProvider();
  if (!provider) throw new AiPermissionError("not_configured", purpose);
  return { provider, external: true, access };
}
