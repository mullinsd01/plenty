"use server";

import { z } from "zod";
import { householdAction } from "@/server/action";
import { parseInput } from "@/server/errors";
import { clearMealPreference } from "@/server/services/meals";
import { resetProductLearning, setPredictionsPaused } from "@/server/services/memory";
import { setStapleOverride } from "@/server/services/shopping";

const id = z.uuid({ error: "That couldn't be found." });
const scopeSchema = z.string().regex(/^(household|(member|private):[0-9a-f-]{36})$/, "That isn't a valid pattern.").optional();

export async function setPredictionsPausedAction(productId: string, paused: boolean, scope?: string) {
  return householdAction("insights.pause", async (ctx) => setPredictionsPaused(ctx, parseInput(id, productId), Boolean(paused), parseInput(scopeSchema, scope)), {
    message: paused ? "Plenty will stop predicting this" : "Predictions turned back on",
  });
}

export async function setStapleOverrideAction(productId: string, value: boolean | null) {
  return householdAction("insights.staple", async (ctx) => setStapleOverride(ctx, parseInput(id, productId), value), {
    message: value === null ? "Plenty will decide" : value ? "Marked as a staple" : "No longer a staple",
  });
}

export async function resetLearningAction(productId: string, scope?: string) {
  return householdAction("insights.reset", async (ctx) => resetProductLearning(ctx, parseInput(id, productId), parseInput(scopeSchema, scope)), {
    message: "Plenty will learn this one from scratch",
  });
}

export async function forgetMealAction(mealId: string) {
  return householdAction("insights.forgetMeal", async (ctx) => clearMealPreference(ctx, parseInput(id, mealId)), {
    message: "Forgotten",
  });
}
