"use server";

import { after } from "next/server";
import { z } from "zod";
import { STORAGE_LOCATIONS } from "@/lib/domain";
import { isDateString } from "@/lib/dates";
import { UNITS } from "@/lib/units";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { householdAction } from "@/server/action";
import { parseInput } from "@/server/errors";
import { withUser } from "@/server/db/client";
import { learningProgressFor } from "@/server/services/dashboard";
import * as receipts from "@/server/services/receipts";

const id = z.uuid({ error: "That receipt couldn't be found." });

const confirmItem = z
  .object({
    id: z.uuid(),
    include: z.boolean(),
    name: z.string().trim().max(120),
    productId: z.uuid().nullable(),
    quantity: z.number(),
    unit: z.enum(UNITS),
    packCount: z.number(),
    location: z.enum(STORAGE_LOCATIONS),
    existingDecision: z.enum(["replace", "keep", "merge"]).nullable(),
    /** Whose it is: a member's id, or null for the household. Absent leaves it as the household's. */
    ownerMemberId: z.uuid().nullable().optional(),
    visibility: z.enum(["household", "private"]).optional(),
  })
  // Only lines going into the kitchen need sensible amounts; messages name the line so it can be found.
  .superRefine((item, ctx) => {
    if (!item.include) return;
    if (!item.name) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "Every item needs a name." });
      return;
    }
    if (!(item.quantity > 0) || item.quantity > receipts.MAX_RECEIPT_QUANTITY) {
      ctx.addIssue({ code: "custom", path: ["quantity"], message: `Check the amount for ${item.name}.` });
    }
    if (!Number.isInteger(item.packCount) || item.packCount < 1 || item.packCount > receipts.MAX_RECEIPT_PACKS) {
      ctx.addIssue({ code: "custom", path: ["packCount"], message: `Check the number of packs for ${item.name}.` });
    }
  });

const confirmSchema = z.object({
  storeName: z.string().trim().max(80).nullable(),
  purchasedOn: z.string().refine(isDateString, "Use a valid date.").nullable(),
  items: z.array(confirmItem).max(300),
});

export async function confirmReceiptAction(receiptId: string, input: z.input<typeof confirmSchema>) {
  return householdAction(
    "receipts.confirm",
    async (ctx) => {
      const result = await receipts.confirmReceipt(ctx, parseInput(id, receiptId), parseInput(confirmSchema, input));
      // Plenty learns a household's rhythm from a few shops: say how far along it is, and what helps.
      const progress = await withUser(ctx.user.id, (tx) => learningProgressFor(ctx, tx));
      return { ...result, progress };
    },
    {
      message: (r) => {
        const added = `${r.added} ${r.added === 1 ? "thing" : "things"} added to your kitchen${r.tickedOff > 0 ? ` · ${r.tickedOff} ticked off your list` : ""}`;
        return r.progress
          ? `${added}. That's ${r.progress.receipts} of ${r.progress.target} shops for Plenty to learn from: scan an older one next (oldest first works best).`
          : added;
      },
    },
  );
}

export async function discardReceiptAction(receiptId: string) {
  return householdAction("receipts.discard", async (ctx) => receipts.discardReceipt(ctx, parseInput(id, receiptId)), {
    message: "Receipt discarded",
  });
}

export async function retryReceiptAction(receiptId: string) {
  return householdAction("receipts.retry", async (ctx) => {
    const rid = parseInput(id, receiptId);
    await enforceRateLimit(`receipt-retry:${ctx.household.id}`, 20, 3600, "retrying receipts");
    await receipts.retryReceipt(ctx, rid);
    after(() => receipts.processReceipt(ctx.user.id, ctx.household, rid));
  });
}
