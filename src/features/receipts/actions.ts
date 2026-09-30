"use server";

import { after } from "next/server";
import { z } from "zod";
import { STORAGE_LOCATIONS } from "@/lib/domain";
import { isDateString } from "@/lib/dates";
import { UNITS } from "@/lib/units";
import { householdAction } from "@/server/action";
import { parseInput } from "@/server/errors";
import * as receipts from "@/server/services/receipts";

const id = z.uuid({ error: "That receipt couldn't be found." });

const confirmSchema = z.object({
  storeName: z.string().trim().max(80).nullable(),
  purchasedOn: z.string().refine(isDateString, "Use a valid date.").nullable(),
  items: z
    .array(
      z.object({
        id: z.uuid(),
        include: z.boolean(),
        name: z.string().trim().min(1, "Every item needs a name.").max(120),
        productId: z.uuid().nullable(),
        quantity: z.number().positive("Amounts must be more than zero.").max(100000),
        unit: z.enum(UNITS),
        packCount: z.number().int().min(1).max(100),
        location: z.enum(STORAGE_LOCATIONS),
        existingDecision: z.enum(["replace", "keep", "merge"]).nullable(),
      }),
    )
    .max(300),
});

export async function confirmReceiptAction(receiptId: string, input: z.input<typeof confirmSchema>) {
  return householdAction(
    "receipts.confirm",
    async (ctx) => receipts.confirmReceipt(ctx, parseInput(id, receiptId), parseInput(confirmSchema, input)),
    {
      message: (r) =>
        `${r.added} ${r.added === 1 ? "thing" : "things"} added to your kitchen${r.tickedOff > 0 ? ` · ${r.tickedOff} ticked off your list` : ""}`,
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
    await receipts.retryReceipt(ctx, rid);
    after(() => receipts.processReceipt(ctx.user.id, ctx.household, rid));
  });
}
