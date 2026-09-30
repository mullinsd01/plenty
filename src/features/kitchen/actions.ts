"use server";

import { z } from "zod";
import { CONSUMPTION_OUTCOMES, STORAGE_LOCATIONS } from "@/lib/domain";
import { isDateString } from "@/lib/dates";
import { UNITS } from "@/lib/units";
import { householdAction } from "@/server/action";
import { parseInput } from "@/server/errors";
import * as inventory from "@/server/services/inventory";

const id = z.uuid({ error: "That item couldn't be found." });
const dateString = z.string().refine(isDateString, "Use a valid date.");

const addItemSchema = z.object({
  name: z.string().trim().min(1, "What is it?").max(120, "That name is too long."),
  quantity: z.number().positive("Quantity must be more than zero.").max(100000).nullable().optional(),
  unit: z.enum(UNITS).nullable().optional(),
  packCount: z.number().int().min(1).max(100).nullable().optional(),
  location: z.enum(STORAGE_LOCATIONS).nullable().optional(),
  actualExpiry: dateString.nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  remainingFraction: z.number().min(0).max(1).nullable().optional(),
});

export async function addItemsAction(items: Array<z.input<typeof addItemSchema>>) {
  return householdAction(
    "kitchen.add",
    async (ctx) => {
      const parsed = parseInput(z.array(addItemSchema).min(1, "Add at least one thing.").max(50), items);
      return inventory.addItems(ctx, parsed, "manual");
    },
    { message: (ids) => (ids.length === 1 ? "Added to your kitchen" : `Added ${ids.length} things to your kitchen`) },
  );
}

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  location: z.enum(STORAGE_LOCATIONS).optional(),
  quantity: z.number().positive("Quantity must be more than zero.").max(100000).optional(),
  unit: z.enum(UNITS).optional(),
  actualExpiry: dateString.nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export async function updateItemAction(itemId: string, patch: z.input<typeof updateSchema>) {
  return householdAction("kitchen.update", async (ctx) => {
    await inventory.updateItem(ctx, parseInput(id, itemId), parseInput(updateSchema, patch));
  });
}

export async function setLevelAction(itemId: string, fraction: number) {
  return householdAction("kitchen.level", async (ctx) =>
    inventory.setLevel(ctx, parseInput(id, itemId), parseInput(z.number().min(0).max(1), fraction)),
  );
}

export async function finishItemAction(itemId: string, outcome: (typeof CONSUMPTION_OUTCOMES)[number]) {
  return householdAction("kitchen.finish", async (ctx) => {
    await inventory.finishItem(ctx, parseInput(id, itemId), parseInput(z.enum(CONSUMPTION_OUTCOMES), outcome));
  });
}

export async function removeItemAction(itemId: string) {
  return householdAction("kitchen.remove", async (ctx) => {
    await inventory.removeItem(ctx, parseInput(id, itemId));
  });
}

export async function restoreItemAction(itemId: string) {
  return householdAction("kitchen.restore", async (ctx) => {
    await inventory.restoreItem(ctx, parseInput(id, itemId));
  }, { message: "Restored" });
}

export async function clearOutItemsAction(itemIds: string[]) {
  return householdAction(
    "kitchen.clearOut",
    async (ctx) => inventory.clearOutItems(ctx, parseInput(z.array(id).min(1).max(200), itemIds)),
    { message: (n) => (n === 1 ? "Cleared out 1 thing" : `Cleared out ${n} things`) },
  );
}

export async function answerCheckInAction(productId: string, finished: boolean) {
  return householdAction("kitchen.checkIn", async (ctx) => {
    await inventory.answerCheckIn(ctx, parseInput(id, productId), Boolean(finished));
  });
}
