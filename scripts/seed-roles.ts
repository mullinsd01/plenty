/**
 * Accounts for every role and plan, to try the app as each of them.
 *
 *   npm run db:seed-roles
 *
 * Creates (password `plenty-tour` for all):
 *   family@plenty.test  owner of "Tour family" (Plenty Family)
 *   mate@plenty.test    a member of Tour family
 *   kid@plenty.test     a child account in Tour family
 *   free@plenty.test    owner of a household on the free plan
 *
 * Safe to run again: it replaces these accounts and their households.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const PASSWORD = "plenty-tour";
const TZ = "Australia/Sydney";
const EMAILS = ["family@plenty.test", "mate@plenty.test", "kid@plenty.test", "free@plenty.test"];

async function main() {
  const { eq, inArray } = await import("drizzle-orm");
  const { systemDb, pool } = await import("../src/server/db/client");
  const schema = await import("../src/server/db/schema");
  const { signUp } = await import("../src/server/auth/service");
  const { buildHouseholdContext } = await import("../src/server/auth/build-context");
  const { createHousehold, completeOnboarding, acceptInvitation, createInvitation } = await import("../src/server/services/household");
  const { syncCatalog } = await import("../src/server/services/products");
  const { syncRecipeLibrary } = await import("../src/server/services/meals");
  const { addItems } = await import("../src/server/services/inventory");
  const { addManualItem, addRequest } = await import("../src/server/services/shopping");
  const { addManagedMember, updateMember } = await import("../src/server/services/members");

  // Start clean.
  const old = await systemDb.select().from(schema.users).where(inArray(schema.users.email, EMAILS));
  for (const u of old) {
    const memberships = await systemDb.select().from(schema.householdMembers).where(eq(schema.householdMembers.userId, u.id));
    for (const m of memberships) await systemDb.delete(schema.households).where(eq(schema.households.id, m.householdId));
    await systemDb.delete(schema.users).where(eq(schema.users.id, u.id));
  }
  await syncCatalog();
  await syncRecipeLibrary();

  const account = async (name: string, email: string) => {
    const { userId } = await signUp({ name, email, password: PASSWORD });
    return { id: userId, email, displayName: name, isDemo: false, activeHouseholdId: null as string | null };
  };

  // ── Tour family: owner, member, child, on Plenty Family ──
  const owner = await account("Sam", "family@plenty.test");
  const { householdId } = await createHousehold(owner, { name: "Tour family", adults: 2, children: 1, timezone: TZ, currency: "AUD" });
  await systemDb.insert(schema.subscriptions).values({ householdId, plan: "family", period: "annual", status: "active", provider: "manual", autoRenew: false });
  let sam = (await buildHouseholdContext({ ...owner, activeHouseholdId: householdId }, householdId))!;
  await completeOnboarding(sam);

  const joinAs = async (name: string, email: string, role: "member" | "child") => {
    const user = await account(name, email);
    const { code } = await createInvitation(sam);
    await acceptInvitation(user, code);
    let ctx = (await buildHouseholdContext({ ...user, activeHouseholdId: householdId }, householdId))!;
    if (role !== "member") {
      await updateMember(sam, ctx.member.id, { role });
      ctx = (await buildHouseholdContext({ ...user, activeHouseholdId: householdId }, householdId))!;
    }
    await completeOnboarding(ctx).catch(() => undefined);
    return ctx;
  };
  const mate = await joinAs("Alex", "mate@plenty.test", "member");
  const kid = await joinAs("Ollie", "kid@plenty.test", "child");
  await addManagedMember(sam, { name: "Nan", role: "member" });

  await addItems(sam, [
    { name: "Full cream milk", quantity: 2, unit: "l" },
    { name: "Eggs", quantity: 12, unit: "each" },
    { name: "White bread" },
    { name: "Chicken breast", quantity: 1, unit: "kg" },
    { name: "Pepsi Max", quantity: 2.5, unit: "l", ownerMemberId: sam.member.id },
    { name: "Protein bars", quantity: 12, unit: "each", ownerMemberId: sam.member.id, visibility: "private" },
    { name: "Oat milk", quantity: 1, unit: "l", ownerMemberId: mate.member.id },
  ]);
  await addItems(kid, [{ name: "Apple", quantity: 4, unit: "each" }]);
  await addManualItem(sam, { name: "Birthday candles" });
  await addManualItem(mate, { name: "Oat milk", ownerMemberId: mate.member.id, note: "The barista one" });
  await addRequest(kid, { name: "Yoghurt pouches" });
  await addRequest(mate, { name: "Pepsi Max", note: "Black cans" });

  // ── A household on the free plan ──
  const freeUser = await account("Frankie", "free@plenty.test");
  const free = await createHousehold(freeUser, { name: "Freebie household", adults: 1, children: 0, timezone: TZ, currency: "AUD" });
  const freeCtx = (await buildHouseholdContext({ ...freeUser, activeHouseholdId: free.householdId }, free.householdId))!;
  await completeOnboarding(freeCtx);
  await addItems(freeCtx, [{ name: "Milk" }, { name: "Bread" }, { name: "Butter" }, { name: "Rice", quantity: 1, unit: "kg" }, { name: "Bananas", quantity: 6, unit: "each" }]);
  await addManualItem(freeCtx, { name: "Coffee" });

  console.log("✓ Accounts ready (password plenty-tour):", EMAILS.join(", "));
  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ Failed:", err);
    process.exit(1);
  });
