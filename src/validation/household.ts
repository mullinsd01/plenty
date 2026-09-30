import { z } from "zod";
import { ALLERGENS, COOKING_FREQUENCIES, CUISINES, CURRENCIES, DIETS } from "@/lib/domain";

const listOf = <T extends readonly [string, ...string[]]>(values: T) => z.array(z.enum(values)).max(values.length);

export const householdBasicsSchema = z.object({
  name: z.string().trim().min(1, "Give your household a name.").max(80, "Keep it under 80 characters."),
  adults: z.coerce.number().int().min(0).max(20),
  children: z.coerce.number().int().min(0).max(20),
  timezone: z
    .string()
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unknown timezone.")
    .optional(),
  currency: z.enum(CURRENCIES).optional(),
}).refine((v) => v.adults + v.children >= 1, { message: "A household needs at least one person.", path: ["adults"] });

export const preferencesSchema = z.object({
  diets: listOf(DIETS).optional(),
  allergies: listOf(ALLERGENS).optional(),
  dislikedIngredients: z
    .array(z.string().trim().toLowerCase().min(1).max(40))
    .max(40, "That's a lot of dislikes — keep it to 40.")
    .optional(),
  favouriteCuisines: listOf(CUISINES).optional(),
  cookingFrequency: z.enum(COOKING_FREQUENCIES).nullable().optional(),
  weeknightMaxMinutes: z.coerce.number().int().min(10).max(240).nullable().optional(),
  weeklyBudget: z.coerce.number().min(0).max(100000).nullable().optional(),
  preferredStores: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  takeawayPerWeek: z.coerce.number().int().min(0).max(21).nullable().optional(),
  usualShopDay: z.coerce.number().int().min(0).max(6).nullable().optional(),
  shopIntervalDays: z.coerce.number().int().min(1).max(60).nullable().optional(),
  allowAiProcessing: z.boolean().optional(),
});

export type PreferencesInput = z.infer<typeof preferencesSchema>;

export const notificationSettingsSchema = z.object({
  runningLow: z.boolean(),
  useSoon: z.boolean(),
  mealPlanReady: z.boolean(),
  shoppingReminder: z.boolean(),
  checkIns: z.boolean(),
  insights: z.boolean(),
  emailDigest: z.boolean(),
  dailyLimit: z.coerce.number().int().min(0).max(20),
  quietStartHour: z.coerce.number().int().min(0).max(23).nullable(),
  quietEndHour: z.coerce.number().int().min(0).max(23).nullable(),
});

export type NotificationSettingsInput = z.infer<typeof notificationSettingsSchema>;
