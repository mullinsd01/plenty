import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { MealCard } from "@/features/meals/meal-card";
import { MealsTabs } from "@/features/meals/meals-tabs";
import { cn } from "@/lib/cn";
import { requireHousehold } from "@/server/auth/context";
import { browseMeals, type RecipeFilter } from "@/server/services/meals";

export const metadata: Metadata = { title: "Recipes" };

const FILTERS: Array<{ value: RecipeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "saved", label: "Saved" },
  { value: "favourites", label: "Favourites" },
  { value: "quick", label: "Quick" },
  { value: "vegetarian", label: "Vegetarian" },
  { value: "yours", label: "Your recipes" },
];

export default async function RecipesPage({ searchParams }: PageProps<"/meals/recipes">) {
  const ctx = await requireHousehold();
  const { filter } = await searchParams;
  const active = FILTERS.find((f) => f.value === filter)?.value ?? "all";
  const meals = await browseMeals(ctx, active);
  return (
    <div className="mx-auto max-w-3xl animate-fade-in">
      <PageHeader title="Recipes" subtitle="Plenty's collection plus anything you've saved or written. Sorted by what you can make." />
      <MealsTabs />
      <div className="scrollbar-none -mx-4 mb-6 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {FILTERS.map((f) => (
          <Link
            key={f.value}
            href={f.value === "all" ? "/meals/recipes" : `/meals/recipes?filter=${f.value}`}
            aria-current={active === f.value ? "true" : undefined}
            className={cn(
              "inline-flex h-9 shrink-0 items-center rounded-full border px-3.5 text-[13px] font-medium transition",
              active === f.value ? "border-primary bg-primary text-on-primary" : "border-line-strong bg-surface text-ink-2 hover:border-ink-4",
            )}
          >
            {f.label}
          </Link>
        ))}
      </div>
      {meals.length === 0 ? (
        <Card>
          <EmptyState icon={<BookOpen />} title={active === "saved" ? "No saved recipes yet" : "Nothing here yet"}>
            {active === "saved" || active === "favourites"
              ? "Tap the bookmark on any recipe to keep it here. Plenty also leans towards meals you save."
              : active === "yours"
                ? "Edit any recipe to make your own version, and it'll appear here."
                : "No recipes match your preferences."}
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {meals.map((m) => (
            <MealCard key={m.id} meal={m} href={`/meals/recipes/${m.id}`} />
          ))}
        </div>
      )}
    </div>
  );
}
