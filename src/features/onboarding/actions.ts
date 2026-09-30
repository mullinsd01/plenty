"use server";

import { redirect } from "next/navigation";
import { ok, type ActionResult } from "@/lib/result";
import { getHouseholdContext, householdForAction, userForAction } from "@/server/auth/context";
import { AppError, parseInput, toUserError } from "@/server/errors";
import * as households from "@/server/services/household";
import { householdBasicsSchema, preferencesSchema, type PreferencesInput } from "@/validation/household";

export async function saveHouseholdBasicsAction(input: {
  name: string;
  adults: number;
  children: number;
  timezone?: string;
}): Promise<ActionResult<{ householdId: string }>> {
  try {
    const user = await userForAction();
    const data = parseInput(householdBasicsSchema, input);
    const existing = await getHouseholdContext();
    if (existing) {
      await households.updateHouseholdBasics(existing, data);
      return ok({ householdId: existing.household.id });
    }
    return ok(await households.createHousehold(user, data));
  } catch (err) {
    return toUserError(err, "saveHouseholdBasics");
  }
}

export async function saveOnboardingPreferencesAction(input: PreferencesInput): Promise<ActionResult<undefined>> {
  try {
    const ctx = await householdForAction();
    await households.updatePreferences(ctx, parseInput(preferencesSchema, input));
    return ok(undefined);
  } catch (err) {
    return toUserError(err, "saveOnboardingPreferences");
  }
}

export async function finishOnboardingAction(destination: "home" | "scan"): Promise<ActionResult<undefined>> {
  try {
    const ctx = await getHouseholdContext();
    if (!ctx) throw new AppError("validation", "Tell us about your household first.");
    await households.completeOnboarding(ctx);
  } catch (err) {
    return toUserError(err, "finishOnboarding");
  }
  redirect(destination === "scan" ? "/receipts/new" : "/home");
}
