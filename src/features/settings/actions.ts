"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { ok, type ActionResult } from "@/lib/result";
import { householdAction } from "@/server/action";
import { getAuthUser, householdForAction, userForAction } from "@/server/auth/context";
import { changePassword, deleteAccount, updateEmail } from "@/server/auth/service";
import { clearSessionCookie, getCurrentSession, invalidateAllSessions, invalidateOtherSessions } from "@/server/auth/session";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { AppError, parseInput, toUserError } from "@/server/errors";
import * as households from "@/server/services/household";
import { deleteHouseholdFiles } from "@/server/storage/files";
import { changePasswordSchema, emailSchema, nameSchema } from "@/validation/auth";
import { householdBasicsSchema, notificationSettingsSchema, preferencesSchema, type PreferencesInput } from "@/validation/household";

/** After a credential change, anyone else holding a session is signed out. */
async function signOutOtherDevices(userId: string): Promise<void> {
  const current = await getCurrentSession();
  if (current) await invalidateOtherSessions(userId, current.session.id);
  else await invalidateAllSessions(userId);
}

export async function updateProfileAction(displayName: string): Promise<ActionResult<undefined>> {
  try {
    const user = await userForAction();
    if (user.isDemo) throw new AppError("forbidden", "The demo account's name can't be changed.");
    await households.updateDisplayName(user, parseInput(nameSchema, displayName));
    return ok(undefined, "Name updated");
  } catch (err) {
    return toUserError(err, "settings.profile");
  }
}

export async function changePasswordAction(input: { current: string; password: string; confirm: string }): Promise<ActionResult<undefined>> {
  try {
    const user = await userForAction();
    const data = parseInput(changePasswordSchema, input);
    await enforceRateLimit(`change-password:${user.id}`, 6, 900, "changing your password");
    await changePassword(user.id, data.current, data.password);
    await signOutOtherDevices(user.id);
    return ok(undefined, "Password changed. Other devices have been signed out.");
  } catch (err) {
    return toUserError(err, "settings.password");
  }
}

export async function changeEmailAction(input: { email: string; password: string }): Promise<ActionResult<undefined>> {
  try {
    const user = await userForAction();
    const email = parseInput(emailSchema, input.email);
    await enforceRateLimit(`change-email:${user.id}`, 6, 900, "changing your email");
    await updateEmail(user.id, email, String(input.password ?? ""));
    await signOutOtherDevices(user.id);
    return ok(undefined, "Email updated");
  } catch (err) {
    return toUserError(err, "settings.email");
  }
}

export async function updateHouseholdAction(input: { name: string; adults: number; children: number; timezone?: string; currency?: string }) {
  return householdAction("settings.household", async (ctx) => households.updateHouseholdBasics(ctx, parseInput(householdBasicsSchema, input)), {
    message: "Household updated",
  });
}

export async function updatePreferencesAction(input: PreferencesInput) {
  return householdAction("settings.preferences", async (ctx) => households.updatePreferences(ctx, parseInput(preferencesSchema, input)), {
    message: "Saved",
  });
}

export async function updateNotificationSettingsAction(input: z.input<typeof notificationSettingsSchema>) {
  return householdAction(
    "settings.notifications",
    async (ctx) => households.updateNotificationSettings(ctx, parseInput(notificationSettingsSchema, input)),
    { message: "Notification settings saved" },
  );
}

export async function createInviteAction() {
  return householdAction("settings.invite", async (ctx) => households.createInvitation(ctx));
}

export async function revokeInvitesAction() {
  return householdAction("settings.revokeInvites", async (ctx) => households.revokeInvitations(ctx), {
    message: "Invite links turned off",
  });
}

export async function removeMemberAction(userId: string) {
  return householdAction("settings.removeMember", async (ctx) => households.removeMember(ctx, parseInput(z.uuid(), userId)), {
    message: "Removed from the household",
  });
}

export async function leaveHouseholdAction(): Promise<ActionResult<undefined>> {
  try {
    const ctx = await householdForAction();
    await households.leaveHousehold(ctx);
  } catch (err) {
    return toUserError(err, "settings.leave");
  }
  redirect("/home");
}

export async function deleteHouseholdAction(confirmName: string): Promise<ActionResult<undefined>> {
  try {
    const ctx = await householdForAction();
    if (ctx.household.isDemo) throw new AppError("forbidden", "The demo household can't be deleted.");
    if (confirmName.trim() !== ctx.household.name) {
      throw new AppError("validation", "Type the household name exactly to confirm.", { confirm: "Type the household name exactly." });
    }
    await households.deleteHousehold(ctx);
    await deleteHouseholdFiles(ctx.household.id);
  } catch (err) {
    return toUserError(err, "settings.deleteHousehold");
  }
  redirect("/onboarding");
}

export async function deleteAccountAction(password: string): Promise<ActionResult<undefined>> {
  try {
    const user = await userForAction();
    if (user.isDemo) throw new AppError("forbidden", "The demo account can't be deleted.");
    await enforceRateLimit(`delete-account:${user.id}`, 5, 900, "deleting your account");
    const { deletedHouseholdIds } = await deleteAccount(user.id, String(password ?? ""));
    // Only households that went with the account lose their photos; shared ones carry on.
    await Promise.all(deletedHouseholdIds.map((id) => deleteHouseholdFiles(id).catch(() => undefined)));
    await clearSessionCookie();
  } catch (err) {
    return toUserError(err, "settings.deleteAccount");
  }
  redirect("/");
}

export async function signOutEverywhereAction(): Promise<ActionResult<undefined>> {
  try {
    const current = await getCurrentSession();
    const user = await getAuthUser();
    if (!current || !user) throw new AppError("unauthenticated", "Your session has expired. Please sign in again.");
    if (user.isDemo) throw new AppError("forbidden", "The demo account is shared, so it can't sign out other visitors.");
    await invalidateAllSessions(user.id);
    await clearSessionCookie();
  } catch (err) {
    return toUserError(err, "settings.signOutEverywhere");
  }
  redirect("/login");
}

export async function switchHouseholdAction(householdId: string): Promise<ActionResult<undefined>> {
  try {
    const user = await userForAction();
    await households.switchHousehold(user, parseInput(z.uuid(), householdId));
  } catch (err) {
    return toUserError(err, "settings.switchHousehold");
  }
  redirect("/home");
}
