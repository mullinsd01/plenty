"use server";

import { z } from "zod";
import { isDateString } from "@/lib/dates";
import { UNITS } from "@/lib/units";
import { householdAction } from "@/server/action";
import { parseInput } from "@/server/errors";
import * as meals from "@/server/services/meals";

const id = z.uuid({ error: "That meal couldn't be found." });
const date = z.string().refine(isDateString, "Pick a valid day.");

function planMessage(r: meals.PlanResult, regenerate: boolean): string {
  const main =
    r.planned === 0
      ? "Those days are already planned"
      : r.planned === 1
        ? "Dinner's planned"
        : `Planned ${r.planned} dinners — missing ingredients are on your list`;
  if (r.unfilled === 0) return main;
  const nights = r.unfilled === 1 ? "1 night" : `${r.unfilled} nights`;
  return regenerate
    ? `${main}. Nothing else fits your preferences for ${nights}, so ${r.unfilled === 1 ? "it keeps its" : "they keep their"} meal.`
    : `${main}. Nothing fits your preferences for ${nights} — try relaxing a dislike or allergy filter.`;
}

export async function generatePlanAction(range: meals.PlanRange, regenerate = false) {
  return householdAction(
    "meals.generate",
    async (ctx) => meals.generateMealPlan(ctx, parseInput(z.enum(["tonight", "tomorrow", "3days", "week"]), range), { regenerate }),
    { message: (r) => planMessage(r, regenerate) },
  );
}

/** Plan one particular night (an empty day on the plan). */
export async function planDayAction(onDate: string) {
  return householdAction("meals.planDay", async (ctx) => meals.planDinnerOn(ctx, parseInput(date, onDate)), {
    message: (r) => planMessage(r, false),
  });
}

export async function replacePlanItemAction(itemId: string, dislike = false) {
  return householdAction(
    "meals.replace",
    async (ctx) => meals.replacePlanItem(ctx, parseInput(id, itemId), { dislike }),
    { message: (r) => (dislike ? `Got it — swapped for ${r.mealName}` : `Swapped for ${r.mealName}`) },
  );
}

export async function removePlanItemAction(itemId: string) {
  return householdAction("meals.remove", async (ctx) => meals.removePlanItem(ctx, parseInput(id, itemId)));
}

export async function setPlanServingsAction(itemId: string, servings: number) {
  return householdAction("meals.servings", async (ctx) =>
    meals.setPlanItemServings(ctx, parseInput(id, itemId), parseInput(z.number().int().min(1).max(24), servings)),
  );
}

export async function movePlanItemAction(itemId: string, toDate: string) {
  return householdAction("meals.move", async (ctx) => meals.movePlanItem(ctx, parseInput(id, itemId), parseInput(date, toDate)));
}

export async function addMealToPlanAction(mealId: string, onDate: string) {
  return householdAction("meals.addToPlan", async (ctx) => meals.addMealToPlan(ctx, parseInput(id, mealId), parseInput(date, onDate)), {
    message: (r) => (r.replaced ? `Added to your plan in place of ${r.replaced}` : "Added to your plan"),
  });
}

export async function cookPlanItemAction(itemId: string) {
  return householdAction("meals.cook", async (ctx) => meals.markPlanItemCooked(ctx, parseInput(id, itemId)), {
    message: (r) => (r.usedItems > 0 ? "Enjoy! Plenty took the ingredients out of your kitchen." : "Enjoy!"),
  });
}

export async function cookMealNowAction(mealId: string, servings?: number) {
  return householdAction(
    "meals.cookNow",
    async (ctx) => meals.cookMealNow(ctx, parseInput(id, mealId), parseInput(z.number().int().min(1).max(24).optional(), servings)),
    {
      message: (r) => (r.usedItems > 0 ? "Enjoy! Plenty took the ingredients out of your kitchen." : "Enjoy!"),
    },
  );
}

export async function rateMealAction(mealId: string, rating: -1 | 0 | 1) {
  return householdAction("meals.rate", async (ctx) => meals.rateMeal(ctx, parseInput(id, mealId), parseInput(z.union([z.literal(-1), z.literal(0), z.literal(1)]), rating)));
}

const reportSchema = z.object({
  reason: z.enum(["unsafe", "inaccurate", "offensive", "other"], { error: "Pick what's wrong with it." }),
  note: z.string().max(1000, "Keep the note under 1,000 characters.").optional(),
});

export async function reportRecipeAction(mealId: string, input: { reason: string; note?: string }) {
  return householdAction(
    "meals.report",
    async (ctx) => {
      const report = parseInput(reportSchema, input);
      await meals.reportRecipe(ctx, parseInput(id, mealId), report.reason, report.note);
    },
    { message: "Thanks — we've got your report.", refresh: false },
  );
}

export async function saveMealAction(mealId: string, saved: boolean) {
  return householdAction("meals.save", async (ctx) => meals.setMealSaved(ctx, parseInput(id, mealId), Boolean(saved)), {
    message: saved ? "Saved to your recipes" : undefined,
  });
}

const editSchema = z.object({
  name: z.string().trim().min(1, "Give the recipe a name.").max(100),
  description: z.string().max(300).default(""),
  timeMinutes: z.number().int().min(1).max(600),
  servings: z.number().int().min(1).max(24),
  ingredients: z
    .array(
      z.object({
        name: z.string().trim().max(80),
        quantity: z.number().positive().max(100000).nullable(),
        unit: z.enum(UNITS).nullable(),
        optional: z.boolean(),
      }),
    )
    .min(1)
    .max(40),
  steps: z.array(z.string().trim().max(600)).min(1).max(20),
});

export async function editMealAction(mealId: string, input: z.input<typeof editSchema>) {
  return householdAction("meals.edit", async (ctx) => meals.editMeal(ctx, parseInput(id, mealId), parseInput(editSchema, input)), {
    message: "Recipe saved",
  });
}

export async function deleteMealAction(mealId: string) {
  return householdAction("meals.delete", async (ctx) => meals.deleteHouseholdMeal(ctx, parseInput(id, mealId)), {
    message: (r) => (r.unplanned > 0 ? "Recipe deleted and taken off your meal plan" : "Recipe deleted"),
  });
}

export async function freshIdeasAction() {
  return householdAction("meals.freshIdeas", async (ctx) => meals.generateFreshIdeas(ctx), {
    message: (r) => (r.created > 0 ? `${r.created} new recipes written for what's in your kitchen` : "No new ideas fit your preferences this time"),
  });
}
