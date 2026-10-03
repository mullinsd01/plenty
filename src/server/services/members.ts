import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { can, type Role } from "@/lib/members/permissions";
import type { HouseholdContext } from "@/server/auth/context";
import { assertRoomForMember } from "@/server/billing/limits";
import { withSystem, withUser, type Queryable, type Tx } from "@/server/db/client";
import {
  consumptionEvents,
  consumptionStats,
  householdInvitations,
  householdMembers,
  inventoryItems,
  memberFoodRules,
  notificationSettings,
  notifications,
  predictions,
  profiles,
  recurringItems,
  shoppingListItems,
  users,
} from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { requireCapability } from "@/server/permissions";
import type { MemberOption } from "@/lib/members/types";

/** Soft, distinguishable colours for person chips. Chosen, not random, so they stay stable. */
export const MEMBER_COLORS = ["#E0654B", "#3B6FA5", "#4F8A5B", "#B07A2A", "#7A5AA6", "#2F8F8B", "#B5527A", "#6B7280"] as const;

export interface MemberView {
  id: string;
  /** Null for a profile that has no account. */
  userId: string | null;
  name: string;
  role: Role;
  color: string;
  hasAccount: boolean;
  isYou: boolean;
  /** Only shown to owners. */
  email: string | null;
  joinedAt: Date;
}

function colorFor(index: number): string {
  return MEMBER_COLORS[index % MEMBER_COLORS.length];
}

/** Everyone in the household. Names are shown to all members; email addresses only to owners. */
export async function listMembers(ctx: HouseholdContext): Promise<MemberView[]> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        id: householdMembers.id,
        userId: householdMembers.userId,
        role: householdMembers.role,
        color: householdMembers.color,
        displayName: householdMembers.displayName,
        joinedAt: householdMembers.joinedAt,
        profileName: profiles.displayName,
        email: users.email,
      })
      .from(householdMembers)
      .leftJoin(profiles, eq(profiles.userId, householdMembers.userId))
      .leftJoin(users, eq(users.id, householdMembers.userId))
      .where(eq(householdMembers.householdId, ctx.household.id))
      .orderBy(asc(householdMembers.joinedAt));
    const isOwner = can(ctx.role, "manage_members");
    return rows.map((r, i) => ({
      id: r.id,
      userId: r.userId,
      name: r.displayName ?? r.profileName ?? r.email?.split("@")[0] ?? "Someone",
      role: r.role,
      color: r.color ?? colorFor(i),
      hasAccount: r.userId !== null,
      isYou: r.userId === ctx.user.id,
      email: isOwner ? r.email : null,
      joinedAt: r.joinedAt,
    }));
  });
}

/** Everyone in the household in the shape the pickers and chips need. */
export async function listMemberOptions(ctx: HouseholdContext): Promise<MemberOption[]> {
  return (await listMembers(ctx)).map((m) => ({ id: m.id, name: m.name, color: m.color, role: m.role, isYou: m.isYou }));
}

/** Member id → name, for labelling items. Safe for everyone in the household. */
export async function memberNames(db: Queryable, householdId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      id: householdMembers.id,
      displayName: householdMembers.displayName,
      profileName: profiles.displayName,
    })
    .from(householdMembers)
    .leftJoin(profiles, eq(profiles.userId, householdMembers.userId))
    .where(eq(householdMembers.householdId, householdId));
  return new Map(rows.map((r) => [r.id, r.displayName ?? r.profileName ?? "Someone"]));
}

// ─── Adding and changing people ─────────────────────────────────────────────

const NAME_MAX = 40;

function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new AppError("validation", "What's their name?", { name: "What's their name?" });
  if (trimmed.length > NAME_MAX) throw new AppError("validation", `Keep names under ${NAME_MAX} characters.`, { name: "That's too long." });
  return trimmed;
}

/**
 * Add someone who doesn't have an account — a child, or a person who doesn't
 * use the app — so food can still be assigned to them and they can have
 * requests made for them. Owners only; counts towards the plan's member limit.
 */
export async function addManagedMember(
  ctx: HouseholdContext,
  input: { name: string; role?: Extract<Role, "member" | "child">; color?: string },
): Promise<{ id: string }> {
  requireCapability(ctx, "manage_members");
  const name = cleanName(input.name);
  await assertRoomForMember(ctx);
  return withUser(ctx.user.id, async (tx) => {
    const existing = await tx.select({ n: sql<number>`count(*)::int` }).from(householdMembers).where(eq(householdMembers.householdId, ctx.household.id));
    const [row] = await tx
      .insert(householdMembers)
      .values({
        householdId: ctx.household.id,
        userId: null,
        displayName: name,
        role: input.role ?? "child",
        color: input.color ?? colorFor(existing[0]?.n ?? 0),
        createdBy: ctx.user.id,
      })
      .returning({ id: householdMembers.id });
    return row;
  });
}

/** Rename, recolour or change the role of a member. Owners may change anyone; anyone may rename or recolour themselves. */
export async function updateMember(
  ctx: HouseholdContext,
  memberId: string,
  patch: { name?: string; color?: string; role?: Role },
): Promise<void> {
  await withSystem(async (tx) => {
    // Lock the household's membership so role changes can't race (e.g. two owners demoting each other).
    const members = await tx.select().from(householdMembers).where(eq(householdMembers.householdId, ctx.household.id)).for("update");
    const target = members.find((m) => m.id === memberId);
    if (!target) throw notFound("That person");
    const isSelf = target.userId === ctx.user.id;
    const isOwner = can(ctx.role, "manage_members");
    if (!isOwner && !isSelf) throw new AppError("forbidden", "Only a household owner can change someone else.");

    const set: Partial<typeof householdMembers.$inferInsert> = {};
    if (patch.name !== undefined) {
      const name = cleanName(patch.name);
      // Account holders keep their profile name unless they choose a household-specific one.
      set.displayName = name;
    }
    if (patch.color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(patch.color)) throw new AppError("validation", "That colour isn't valid.");
      set.color = patch.color;
    }
    if (patch.role !== undefined && patch.role !== target.role) {
      if (!isOwner) throw new AppError("forbidden", "Only a household owner can change roles.");
      const owners = members.filter((m) => m.role === "owner");
      if (target.role === "owner" && owners.length <= 1) {
        throw new AppError("conflict", "A household needs at least one owner. Make someone else an owner first.");
      }
      set.role = patch.role;
    }
    if (Object.keys(set).length === 0) return;
    await tx.update(householdMembers).set(set).where(eq(householdMembers.id, memberId));
  });
}

/**
 * Remove someone from the household. Their private items go with them;
 * items they shared become the household's, with the history that has been
 * learned from them. Owners only (people leave on their own via `leaveHousehold`).
 */
export async function removeMember(ctx: HouseholdContext, memberId: string): Promise<void> {
  requireCapability(ctx, "manage_members");
  await withSystem(async (tx) => {
    await tx.select({ id: householdMembers.id }).from(householdMembers).where(eq(householdMembers.householdId, ctx.household.id)).for("update");
    const [target] = await tx
      .select()
      .from(householdMembers)
      .where(and(eq(householdMembers.id, memberId), eq(householdMembers.householdId, ctx.household.id)))
      .limit(1);
    if (!target) throw notFound("That person");
    if (target.userId === ctx.user.id) throw new AppError("conflict", "To leave the household yourself, use Leave household.");
    if (target.role === "owner") {
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(householdMembers)
        .where(and(eq(householdMembers.householdId, ctx.household.id), sql`${householdMembers.role}::text = 'owner'`));
      if (n <= 1) throw new AppError("conflict", "A household needs at least one owner.");
    }
    await detachMember(tx, ctx.household.id, target.id, target.userId);
    await tx.delete(householdMembers).where(eq(householdMembers.id, target.id));
    if (target.userId) {
      // Anyone removed must not walk back in with an old link.
      await tx
        .update(householdInvitations)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(householdInvitations.householdId, ctx.household.id), isNull(householdInvitations.acceptedAt), isNull(householdInvitations.revokedAt)),
        );
    }
  });
}

/**
 * Hand a departing member's belongings back: private items are removed with
 * them; shared items (and what's been learned from them) become the
 * household's; their personal notification rows are cleared.
 */
export async function detachMember(tx: Tx, householdId: string, memberId: string, userId: string | null): Promise<void> {
  const now = new Date();
  // Gone for good, not soft-deleted: a private item with no owner would break the privacy rule, and they asked for nobody else to see it.
  await tx
    .delete(inventoryItems)
    .where(and(eq(inventoryItems.householdId, householdId), eq(inventoryItems.ownerMemberId, memberId), eq(inventoryItems.visibility, "private")));
  await tx.delete(shoppingListItems).where(and(eq(shoppingListItems.householdId, householdId), eq(shoppingListItems.ownerMemberId, memberId), eq(shoppingListItems.visibility, "private")));
  await tx.delete(recurringItems).where(and(eq(recurringItems.householdId, householdId), eq(recurringItems.ownerMemberId, memberId)));
  // What was learned from their shared items stays with the household.
  await tx
    .update(consumptionEvents)
    .set({ scope: "household", ownerMemberId: null })
    .where(and(eq(consumptionEvents.householdId, householdId), eq(consumptionEvents.ownerMemberId, memberId), sql`${consumptionEvents.scope} like 'member:%'`));
  // Everything still tied to them (private history, their own patterns) is removed by the foreign keys on delete,
  // but remove it explicitly so nothing depends on cascade order.
  await tx.delete(consumptionEvents).where(and(eq(consumptionEvents.householdId, householdId), eq(consumptionEvents.ownerMemberId, memberId)));
  await tx.delete(consumptionStats).where(and(eq(consumptionStats.householdId, householdId), eq(consumptionStats.ownerMemberId, memberId)));
  await tx.delete(predictions).where(and(eq(predictions.householdId, householdId), eq(predictions.ownerMemberId, memberId)));
  await tx.delete(memberFoodRules).where(eq(memberFoodRules.memberId, memberId));
  if (userId) {
    await tx.delete(notifications).where(and(eq(notifications.householdId, householdId), eq(notifications.userId, userId)));
    await tx.delete(notificationSettings).where(and(eq(notificationSettings.householdId, householdId), eq(notificationSettings.userId, userId)));
    await tx
      .update(profiles)
      .set({ activeHouseholdId: null })
      .where(and(eq(profiles.userId, userId), eq(profiles.activeHouseholdId, householdId)));
  }
}

// ─── Each person's own food rules ───────────────────────────────────────────

export interface FoodRules {
  diets: string[];
  allergies: string[];
  dislikedIngredients: string[];
}

const NO_RULES: FoodRules = { diets: [], allergies: [], dislikedIngredients: [] };

/**
 * One person's own diets, allergies and dislikes. Readable only by that person
 * (or an owner, for a profile with no account or a child) — enforced by the database.
 */
export async function getMemberFoodRules(ctx: HouseholdContext, memberId: string): Promise<FoodRules> {
  return withUser(ctx.user.id, async (tx) => {
    const [row] = await tx.select().from(memberFoodRules).where(eq(memberFoodRules.memberId, memberId)).limit(1);
    return row ? { diets: row.diets, allergies: row.allergies, dislikedIngredients: row.dislikedIngredients } : NO_RULES;
  });
}

export async function setMemberFoodRules(ctx: HouseholdContext, memberId: string, rules: FoodRules): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    const [member] = await tx
      .select({ id: householdMembers.id })
      .from(householdMembers)
      .where(and(eq(householdMembers.id, memberId), eq(householdMembers.householdId, ctx.household.id)))
      .limit(1);
    if (!member) throw notFound("That person");
    const values = { diets: rules.diets, allergies: rules.allergies, dislikedIngredients: rules.dislikedIngredients };
    const written = await tx
      .insert(memberFoodRules)
      .values({ memberId, householdId: ctx.household.id, ...values })
      .onConflictDoUpdate({ target: memberFoodRules.memberId, set: values })
      .returning({ id: memberFoodRules.memberId });
    if (written.length === 0) throw new AppError("forbidden", "You can only change your own food rules, or those of someone you look after.");
  });
}

/**
 * Everyone's food rules combined, without saying whose. Meal suggestions use
 * this so nobody has to share their allergies to be kept safe.
 */
export async function combinedFoodRules(db: Queryable, householdId: string): Promise<FoodRules> {
  const result = await db.execute<{ diets: string[]; allergies: string[]; disliked: string[] }>(
    sql`select * from app.household_food_rules(${householdId}::uuid)`,
  );
  const row = result.rows[0];
  return row ? { diets: row.diets ?? [], allergies: row.allergies ?? [], dislikedIngredients: row.disliked ?? [] } : NO_RULES;
}

/** Whether a user has someone with this member id in their household (used to validate owner picks). */
export async function memberBelongsToHousehold(db: Queryable, householdId: string, memberId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: householdMembers.id })
    .from(householdMembers)
    .where(and(eq(householdMembers.householdId, householdId), inArray(householdMembers.id, [memberId])))
    .limit(1);
  return Boolean(row);
}
