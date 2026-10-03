/**
 * Helpers for integration tests: create users + households through the real
 * services and build a HouseholdContext without going through Next.js.
 */
import { eq } from "drizzle-orm";
import { signUp } from "@/server/auth/service";
import { buildHouseholdContext } from "@/server/auth/build-context";
import type { HouseholdContext } from "@/server/auth/build-context";
import { systemDb } from "@/server/db/client";
import { subscriptions } from "@/server/db/schema";
import type { PlanId } from "@/lib/billing/plans";
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

/**
 * Put a household on a plan with a manual subscription, the way support would.
 * `free` removes it. Returns a context rebuilt for the new plan.
 */
export async function setHouseholdPlan(ctx: HouseholdContext, plan: PlanId): Promise<HouseholdContext> {
  await systemDb.delete(subscriptions).where(eq(subscriptions.householdId, ctx.household.id));
  if (plan !== "free") {
    await systemDb.insert(subscriptions).values({ householdId: ctx.household.id, plan, period: "annual", status: "active", provider: "manual", autoRenew: false });
  }
  return (await buildHouseholdContext(ctx.user, ctx.household.id))!;
}

let seq = 0;
/**
 * A household with its owner. Tests of what Plenty learns and suggests default to the
 * Family plan so every feature is on; pass `plan: "free"` to test the free plan.
 */
export async function makeHousehold(
  opts: { name?: string; adults?: number; children?: number; plan?: PlanId } = {},
): Promise<HouseholdContext> {
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
  let ctx = (await buildHouseholdContext({ ...user, activeHouseholdId: householdId }, householdId))!;
  await completeOnboarding(ctx);
  ctx = await setHouseholdPlan(ctx, opts.plan ?? "family");
  return ctx;
}
