import type { Metadata } from "next";
import Link from "next/link";
import { ChefHat } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CookActions } from "@/features/meals/cook-actions";
import { nextDays } from "@/features/meals/day-options";
import { MealCard } from "@/features/meals/meal-card";
import { MealsTabs } from "@/features/meals/meals-tabs";
import { cn } from "@/lib/cn";
import { toDateString } from "@/lib/dates";
import { requireHousehold } from "@/server/auth/context";
import { whatCanIMake } from "@/server/services/meals";

export const metadata: Metadata = { title: "What can I make?" };

const TIME_FILTERS = [
  { value: undefined, label: "Any time" },
  { value: 20, label: "20 min" },
  { value: 30, label: "30 min" },
  { value: 45, label: "45 min" },
];

export default async function CookPage({ searchParams }: PageProps<"/meals/cook">) {
  const ctx = await requireHousehold();
  const { max } = await searchParams;
  const maxMinutes = typeof max === "string" && /^\d{1,3}$/.test(max) ? Number(max) : undefined;
  const meals = await whatCanIMake(ctx, { maxMinutes });
  const today = toDateString(new Date(), ctx.household.timezone);
  const ready = meals.filter((m) => m.missingCount === 0);
  const almost = meals.filter((m) => m.missingCount > 0);
  const days = nextDays(today);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in">
      <PageHeader title="What can I make?" subtitle="Ranked by what's already in your kitchen, what needs using, and what you like." />
      <MealsTabs />
      <div className="scrollbar-none -mx-4 mb-6 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0" aria-label="Time available">
        {TIME_FILTERS.map((f) => {
          const active = f.value === maxMinutes;
          return (
            <Link
              key={f.label}
              href={f.value ? `/meals/cook?max=${f.value}` : "/meals/cook"}
              aria-current={active ? "true" : undefined}
              className={cn(
                "inline-flex h-9 shrink-0 items-center rounded-full border px-3.5 text-[13px] font-medium transition",
                active ? "border-primary bg-primary text-on-primary" : "border-line-strong bg-surface text-ink-2 hover:border-ink-4",
              )}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      {meals.length === 0 ? (
        <Card>
          <EmptyState icon={<ChefHat />} title="Nothing fits right now">
            Try a longer time, or scan your latest receipt so Plenty knows what&apos;s in your kitchen.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-8">
          {ready.length > 0 && (
            <section>
              <h2 className="mb-3 text-[15px] font-semibold">You already have everything for</h2>
              <div className="space-y-3">
                {ready.map((m) => (
                  <MealCard key={m.id} meal={m} href={`/meals/recipes/${m.id}`}>
                    <CookActions mealId={m.id} days={days} compact />
                  </MealCard>
                ))}
              </div>
            </section>
          )}
          {almost.length > 0 && (
            <section>
              <h2 className="mb-3 text-[15px] font-semibold">{ready.length > 0 ? "Missing just a few things" : "Closest matches"}</h2>
              <div className="space-y-3">
                {almost.map((m) => (
                  <MealCard key={m.id} meal={m} href={`/meals/recipes/${m.id}`}>
                    <CookActions mealId={m.id} days={days} compact />
                  </MealCard>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
