import "server-only";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { withSystem, withUser, type Tx } from "@/server/db/client";
import {
  consumptionStats,
  householdInvitations,
  householdMembers,
  households,
  notifications,
  notificationSettings,
  preferences,
  profiles,
  shoppingLists,
  users,
} from "@/server/db/schema";
import type { AuthUser, HouseholdContext } from "@/server/auth/context";
import { generateCode } from "@/server/auth/crypto";
import { AppError } from "@/server/errors";
import { refreshLearning } from "@/server/services/learning";
import type { NotificationSettingsInput, PreferencesInput } from "@/validation/household";

const INVITE_DAYS = 14;
/** Invite codes are the only thing needed to join, so keep them long enough not to be guessable (~60 bits). */
const INVITE_CODE_LENGTH = 12;

/** Best guess at currency from the browser's timezone (editable later). */
export function currencyForTimezone(tz: string | undefined): string {
  if (!tz) return "AUD";
  if (tz.startsWith("Australia/")) return "AUD";
  if (tz === "Pacific/Auckland" || tz === "Pacific/Chatham") return "NZD";
  if (tz === "Europe/London" || tz === "Europe/Belfast") return "GBP";
  if (tz.startsWith("America/Toronto") || tz.startsWith("America/Vancouver") || tz.startsWith("America/Edmonton")) return "CAD";
  if (tz.startsWith("America/")) return "USD";
  if (tz.startsWith("Europe/")) return "EUR";
  return "AUD";
}

export async function createHousehold(
  user: AuthUser,
  input: { name: string; adults: number; children: number; timezone?: string; currency?: string },
): Promise<{ householdId: string }> {
  return withUser(user.id, async (tx) => {
    const [household] = await tx
      .insert(households)
      .values({
        name: input.name,
        adults: input.adults,
        children: input.children,
        timezone: input.timezone ?? "Australia/Sydney",
        currency: input.currency ?? currencyForTimezone(input.timezone),
        createdBy: user.id,
        // Everything after naming the household is optional, so leaving setup
        // part-way never traps anyone in onboarding.
        onboardedAt: new Date(),
      })
      .returning({ id: households.id });
    await tx.insert(householdMembers).values({ householdId: household.id, userId: user.id, role: "owner" });
    await tx.insert(preferences).values({ householdId: household.id });
    await tx.insert(notificationSettings).values({ userId: user.id, householdId: household.id });
    await tx.insert(shoppingLists).values({ householdId: household.id });
    await tx
      .insert(profiles)
      .values({ userId: user.id, displayName: user.displayName, activeHouseholdId: household.id })
      .onConflictDoUpdate({ target: profiles.userId, set: { activeHouseholdId: household.id } });
    return { householdId: household.id };
  });
}

export async function updateHouseholdBasics(
  ctx: HouseholdContext,
  input: { name: string; adults: number; children: number; timezone?: string; currency?: string },
): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    const [updated] = await tx
      .update(households)
      .set({
        name: input.name,
        adults: input.adults,
        children: input.children,
        ...(input.timezone ? { timezone: input.timezone } : {}),
        ...(input.currency ? { currency: input.currency } : {}),
      })
      .where(eq(households.id, ctx.household.id))
      .returning({ id: households.id, adults: households.adults, children: households.children, timezone: households.timezone });
    // Starting estimates scale with household size, so re-learn when it changes.
    if (updated && (input.adults !== ctx.household.adults || input.children !== ctx.household.children)) {
      const learned = await tx
        .select({ productId: consumptionStats.productId })
        .from(consumptionStats)
        .where(eq(consumptionStats.householdId, ctx.household.id));
      await refreshLearning(tx, updated, learned.map((r) => r.productId), new Date());
    }
  });
}

export async function completeOnboarding(ctx: HouseholdContext): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    await tx
      .update(households)
      .set({ onboardedAt: sql`coalesce(${households.onboardedAt}, now())` })
      .where(eq(households.id, ctx.household.id));
  });
}

export type HouseholdPreferences = typeof preferences.$inferSelect;

export async function getPreferences(ctx: HouseholdContext): Promise<HouseholdPreferences> {
  return withUser(ctx.user.id, async (tx) => {
    const [row] = await tx.select().from(preferences).where(eq(preferences.householdId, ctx.household.id)).limit(1);
    if (row) return row;
    const [created] = await tx.insert(preferences).values({ householdId: ctx.household.id }).returning();
    return created;
  });
}

export async function updatePreferences(ctx: HouseholdContext, input: PreferencesInput): Promise<void> {
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  if (Object.keys(patch).length === 0) return;
  await withUser(ctx.user.id, async (tx) => {
    await tx
      .insert(preferences)
      .values({ householdId: ctx.household.id, ...patch })
      .onConflictDoUpdate({ target: preferences.householdId, set: patch });
  });
}

export async function getNotificationSettings(ctx: HouseholdContext) {
  return withUser(ctx.user.id, async (tx) => {
    const [row] = await tx
      .select()
      .from(notificationSettings)
      .where(and(eq(notificationSettings.userId, ctx.user.id), eq(notificationSettings.householdId, ctx.household.id)))
      .limit(1);
    if (row) return row;
    const [created] = await tx
      .insert(notificationSettings)
      .values({ userId: ctx.user.id, householdId: ctx.household.id })
      .returning();
    return created;
  });
}

export async function updateNotificationSettings(ctx: HouseholdContext, input: NotificationSettingsInput): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    await tx
      .insert(notificationSettings)
      .values({ userId: ctx.user.id, householdId: ctx.household.id, ...input })
      .onConflictDoUpdate({ target: [notificationSettings.userId, notificationSettings.householdId], set: input });
  });
}

export async function updateDisplayName(user: AuthUser, displayName: string): Promise<void> {
  await withUser(user.id, async (tx) => {
    await tx
      .insert(profiles)
      .values({ userId: user.id, displayName })
      .onConflictDoUpdate({ target: profiles.userId, set: { displayName } });
  });
}

// ─── Members & sharing ──────────────────────────────────────────────────────

export interface HouseholdMemberView {
  userId: string;
  displayName: string;
  email: string;
  role: "owner" | "member";
  joinedAt: Date;
  isYou: boolean;
}

export async function listMembers(ctx: HouseholdContext): Promise<HouseholdMemberView[]> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        userId: householdMembers.userId,
        role: householdMembers.role,
        joinedAt: householdMembers.joinedAt,
        displayName: profiles.displayName,
        email: users.email,
      })
      .from(householdMembers)
      .innerJoin(users, eq(users.id, householdMembers.userId))
      .leftJoin(profiles, eq(profiles.userId, householdMembers.userId))
      .where(eq(householdMembers.householdId, ctx.household.id))
      .orderBy(asc(householdMembers.joinedAt));
    return rows.map((r) => ({
      userId: r.userId,
      role: r.role,
      joinedAt: r.joinedAt,
      displayName: r.displayName ?? r.email.split("@")[0],
      email: r.email,
      isYou: r.userId === ctx.user.id,
    }));
  });
}

export async function getActiveInvitation(ctx: HouseholdContext) {
  return withUser(ctx.user.id, async (tx) => {
    const [row] = await tx
      .select()
      .from(householdInvitations)
      .where(
        and(
          eq(householdInvitations.householdId, ctx.household.id),
          isNull(householdInvitations.acceptedAt),
          isNull(householdInvitations.revokedAt),
          gt(householdInvitations.expiresAt, new Date()),
          isNull(householdInvitations.email),
        ),
      )
      .orderBy(sql`${householdInvitations.createdAt} desc`)
      .limit(1);
    return row ?? null;
  });
}

/** Create (or reuse) a shareable invite link for the household. */
export async function createInvitation(ctx: HouseholdContext): Promise<{ code: string; expiresAt: Date }> {
  if (ctx.household.isDemo) throw new AppError("forbidden", "The demo household can't invite people.");
  const existing = await getActiveInvitation(ctx);
  if (existing) return { code: existing.code, expiresAt: existing.expiresAt };
  return withUser(ctx.user.id, async (tx) => {
    const code = generateCode(INVITE_CODE_LENGTH);
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    await tx.insert(householdInvitations).values({ householdId: ctx.household.id, code, createdBy: ctx.user.id, expiresAt });
    return { code, expiresAt };
  });
}

export async function revokeInvitations(ctx: HouseholdContext): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    await tx
      .update(householdInvitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(householdInvitations.householdId, ctx.household.id), isNull(householdInvitations.acceptedAt)));
  });
}

/** Public lookup for the /join page (system context — the visitor isn't a member yet). */
export async function getInvitationPreview(code: string): Promise<{ householdName: string; invitedBy: string | null } | null> {
  const clean = code.trim().toUpperCase().slice(0, 24);
  return withSystem(async (tx) => {
    const [row] = await tx
      .select({ householdName: households.name, invitedBy: profiles.displayName })
      .from(householdInvitations)
      .innerJoin(households, eq(households.id, householdInvitations.householdId))
      .leftJoin(profiles, eq(profiles.userId, householdInvitations.createdBy))
      .where(
        and(
          eq(householdInvitations.code, clean),
          isNull(householdInvitations.revokedAt),
          isNull(householdInvitations.acceptedAt),
          gt(householdInvitations.expiresAt, new Date()),
          isNull(households.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Accept an invitation. Runs in system context because the user isn't a
 * member yet; every check is explicit here.
 */
export async function acceptInvitation(user: AuthUser, code: string): Promise<{ householdId: string }> {
  const clean = code.trim().toUpperCase().slice(0, 24);
  return withSystem(async (tx) => {
    const [invite] = await tx
      .select()
      .from(householdInvitations)
      .where(
        and(
          eq(householdInvitations.code, clean),
          isNull(householdInvitations.revokedAt),
          isNull(householdInvitations.acceptedAt),
          gt(householdInvitations.expiresAt, new Date()),
        ),
      )
      .for("update")
      .limit(1);
    if (!invite) throw new AppError("not_found", "This invite has expired or was already used. Ask for a new link.");
    const [household] = await tx
      .select({ id: households.id, isDemo: households.isDemo })
      .from(households)
      .where(and(eq(households.id, invite.householdId), isNull(households.deletedAt)))
      .limit(1);
    if (!household) throw new AppError("not_found", "That household no longer exists.");

    await tx
      .insert(householdMembers)
      .values({ householdId: household.id, userId: user.id, role: invite.role })
      .onConflictDoNothing();
    await tx.insert(notificationSettings).values({ userId: user.id, householdId: household.id }).onConflictDoNothing();
    await tx
      .insert(profiles)
      .values({ userId: user.id, displayName: user.displayName, activeHouseholdId: household.id })
      .onConflictDoUpdate({ target: profiles.userId, set: { activeHouseholdId: household.id } });
    // Shareable links stay valid for other household members; email-specific invites are single-use.
    if (invite.email) {
      await tx
        .update(householdInvitations)
        .set({ acceptedAt: new Date(), acceptedBy: user.id })
        .where(eq(householdInvitations.id, invite.id));
    }
    return { householdId: household.id };
  });
}

export async function removeMember(ctx: HouseholdContext, memberUserId: string): Promise<void> {
  if (memberUserId === ctx.user.id) return leaveHousehold(ctx);
  if (ctx.role !== "owner") throw new AppError("forbidden", "Only the household owner can remove people.");
  await withSystem(async (tx) => {
    const [removed] = await tx
      .delete(householdMembers)
      .where(and(eq(householdMembers.householdId, ctx.household.id), eq(householdMembers.userId, memberUserId)))
      .returning({ id: householdMembers.id });
    if (!removed) return;
    // Anyone who's been removed must not be able to walk back in with the old link.
    await tx
      .update(householdInvitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(householdInvitations.householdId, ctx.household.id),
          isNull(householdInvitations.acceptedAt),
          isNull(householdInvitations.revokedAt),
        ),
      );
    await forgetMemberData(tx, ctx.household.id, memberUserId);
  });
}

/** Personal per-household rows that shouldn't outlive a membership. */
async function forgetMemberData(tx: Tx, householdId: string, userId: string): Promise<void> {
  await tx.delete(notifications).where(and(eq(notifications.householdId, householdId), eq(notifications.userId, userId)));
  await tx
    .delete(notificationSettings)
    .where(and(eq(notificationSettings.householdId, householdId), eq(notificationSettings.userId, userId)));
  await tx
    .update(profiles)
    .set({ activeHouseholdId: null })
    .where(and(eq(profiles.userId, userId), eq(profiles.activeHouseholdId, householdId)));
}

export async function leaveHousehold(ctx: HouseholdContext): Promise<void> {
  await withSystem(async (tx) => {
    // Serialise membership changes so two people leaving at once can't strand the household.
    await tx.select({ id: households.id }).from(households).where(eq(households.id, ctx.household.id)).for("update");
    const members = await tx
      .select()
      .from(householdMembers)
      .where(eq(householdMembers.householdId, ctx.household.id))
      .orderBy(asc(householdMembers.joinedAt));
    const others = members.filter((m) => m.userId !== ctx.user.id);
    if (others.length === 0) {
      throw new AppError("conflict", "You're the only member. Delete the household instead if you want to remove it.");
    }
    if (ctx.role === "owner" && !others.some((m) => m.role === "owner")) {
      await tx.update(householdMembers).set({ role: "owner" }).where(eq(householdMembers.id, others[0].id));
    }
    await tx
      .delete(householdMembers)
      .where(and(eq(householdMembers.householdId, ctx.household.id), eq(householdMembers.userId, ctx.user.id)));
    await forgetMemberData(tx, ctx.household.id, ctx.user.id);
  });
}

/** Permanently delete the household and everything in it (owner only). */
export async function deleteHousehold(ctx: HouseholdContext): Promise<void> {
  if (ctx.role !== "owner") throw new AppError("forbidden", "Only the household owner can delete it.");
  await withUser(ctx.user.id, async (tx) => {
    await tx.delete(households).where(eq(households.id, ctx.household.id));
  });
}

export async function switchHousehold(user: AuthUser, householdId: string): Promise<void> {
  await withUser(user.id, async (tx) => {
    await tx.update(profiles).set({ activeHouseholdId: householdId }).where(eq(profiles.userId, user.id));
  });
}
