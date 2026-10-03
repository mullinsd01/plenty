"use server";

import { z } from "zod";
import { ALLERGENS, DIETS } from "@/lib/domain";
import { householdAction } from "@/server/action";
import { parseInput } from "@/server/errors";
import * as members from "@/server/services/members";

const id = z.uuid({ error: "That person couldn't be found." });
const name = z.string().trim().min(1, "What's their name?").max(40, "Keep names under 40 characters.");
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "That colour isn't valid.");

const addSchema = z.object({
  name,
  role: z.enum(["member", "child"]).optional(),
  color: color.optional(),
});

export async function addPersonAction(input: z.input<typeof addSchema>) {
  return householdAction("members.add", async (ctx) => members.addManagedMember(ctx, parseInput(addSchema, input)), {
    message: "Added to your household",
  });
}

const updateSchema = z.object({
  name: name.optional(),
  color: color.optional(),
  role: z.enum(["owner", "member", "child"]).optional(),
});

export async function updatePersonAction(memberId: string, patch: z.input<typeof updateSchema>) {
  return householdAction("members.update", async (ctx) => {
    await members.updateMember(ctx, parseInput(id, memberId), parseInput(updateSchema, patch));
  });
}

const rulesSchema = z.object({
  diets: z.array(z.enum(DIETS)).max(DIETS.length),
  allergies: z.array(z.enum(ALLERGENS)).max(ALLERGENS.length),
  dislikedIngredients: z.array(z.string().trim().min(1).max(40)).max(60),
});

export async function setFoodRulesAction(memberId: string, rules: z.input<typeof rulesSchema>) {
  return householdAction(
    "members.foodRules",
    async (ctx) => {
      const parsed = parseInput(rulesSchema, rules);
      await members.setMemberFoodRules(ctx, parseInput(id, memberId), {
        diets: parsed.diets,
        allergies: parsed.allergies,
        dislikedIngredients: [...new Set(parsed.dislikedIngredients.map((d) => d.toLowerCase()))],
      });
    },
    { message: "Saved" },
  );
}
