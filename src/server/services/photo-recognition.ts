import "server-only";
import { decideExternalAi, EXTERNAL_AI_PROVIDER } from "@/lib/ai/consent";
import { PHOTO_PROBLEM_TEXT, validateReading } from "@/lib/photo/validate";
import type { ConfirmedPhotoItem, PhotoAvailability, PhotoGuess, PhotoProposal } from "@/lib/scan/types";
import { formatQuantity } from "@/lib/units";
import { AIUnavailableError, getLocalProvider, requireExternalProvider, resolveAiAccess, type GroceryPhotoInput } from "@/server/ai";
import type { HouseholdContext } from "@/server/auth/context";
import { checkRateLimit } from "@/server/auth/rate-limit";
import { planLimitError, requireEntitlement } from "@/server/billing/limits";
import { withUser } from "@/server/db/client";
import { isProduction } from "@/server/env";
import { AppError } from "@/server/errors";
import { prepareGroceryPhoto, PhotoImageError } from "@/server/photos/grocery-image";
import { addItems } from "./inventory";
import { loadProductIndex, resolveProduct } from "./products";

/**
 * Photo recognition, server side. A person photographs groceries; an AI reader
 * lists what it thinks it can see; Plenty validates that list and shows it for
 * review. Nothing is added until the person confirms (`addPhotoItems`).
 *
 * Three things must all be true before a photo is sent anywhere: the plan
 * includes photo recognition, the household has said yes to AI processing
 * (the consent guard in `src/server/ai/consent.ts`, which is the only way to
 * get the outside provider), and an AI service is set up. The photo is held in
 * memory for this one request: it is never stored, logged, or sent with
 * anything about the household.
 */

const FEATURE = "Photo recognition";
/** Per person: photos recognised in ten minutes. */
export const PHOTOS_PER_USER = 10;
export const PHOTO_USER_WINDOW_SECONDS = 600;
/** Per household: photos recognised a day, so a stuck loop or a shared device can't run up a bill. */
export const PHOTOS_PER_HOUSEHOLD_DAY = 30;
const DAY_SECONDS = 86_400;
/** Matching a guess to the catalogue needs a firm match: a wrong product link would skew predictions. */
const MATCH_MIN_SCORE = 0.8;

const OTHER_WAYS = "You can still add things by typing, scanning a barcode or scanning a receipt.";

/** What this household can do with photo recognition right now, and why not when it can't. No AI is called. */
export async function photoAvailability(ctx: HouseholdContext): Promise<PhotoAvailability> {
  if (!ctx.plan.entitlements.photo_recognition) return { state: "needs_plan" };
  const access = await resolveAiAccess(ctx.household.id);
  const providerName = access.configured ? EXTERNAL_AI_PROVIDER.name : null;
  if (access.decision.allowed) return { state: "ready", sample: false, providerName };
  if (access.decision.reason === "plan") return { state: "needs_plan" };
  if (access.decision.reason === "no_consent") return { state: "needs_consent", providerName };
  // No AI service is set up. Outside production the built-in stand-in can show the flow with a made-up list —
  // but only once the household has agreed, exactly as if a real service were on the other end.
  if (isProduction()) return { state: "needs_provider" };
  const asIfConfigured = decideExternalAi({ configured: true, entitled: access.entitled, consent: access.consent });
  if (asIfConfigured.allowed) return { state: "ready", sample: true, providerName: null };
  return asIfConfigured.reason === "plan" ? { state: "needs_plan" } : { state: "needs_consent", providerName: null };
}

function refusal(availability: Exclude<PhotoAvailability, { state: "ready" }>): AppError {
  switch (availability.state) {
    case "needs_plan":
      return planLimitError(`${FEATURE} is part of Plenty Plus. Everything else keeps working as it is.`);
    case "needs_consent":
      return new AppError(
        "forbidden",
        `Plenty needs your household's OK before it sends a photo to ${EXTERNAL_AI_PROVIDER.name} to recognise groceries. An owner or member can allow that in Settings → Privacy & data. ${OTHER_WAYS}`,
      );
    case "needs_provider":
      return new AppError("ai_unavailable", `Photo recognition needs an AI service, and none is set up on this Plenty. ${OTHER_WAYS}`);
  }
}

async function limitOrThrow(key: string, limit: number, windowSeconds: number, message: string): Promise<void> {
  const res = await checkRateLimit(key, limit, windowSeconds);
  if (!res.ok) throw new AppError("rate_limited", message);
}

/** Test seam: what reads the photo, in place of the AI provider. It is still only reached through the permission checks. */
export interface PhotoDeps {
  recognize?: (input: GroceryPhotoInput) => Promise<unknown>;
}

/**
 * Read a grocery photo and propose what's in it. Never changes the kitchen.
 * `bytes` is the uploaded file as received.
 */
export async function recognizeGroceryPhoto(ctx: HouseholdContext, bytes: Buffer, deps: PhotoDeps = {}): Promise<PhotoProposal> {
  requireEntitlement(ctx, "photo_recognition", FEATURE);
  const availability = await photoAvailability(ctx);
  if (availability.state !== "ready") throw refusal(availability);

  await limitOrThrow(
    `photo-recognition:user:${ctx.user.id}`,
    PHOTOS_PER_USER,
    PHOTO_USER_WINDOW_SECONDS,
    "You've tried a few photos in a row. Please wait a few minutes and try again.",
  );
  await limitOrThrow(
    `photo-recognition:household:${ctx.household.id}`,
    PHOTOS_PER_HOUSEHOLD_DAY,
    DAY_SECONDS,
    `Plenty reads up to ${PHOTOS_PER_HOUSEHOLD_DAY} photos a day for each household. Try again tomorrow. ${OTHER_WAYS}`,
  );

  let prepared;
  try {
    prepared = await prepareGroceryPhoto(bytes);
  } catch (err) {
    if (err instanceof PhotoImageError) throw new AppError("validation", err.message);
    throw err;
  }

  const input: GroceryPhotoInput = { image: prepared.buffer, mimeType: "image/jpeg" };
  let reading: unknown;
  try {
    if (deps.recognize) {
      reading = await deps.recognize(input);
    } else if (availability.sample) {
      reading = await getLocalProvider().recognizeGroceries(input);
    } else {
      const chosen = await requireExternalProvider(ctx.household.id, "photo");
      reading = await chosen.provider.recognizeGroceries(input);
    }
  } catch (err) {
    if (err instanceof AIUnavailableError) {
      console.warn(`[photo] reader unavailable (${err.reason})`);
      throw new AppError("ai_unavailable", `Plenty couldn't read that photo right now. Please try again in a moment. ${OTHER_WAYS}`);
    }
    throw err;
  }

  const valid = validateReading(reading);
  if (!valid)
    throw new AppError("ai_unavailable", `Plenty couldn't make sense of what came back for that photo. Please try again. ${OTHER_WAYS}`);

  const index = await withUser(ctx.user.id, (tx) => loadProductIndex(tx, ctx.household.id));
  const guesses: PhotoGuess[] = valid.guesses.map((g, i) => {
    const matched = resolveProduct(index, g.name, MATCH_MIN_SCORE);
    return {
      id: `g${i}`,
      name: g.name,
      quantity: g.quantity,
      quantityKnown: g.quantityKnown,
      confidence: g.confidence,
      productId: matched?.product.id ?? null,
      productName: matched?.product.name ?? null,
      packLabel: matched ? `Usual pack: ${formatQuantity(matched.product.packageQuantity, matched.product.unit)}` : null,
      location: matched?.product.location ?? "pantry",
    };
  });
  return {
    guesses,
    sample: availability.sample,
    notes: valid.problems.map((p) => PHOTO_PROBLEM_TEXT[p]),
    discarded: valid.discarded,
  };
}

/** Plenty is never more than "medium" sure of something it only saw in a photo, and says "low" when the reader did. */
const INVENTORY_CONFIDENCE = { high: "medium", medium: "medium", low: "low" } as const;

/**
 * Add the guesses the person checked, as edited. The only way a photo changes
 * the kitchen. The plan, the room left and whose items they may be are all
 * checked again here.
 */
export async function addPhotoItems(ctx: HouseholdContext, items: ConfirmedPhotoItem[]): Promise<string[]> {
  requireEntitlement(ctx, "photo_recognition", FEATURE);
  if (items.length === 0) throw new AppError("validation", "Tick at least one thing to add.");
  return addItems(
    ctx,
    items.map((item) => ({
      name: item.name,
      productId: item.productId,
      location: item.location,
      packCount: item.quantity,
      confidence: INVENTORY_CONFIDENCE[item.confidence],
      ownerMemberId: item.ownerMemberId ?? null,
      visibility: item.visibility,
    })),
    "photo",
  );
}
