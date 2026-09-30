"use server";

import { z } from "zod";
import { householdAction } from "@/server/action";
import { parseInput } from "@/server/errors";
import { dismissNotification, markAllNotificationsRead } from "@/server/services/notifications";

export async function markAllReadAction() {
  return householdAction("notifications.readAll", async (ctx) => markAllNotificationsRead(ctx));
}

export async function dismissNotificationAction(notificationId: string) {
  return householdAction("notifications.dismiss", async (ctx) => dismissNotification(ctx, parseInput(z.uuid(), notificationId)));
}
