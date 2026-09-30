"use server";

import { redirect } from "next/navigation";
import type { ActionResult } from "@/lib/result";
import { userForAction } from "@/server/auth/context";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { toUserError } from "@/server/errors";
import { acceptInvitation } from "@/server/services/household";

export async function joinHouseholdAction(code: string): Promise<ActionResult<undefined>> {
  try {
    const user = await userForAction();
    await enforceRateLimit(`join:${user.id}`, 10, 900, "joining households");
    await acceptInvitation(user, String(code ?? ""));
  } catch (err) {
    return toUserError(err, "household.join");
  }
  redirect("/home");
}
