"use server";

import { z } from "zod";
import { formatHintFrom } from "@/lib/barcode";
import { STORAGE_LOCATIONS } from "@/lib/domain";
import { GUESS_CONFIDENCES } from "@/lib/photo/validate";
import type { ScanAccess } from "@/lib/scan/types";
import { UNITS } from "@/lib/units";
import { householdAction } from "@/server/action";
import { parseInput } from "@/server/errors";
import * as barcodes from "@/server/services/barcodes";
import * as photos from "@/server/services/photo-recognition";

const memberId = z.uuid({ error: "That person couldn't be found." });
const ownership = {
  ownerMemberId: memberId.nullable().optional(),
  visibility: z.enum(["household", "private"]).optional(),
};

/** What the scanning screens may offer this household: decided on the server from the plan and settings. */
export async function scanAccessAction() {
  return householdAction(
    "scan.access",
    async (ctx): Promise<ScanAccess> => ({
      barcode: { allowed: ctx.plan.entitlements.barcode_scanning },
      photo: await photos.photoAvailability(ctx),
    }),
    { refresh: false },
  );
}

/** Look a barcode up. Only proposes: nothing is added. */
export async function lookupBarcodeAction(barcode: string, format?: string) {
  return householdAction(
    "scan.lookup",
    async (ctx) => {
      const raw = parseInput(z.string().max(64, "That doesn't look like a barcode."), barcode);
      return barcodes.lookupBarcode(ctx, raw, formatHintFrom(format));
    },
    { refresh: false },
  );
}

const scannedItemSchema = z.object({
  barcode: z.string().max(64),
  name: z.string().trim().min(1, "What is it? Give it a name first.").max(120, "That name is too long."),
  productId: z.uuid().nullable(),
  packCount: z.number().int().min(1).max(100),
  location: z.enum(STORAGE_LOCATIONS),
  brand: z.string().max(80).nullable().optional(),
  sizeText: z.string().max(60).nullable().optional(),
  quantity: z.number().positive().max(100000).nullable().optional(),
  unit: z.enum(UNITS).nullable().optional(),
  remember: z.boolean().optional(),
  ...ownership,
});

/** Add what the person confirmed after scanning, and remember the barcode. */
export async function addScannedItemAction(input: z.input<typeof scannedItemSchema>) {
  return householdAction(
    "scan.add",
    async (ctx) => barcodes.addScannedItem(ctx, parseInput(scannedItemSchema, input)),
    { message: (r) => (r.remembered ? "Added. Plenty will recognise that barcode next time." : "Added to your kitchen") },
  );
}

const photoItemsSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1, "What is it? Give it a name first.").max(120, "That name is too long."),
      productId: z.uuid().nullable(),
      quantity: z.number().int().min(1).max(100),
      location: z.enum(STORAGE_LOCATIONS),
      confidence: z.enum(GUESS_CONFIDENCES),
      ...ownership,
    }),
  )
  .min(1, "Tick at least one thing to add.")
  .max(50);

/** Add the guesses the person ticked and edited. The only way a photo changes the kitchen. */
export async function addPhotoItemsAction(items: z.input<typeof photoItemsSchema>) {
  return householdAction(
    "scan.photo.add",
    async (ctx) => photos.addPhotoItems(ctx, parseInput(photoItemsSchema, items)),
    { message: (ids) => (ids.length === 1 ? "Added to your kitchen" : `Added ${ids.length} things to your kitchen`) },
  );
}
