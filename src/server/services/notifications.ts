import "server-only";
import { and, count, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { NotificationType } from "@/lib/domain";
import type { HouseholdContext, HouseholdInfo } from "@/server/auth/context";
import { withUser, type Queryable, type Tx } from "@/server/db/client";
import { householdMembers, notificationSettings, notifications } from "@/server/db/schema";

/** Which setting switches each kind of notification on or off. */
const SETTING_FOR_TYPE: Partial<Record<NotificationType, "runningLow" | "useSoon" | "mealPlanReady" | "shoppingReminder" | "checkIns" | "insights">> = {
  running_low: "runningLow",
  use_soon: "useSoon",
  meal_plan_ready: "mealPlanReady",
  shopping_reminder: "shoppingReminder",
  check_in: "checkIns",
  insight: "insights",
};

/**
 * Kinds of notification the signed-in member has switched off. Some are
 * created by a housemate's action (e.g. "meal plan ready"), whose session
 * can't see this member's settings, so they're filtered when read instead.
 */
async function mutedTypes(tx: Tx, ctx: HouseholdContext): Promise<NotificationType[]> {
  const [s] = await tx
    .select()
    .from(notificationSettings)
    .where(and(eq(notificationSettings.userId, ctx.user.id), eq(notificationSettings.householdId, ctx.household.id)))
    .limit(1);
  if (!s) return [];
  return (Object.entries(SETTING_FOR_TYPE) as Array<[NotificationType, keyof typeof s]>).filter(([, key]) => s[key] === false).map(([type]) => type);
}

function notMuted(muted: NotificationType[]) {
  return muted.length > 0 ? notInArray(notifications.type, muted) : undefined;
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export async function countUnreadNotifications(ctx: HouseholdContext): Promise<number> {
  return withUser(ctx.user.id, async (tx) => {
    const muted = await mutedTypes(tx, ctx);
    const [row] = await tx
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.householdId, ctx.household.id),
          eq(notifications.userId, ctx.user.id),
          isNull(notifications.readAt),
          isNull(notifications.dismissedAt),
          notMuted(muted),
        ),
      );
    return Number(row?.n ?? 0);
  });
}

export async function listNotifications(ctx: HouseholdContext, limit = 50): Promise<NotificationView[]> {
  return withUser(ctx.user.id, async (tx) => {
    const muted = await mutedTypes(tx, ctx);
    const rows = await tx
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.householdId, ctx.household.id),
          eq(notifications.userId, ctx.user.id),
          isNull(notifications.dismissedAt),
          notMuted(muted),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      type: r.type as NotificationType,
      title: r.title,
      body: r.body,
      link: r.link,
      read: r.readAt !== null,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

export async function markAllNotificationsRead(ctx: HouseholdContext): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(eq(notifications.householdId, ctx.household.id), eq(notifications.userId, ctx.user.id), isNull(notifications.readAt)),
      );
  });
}

export async function dismissNotification(ctx: HouseholdContext, id: string): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    await tx
      .update(notifications)
      .set({ dismissedAt: new Date(), readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(eq(notifications.id, id), eq(notifications.userId, ctx.user.id)));
  });
}

/**
 * Tell other members about something a housemate did (e.g. planned the week).
 * Runs in the actor's session, which can't read the others' settings; members
 * who switched the kind off never see it (see `mutedTypes`).
 */
export async function notifyHousemates(
  db: Queryable,
  household: Pick<HouseholdInfo, "id">,
  actorUserId: string,
  n: { type: NotificationType; title: string; body: string; link: string; dedupeKey: string },
): Promise<void> {
  const members = await db
    .select({ userId: householdMembers.userId, role: householdMembers.role })
    .from(householdMembers)
    .where(and(eq(householdMembers.householdId, household.id), sql`${householdMembers.userId} <> ${actorUserId}`));
  for (const m of members) {
    // A profile without an account has nobody to tell; restricted members aren't sent household-management news.
    if (!m.userId || m.role === "child") continue;
    await db
      .insert(notifications)
      .values({ householdId: household.id, userId: m.userId, ...n })
      .onConflictDoNothing();
  }
}
