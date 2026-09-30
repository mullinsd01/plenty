/**
 * Helpers for integration tests: create users + households through the real
 * services and build a HouseholdContext without going through Next.js.
 */
import { eq } from "drizzle-orm";
import { signUp } from "@/server/auth/service";
import type { HouseholdContext } from "@/server/auth/context";
import { systemDb } from "@/server/db/client";
import { households } from "@/server/db/schema";
import { completeOnboarding, createHousehold } from "@/server/services/household";
import { syncCatalog } from "@/server/services/products";
import { syncRecipeLibrary } from "@/server/services/meals";

let catalogReady: Promise<void> | null = null;
export function ensureCatalog(): Promise<void> {
  catalogReady ??= (async () => {
    await syncCatalog();
    await syncRecipeLibrary();
  })();
  return catalogReady;
}

let seq = 0;
export async function makeHousehold(opts: { name?: string; adults?: number; children?: number } = {}): Promise<HouseholdContext> {
  await ensureCatalog();
  seq += 1;
  const email = `user${Date.now()}-${seq}@test.plenty`;
  const { userId } = await signUp({ name: `Tester ${seq}`, email, password: "correct-horse-battery" });
  const user = { id: userId, email, displayName: `Tester ${seq}`, isDemo: false, activeHouseholdId: null };
  const { householdId } = await createHousehold(user, {
    name: opts.name ?? `Household ${seq}`,
    adults: opts.adults ?? 2,
    children: opts.children ?? 0,
    timezone: "Australia/Sydney",
    currency: "AUD",
  });
  const [h] = await systemDb.select().from(households).where(eq(households.id, householdId));
  const ctx: HouseholdContext = {
    user: { ...user, activeHouseholdId: householdId },
    household: {
      id: h.id,
      name: h.name,
      adults: h.adults,
      children: h.children,
      currency: h.currency,
      timezone: h.timezone,
      onboardedAt: null,
      isDemo: false,
    },
    role: "owner",
  };
  await completeOnboarding(ctx);
  return ctx;
}
