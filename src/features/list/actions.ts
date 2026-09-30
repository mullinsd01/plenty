"use server";

import { z } from "zod";
import { AISLES } from "@/lib/domain";
import { UNITS } from "@/lib/units";
import { householdAction } from "@/server/action";
import { withUser } from "@/server/db/client";
import { parseInput } from "@/server/errors";
import * as shopping from "@/server/services/shopping";

const id = z.uuid({ error: "That item couldn't be found." });

const addSchema = z.object({
  name: z.string().trim().min(1, "What do you need?").max(120, "That name is too long."),
  quantity: z.number().positive("Quantity must be more than zero.").max(100000).nullable().optional(),
  unit: z.enum(UNITS).nullable().optional(),
});

export async function addListItemAction(input: z.input<typeof addSchema>) {
  return householdAction("list.add", async (ctx) => {
    const data = parseInput(addSchema, input);
    return shopping.addManualItem(ctx, data);
  });
}

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
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
    await withUser(ctx.user.id, (tx) => shopping.syncShoppingList(tx, ctx.household, new Date()));
  });
}

export async function setStapleAction(productId: string, value: boolean | null) {
  return householdAction("list.staple", async (ctx) => {
    await shopping.setStapleOverride(ctx, parseInput(id, productId), value);
  });
}
