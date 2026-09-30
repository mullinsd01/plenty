import "server-only";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { NotificationType } from "@/lib/domain";
import type { HouseholdContext, HouseholdInfo } from "@/server/auth/context";
import { withUser, type Queryable } from "@/server/db/client";
import { householdMembers, notifications } from "@/server/db/schema";

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
    const [row] = await tx
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.householdId, ctx.household.id),
          eq(notifications.userId, ctx.user.id),
          isNull(notifications.readAt),
          isNull(notifications.dismissedAt),
        ),
      );
    return Number(row?.n ?? 0);
  });
}

export async function listNotifications(ctx: HouseholdContext, limit = 50): Promise<NotificationView[]> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.householdId, ctx.household.id),
          eq(notifications.userId, ctx.user.id),
          isNull(notifications.dismissedAt),
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

/** Tell other members about something a housemate did (e.g. planned the week). */
export async function notifyHousemates(
  db: Queryable,
  household: Pick<HouseholdInfo, "id">,
  actorUserId: string,
  n: { type: NotificationType; title: string; body: string; link: string; dedupeKey: string },
): Promise<void> {
  const members = await db
    .select({ userId: householdMembers.userId })
    .from(householdMembers)
    .where(and(eq(householdMembers.householdId, household.id), sql`${householdMembers.userId} <> ${actorUserId}`));
  for (const m of members) {
    await db
      .insert(notifications)
      .values({ householdId: household.id, userId: m.userId, ...n })
      .onConflictDoNothing();
  }
}
