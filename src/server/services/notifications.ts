import "server-only";
import { and, count, eq, isNull } from "drizzle-orm";
import { withUser } from "@/server/db/client";
import { notifications } from "@/server/db/schema";
import type { HouseholdContext } from "@/server/auth/context";

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
