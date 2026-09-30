import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { FoodPreferencesForm } from "@/features/settings/forms";
import type { Allergen, CookingFrequency, Cuisine, Diet } from "@/lib/domain";
import { requireHousehold } from "@/server/auth/context";
import { getPreferences } from "@/server/services/household";

export const metadata: Metadata = { title: "Food preferences" };

export default async function FoodSettingsPage() {
  const ctx = await requireHousehold();
  const p = await getPreferences(ctx);
  return (
    <div className="mx-auto max-w-2xl animate-fade-in">
      <PageHeader back={{ href: "/settings", label: "Settings" }} title="Food preferences" subtitle="Plenty uses these for every meal it suggests." />
      <FoodPreferencesForm
        initial={{
          allergies: p.allergies as Allergen[],
          diets: p.diets as Diet[],
          dislikedIngredients: p.dislikedIngredients,
          favouriteCuisines: p.favouriteCuisines as Cuisine[],
          cookingFrequency: (p.cookingFrequency as CookingFrequency | null) ?? null,
          weeknightMaxMinutes: p.weeknightMaxMinutes,
        }}
      />
    </div>
  );
}
