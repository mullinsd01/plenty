import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { PLANS, isPlanId, type PlanId } from "@/lib/billing/plans";
import { deleteAnalyticsFor } from "@/server/analytics";
import { prepareHouseholdDeletion } from "@/server/billing/service";
import { systemDb, withSystem, type Tx } from "@/server/db/client";
import {
  emailOutbox,
  householdInvitations,
  householdMembers,
  households,
  profiles,
  rateLimits,
  subscriptions,
  users,
} from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { deleteHouseholdFiles } from "@/server/storage/files";
import { detachMember } from "./members";

/**
 * Deleting an account, and what that means for each household the person is in.
 *
 *  - A household where they are the only person with an account is deleted with
 *    everything in it: its people without accounts, kitchen, lists, meals,
 *    receipts and their photos, what Plenty learned, notifications, usage,
 *    analytics and subscription records.
 *  - A household with other account holders carries on without them. Their own
 *    private items and personal patterns go with them; what they shared stays
 *    with the household. If they are its only owner it is NOT handed to anyone:
 *    the deletion is refused until another person has been made an owner, so a
 *    household is never left without one and nobody becomes an owner by surprise.
 *
 * Subscriptions: before a household is deleted, billing cancels a web (Stripe)
 * subscription so nobody keeps paying for a household that's gone, and stops the
 * deletion if it can't. An App Store or Google Play subscription can only be
 * cancelled in the store, so the person is told (before and after) to do that;
 * Plenty never claims to have cancelled one. Its own records go either way.
 */

export type HouseholdOutcome = "delete" | "leave" | "blocked";

/** A paid plan that something outside Plenty is billing for. */
export interface SubscriptionNotice {
  provider: "web" | "apple" | "google";
  plan: PlanId;
  planName: string;
  /** It will renew unless cancelled. */
  autoRenew: boolean;
  currentPeriodEnd: string | null;
  /** Plenty cancels it as part of deleting (a web subscription). Otherwise the person has to cancel it in the store. */
  cancelledOnDelete: boolean;
}

export interface HouseholdDeletionPlan {
  id: string;
  name: string;
  outcome: HouseholdOutcome;
  /** People in it who have no account (children, others): deleted with the household. */
  profilesWithoutAccount: number;
  /** Other people with an account here. */
  otherAccountHolders: number;
  /** Set when this household's subscription is billed outside Plenty and this deletion removes it. */
  subscription: SubscriptionNotice | null;
}

export interface AccountDeletionPlan {
  households: HouseholdDeletionPlan[];
  /** Households that stop the deletion until something is done about them. */
  blockedBy: HouseholdDeletionPlan[];
}

const BLOCKED_MESSAGE = (name: string) =>
  `You're the only owner of “${name}”, and other people use it. Make one of them an owner first (Settings → Household & sharing), or delete the household, then try again. Plenty won't hand a household to someone without you choosing.`;

function subscriptionNotice(row: typeof subscriptions.$inferSelect | undefined): SubscriptionNotice | null {
  if (!row || row.provider === "manual") return null;
  if (row.plan === "free" || !isPlanId(row.plan)) return null;
  // Anything that could still bill, or that the provider still shows as theirs.
  if (!["active", "trialing", "past_due", "paused"].includes(row.status)) return null;
  return {
    provider: row.provider,
    plan: row.plan,
    planName: PLANS[row.plan].name,
    autoRenew: row.autoRenew,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    cancelledOnDelete: row.provider === "web" && Boolean(row.providerSubscriptionId),
  };
}

/** What deleting this account would do, household by household. Read-only. */
export async function planAccountDeletion(userId: string, db: Tx | typeof systemDb = systemDb): Promise<AccountDeletionPlan> {
  const mine = await db
    .select({ householdId: householdMembers.householdId, role: householdMembers.role, name: households.name })
    .from(householdMembers)
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(eq(householdMembers.userId, userId));
  const plans: HouseholdDeletionPlan[] = [];
  for (const m of mine) {
    const people = await db.select({ userId: householdMembers.userId, role: householdMembers.role }).from(householdMembers).where(eq(householdMembers.householdId, m.householdId));
    const others = people.filter((p) => p.userId !== null && p.userId !== userId);
    const outcome: HouseholdOutcome = others.length === 0 ? "delete" : m.role === "owner" && !others.some((o) => o.role === "owner") ? "blocked" : "leave";
    const [sub] = outcome === "delete" ? await db.select().from(subscriptions).where(eq(subscriptions.householdId, m.householdId)).limit(1) : [];
    plans.push({
      id: m.householdId,
      name: m.name,
      outcome,
      profilesWithoutAccount: people.filter((p) => p.userId === null).length,
      otherAccountHolders: others.length,
      subscription: outcome === "delete" ? subscriptionNotice(sub) : null,
    });
  }
  return { households: plans, blockedBy: plans.filter((p) => p.outcome === "blocked") };
}

/** What a household deletion removes that lives outside the database: photos and analytics. Safe to repeat. */
export async function purgeHouseholdArtifacts(householdId: string): Promise<void> {
  await Promise.all([
    deleteHouseholdFiles(householdId).catch((err) => console.error("[deletion] photo files not removed:", err instanceof Error ? err.message : err)),
    deleteAnalyticsFor(householdId).catch((err) => console.error("[deletion] analytics not removed:", err instanceof Error ? err.message : err)),
  ]);
}

/**
 * Delete a user and what hangs off them, in one transaction: either all of it
 * or (when refused) none of it. Authorisation (the password) is checked by the caller.
 */
export async function deleteUserAndData(
  userId: string,
): Promise<{ deletedHouseholdIds: string[]; leftHouseholdIds: string[]; storeSubscriptions: Array<"apple" | "google"> }> {
  // Look first, so nothing outside the database is touched for a deletion that will be refused.
  const plan = await planAccountDeletion(userId);
  const blocked = plan.blockedBy[0];
  if (blocked) throw new AppError("conflict", BLOCKED_MESSAGE(blocked.name));
  // Stop a web subscription billing a household that's about to go (throws, and nothing is deleted, if it can't be stopped).
  const storeSubscriptions = new Set<"apple" | "google">();
  for (const h of plan.households.filter((x) => x.outcome === "delete")) {
    const billing = await prepareHouseholdDeletion(h.id);
    if (billing.storeManaged) storeSubscriptions.add(billing.storeManaged);
  }
  const result = await withSystem(async (tx) => {
    const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return { deletedHouseholdIds: [], leftHouseholdIds: [], email: null as string | null };
    const deletedHouseholdIds: string[] = [];
    const leftHouseholdIds: string[] = [];
    const memberships = await tx
      .select({ id: householdMembers.id, householdId: householdMembers.householdId, role: householdMembers.role })
      .from(householdMembers)
      .where(eq(householdMembers.userId, userId))
      .orderBy(householdMembers.householdId);
    for (const m of memberships) {
      // Lock the household so a housemate leaving or being promoted at the same moment can't strand it.
      const [household] = await tx.select({ id: households.id, name: households.name }).from(households).where(eq(households.id, m.householdId)).for("update");
      if (!household) continue;
      const people = await tx.select({ userId: householdMembers.userId, role: householdMembers.role }).from(householdMembers).where(eq(householdMembers.householdId, m.householdId));
      const others = people.filter((p) => p.userId !== null && p.userId !== userId);
      if (others.length === 0) {
        await tx.delete(households).where(eq(households.id, m.householdId));
        deletedHouseholdIds.push(m.householdId);
        continue;
      }
      if (m.role === "owner" && !others.some((o) => o.role === "owner")) {
        throw new AppError("conflict", BLOCKED_MESSAGE(household.name));
      }
      await detachMember(tx, m.householdId, m.id, userId);
      // Invitations they sent (and any codes still open) go with them; so does anything addressed to their email.
      await tx.delete(householdInvitations).where(and(eq(householdInvitations.householdId, m.householdId), eq(householdInvitations.createdBy, userId)));
      await tx.delete(householdMembers).where(eq(householdMembers.id, m.id));
      leftHouseholdIds.push(m.householdId);
    }
    await tx.delete(householdInvitations).where(sql`lower(${householdInvitations.email}) = ${user.email.toLowerCase()}`);
    // Their outgoing mail (password resets, invites, digests) and short-lived rate-limit counters keyed by them.
    await tx.delete(emailOutbox).where(sql`lower(${emailOutbox.to}) = ${user.email.toLowerCase()}`);
    const endsWith = (value: string) => sql`${rateLimits.key} like ${`%:${value.replace(/[\\%_]/g, "\\$&")}`}`;
    await tx.delete(rateLimits).where(sql`${endsWith(userId)} or ${endsWith(user.email.toLowerCase())}`);
    for (const id of deletedHouseholdIds) await tx.delete(rateLimits).where(endsWith(id));
    // Sessions, profile, notification rows and memberships go with the account (cascade); what they created elsewhere keeps no link to them.
    await tx.update(profiles).set({ activeHouseholdId: null }).where(eq(profiles.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
    return { deletedHouseholdIds, leftHouseholdIds, email: user.email };
  });
  // Outside the database: photos and analytics for the households that went.
  await Promise.all(result.deletedHouseholdIds.map(purgeHouseholdArtifacts));
  return { deletedHouseholdIds: result.deletedHouseholdIds, leftHouseholdIds: result.leftHouseholdIds, storeSubscriptions: [...storeSubscriptions] };
}

/** The paid plan, billed outside Plenty, that deleting this household removes the record of (null when there isn't one). */
export async function householdSubscriptionNotice(householdId: string): Promise<SubscriptionNotice | null> {
  const [row] = await systemDb.select().from(subscriptions).where(eq(subscriptions.householdId, householdId)).limit(1);
  return subscriptionNotice(row);
}
