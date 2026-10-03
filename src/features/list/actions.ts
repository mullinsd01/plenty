"use server";

import { z } from "zod";
import { AISLES } from "@/lib/domain";
import { UNITS } from "@/lib/units";
import { householdAction } from "@/server/action";
import { withUser } from "@/server/db/client";
import { isRestricted } from "@/lib/members/permissions";
import { parseInput } from "@/server/errors";
import * as recurring from "@/server/services/recurring";
import * as shopping from "@/server/services/shopping";

const id = z.uuid({ error: "That item couldn't be found." });

const noteSchema = z.string().trim().max(300, "Keep notes under 300 characters.").nullable().optional();

const addSchema = z.object({
  name: z.string().trim().min(1, "What do you need?").max(120, "That name is too long."),
  quantity: z.number().positive("Quantity must be more than zero.").max(100000).nullable().optional(),
  unit: z.enum(UNITS).nullable().optional(),
  note: noteSchema,
  /** Whose it's for (a member id); null or absent = the household's. */
  ownerMemberId: id.nullable().optional(),
  visibility: z.enum(["household", "private"]).optional(),
});

export async function addListItemAction(input: z.input<typeof addSchema>) {
  return householdAction("list.add", async (ctx) => {
    const data = parseInput(addSchema, input);
    return shopping.addManualItem(ctx, data);
  });
}

const requestSchema = z.object({
  name: z.string().trim().min(1, "What would you like?").max(120, "That name is too long."),
  quantity: z.number().positive("Quantity must be more than zero.").max(100000).nullable().optional(),
  unit: z.enum(UNITS).nullable().optional(),
  note: noteSchema,
  forHousehold: z.boolean().optional(),
});

export async function addRequestAction(input: z.input<typeof requestSchema>) {
  return householdAction(
    "list.request",
    async (ctx) => shopping.addRequest(ctx, parseInput(requestSchema, input)),
    { message: (r) => (r.alreadyOnList ? "That's already on the list" : "Asked for — it's on the list") },
  );
}

export async function keepSuggestionAction(itemId: string) {
  return householdAction("list.keep", async (ctx) => {
    await shopping.keepSuggestion(ctx, parseInput(id, itemId));
  });
}

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  note: noteSchema,
  quantity: z.number().positive("Quantity must be more than zero.").max(100000).nullable().optional(),
  unit: z.enum(UNITS).nullable().optional(),
  aisle: z.enum(AISLES).optional(),
});

export async function updateListItemAction(itemId: string, patch: z.input<typeof updateSchema>) {
  return householdAction("list.update", async (ctx) => {
    await shopping.updateShoppingItem(ctx, parseInput(id, itemId), parseInput(updateSchema, patch));
  });
}

export async function setListItemCheckedAction(itemId: string, checked: boolean) {
  return householdAction("list.check", async (ctx) => {
    await shopping.setChecked(ctx, parseInput(id, itemId), Boolean(checked));
  });
}

export async function removeListItemAction(itemId: string) {
  return householdAction("list.remove", async (ctx) => {
    await shopping.removeShoppingItem(ctx, parseInput(id, itemId));
  });
}

export async function reorderListAction(orderedIds: string[]) {
  return householdAction("list.reorder", async (ctx) => {
    await shopping.reorderShoppingItems(ctx, parseInput(z.array(id).max(500), orderedIds));
  });
}

export async function completeShopAction(addToKitchen: boolean) {
  return householdAction(
    "list.complete",
    async (ctx) => shopping.completeShop(ctx, Boolean(addToKitchen)),
    {
      message: (r) =>
        r.moved === 0 ? "Nothing ticked off yet" : addToKitchen ? `${r.moved} things added to your kitchen` : `Cleared ${r.moved} things`,
    },
  );
}

export async function refreshListAction() {
  return householdAction("list.refresh", async (ctx) => {
    // Restricted members read the list as it is; an adult's next visit brings it up to date.
    if (isRestricted(ctx.role)) return;
    await withUser(ctx.user.id, (tx) => shopping.syncShoppingList(tx, ctx.household, new Date()));
  });
}

export async function setStapleAction(productId: string, value: boolean | null) {
  return householdAction("list.staple", async (ctx) => {
    await shopping.setStapleOverride(ctx, parseInput(id, productId), value);
  });
}

const recurringSchema = z.object({
  name: z.string().trim().min(1, "What should repeat?").max(120, "That name is too long."),
  quantity: z.number().positive("Quantity must be more than zero.").max(100000).nullable().optional(),
  unit: z.enum(UNITS).nullable().optional(),
  note: noteSchema,
  ownerMemberId: id.nullable().optional(),
  visibility: z.enum(["household", "private"]).optional(),
  intervalDays: z.number().int().min(1, "At least every day.").max(365, "At most every year."),
});

export async function createRecurringAction(input: z.input<typeof recurringSchema>) {
  return householdAction("list.recurring.create", async (ctx) => recurring.createRecurring(ctx, parseInput(recurringSchema, input)), {
    message: "Added to your regular purchases",
  });
}

const recurringPatchSchema = z.object({
  quantity: z.number().positive("Quantity must be more than zero.").max(100000).nullable().optional(),
  unit: z.enum(UNITS).nullable().optional(),
  note: noteSchema,
  intervalDays: z.number().int().min(1).max(365).optional(),
  active: z.boolean().optional(),
});

export async function updateRecurringAction(recurringId: string, patch: z.input<typeof recurringPatchSchema>) {
  return householdAction("list.recurring.update", async (ctx) => {
    await recurring.updateRecurring(ctx, parseInput(id, recurringId), parseInput(recurringPatchSchema, patch));
  });
}

export async function deleteRecurringAction(recurringId: string) {
  return householdAction(
    "list.recurring.delete",
    async (ctx) => {
      await recurring.deleteRecurring(ctx, parseInput(id, recurringId));
    },
    { message: "Stopped repeating" },
  );
}
