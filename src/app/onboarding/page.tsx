import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingFlow, type OnboardingInitial } from "@/features/onboarding/onboarding-flow";
import { getHouseholdContext, requireUser } from "@/server/auth/context";
import { getPreferences } from "@/server/services/household";
import type { Allergen, CookingFrequency, Cuisine, Diet } from "@/lib/domain";

export const metadata: Metadata = { title: "Set up your household" };

export default async function OnboardingPage() {
  const user = await requireUser();
  const ctx = await getHouseholdContext();
  if (ctx?.household.onboardedAt) redirect("/home");

  const firstName = user.displayName.split(" ")[0] || "there";
  const prefs = ctx ? await getPreferences(ctx) : null;
  const initial: OnboardingInitial = {
    firstName,
    hasHousehold: Boolean(ctx),
    householdName: ctx?.household.name ?? "",
    adults: ctx?.household.adults ?? 2,
    children: ctx?.household.children ?? 0,
    currency: ctx?.household.currency ?? "AUD",
    prefs: {
      diets: (prefs?.diets ?? []) as Diet[],
      allergies: (prefs?.allergies ?? []) as Allergen[],
      dislikedIngredients: prefs?.dislikedIngredients ?? [],
      favouriteCuisines: (prefs?.favouriteCuisines ?? []) as Cuisine[],
      cookingFrequency: (prefs?.cookingFrequency ?? null) as CookingFrequency | null,
      weeknightMaxMinutes: prefs?.weeknightMaxMinutes ?? null,
      weeklyBudget: prefs?.weeklyBudget ?? null,
      preferredStores: prefs?.preferredStores ?? [],
      takeawayPerWeek: prefs?.takeawayPerWeek ?? null,
    },
  };
  return <OnboardingFlow initial={initial} />;
}
