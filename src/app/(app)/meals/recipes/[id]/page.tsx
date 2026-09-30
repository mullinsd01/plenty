import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Check, Circle, CircleDashed, Clock, Pencil, Users } from "lucide-react";
import { MealArt } from "@/components/food/meal-art";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Pill } from "@/components/ui/pill";
import { CookActions, RatingActions } from "@/features/meals/cook-actions";
import { nextDays } from "@/features/meals/day-options";
import { AvailabilityLine } from "@/features/meals/meal-card";
import { cn } from "@/lib/cn";
import { toDateString } from "@/lib/dates";
import { timeAgo } from "@/lib/format";
import { requireHousehold } from "@/server/auth/context";
import { getMealDetail } from "@/server/services/meals";

export const metadata: Metadata = { title: "Recipe" };

export default async function RecipePage({ params, searchParams }: PageProps<"/meals/recipes/[id]">) {
  const { id } = await params;
  const { servings: servingsParam } = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const ctx = await requireHousehold();
  const servings = typeof servingsParam === "string" && /^\d{1,2}$/.test(servingsParam) ? Number(servingsParam) : undefined;
  const detail = await getMealDetail(ctx, id, servings);
  if (!detail) notFound();
  const { meal } = detail;
  const today = toDateString(new Date(), ctx.household.timezone);

  return (
    <div className="mx-auto max-w-2xl animate-fade-in">
      <PageHeader back={{ href: "/meals/recipes", label: "Recipes" }} title={meal.name} subtitle={meal.description || undefined} />

      <MealArt mainIngredient={meal.mainIngredient} name={meal.name} size="lg" className="mb-6" />

      {detail.blockedReason && (
        <div className="mb-6 flex gap-3 rounded-2xl bg-alert-soft px-4 py-3 text-[14px] text-alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{detail.blockedReason}. Plenty won&apos;t plan this for your household.</span>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Pill tone="outline">
          <Clock /> {meal.timeMinutes} min
        </Pill>
        <Pill tone="outline">{meal.difficultyLabel}</Pill>
        <Pill tone="outline">{meal.cuisineLabel}</Pill>
        <Pill tone="outline">
          <Users /> Serves {detail.servings}
        </Pill>
        {meal.source === "ai" && <Pill tone="info">Written for your kitchen</Pill>}
        {meal.source === "user" && <Pill tone="brand">Your recipe</Pill>}
      </div>

      <Card className="mb-8 p-4 sm:p-5">
        <AvailabilityLine meal={meal} className="text-[14px]" />
        {detail.timesCooked > 0 && (
          <p className="mt-1 text-[13px] text-ink-3">
            You&apos;ve made this {detail.timesCooked === 1 ? "once" : `${detail.timesCooked} times`}
            {detail.lastCookedAt ? ` · last ${timeAgo(detail.lastCookedAt)}` : ""}
          </p>
        )}
        {detail.plannedOn.length > 0 && <p className="mt-1 text-[13px] text-ink-3">Planned for {detail.plannedOn.map((p) => p.label.toLowerCase()).join(", ")}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <CookActions mealId={meal.id} days={nextDays(today)} servings={detail.servings} />
          <div className="ml-auto">
            <RatingActions mealId={meal.id} rating={meal.rating} saved={meal.saved} />
          </div>
        </div>
      </Card>

      <section className="mb-8">
        <SectionTitle
          action={
            <div className="flex items-center gap-1 text-[13px]">
              {[2, 4, 6].map((n) => (
                <Link
                  key={n}
                  href={`/meals/recipes/${meal.id}?servings=${n}`}
                  className={cn("rounded-full px-2.5 py-1 font-medium", detail.servings === n ? "bg-primary text-on-primary" : "text-ink-3 hover:bg-subtle")}
                >
                  {n}
                </Link>
              ))}
              <span className="ml-1 text-ink-4">servings</span>
            </div>
          }
        >
          Ingredients
        </SectionTitle>
        <Card className="divide-y divide-line">
          {detail.ingredients.map((ing, i) => (
            <div key={i} className={cn("flex items-center gap-3 px-4 py-3", ing.omitted && "opacity-50")}>
              <StatusIcon status={ing.status} />
              <div className="min-w-0 flex-1">
                <p className="text-[15px]">
                  <span className="font-medium">{ing.name}</span>
                  {ing.optional && <span className="text-ink-3"> (optional)</span>}
                  {ing.note && <span className="text-ink-3">, {ing.note}</span>}
                </p>
                <p className="text-[12px] text-ink-3">
                  {ing.omitted
                    ? "Left out — you'd rather not have this"
                    : ing.status === "have"
                      ? ing.substitute
                        ? "You have a close substitute"
                        : ing.usesSoonExpiring
                          ? "In your kitchen — and it needs using"
                          : "In your kitchen"
                      : ing.status === "partial"
                        ? "You have some, but not enough"
                        : ing.status === "assumed"
                          ? "Pantry basic"
                          : ing.status === "optional_missing"
                            ? "Not in your kitchen — fine to skip"
                            : "You'll need to buy this"}
                </p>
              </div>
              <span className="shrink-0 text-[14px] text-ink-2">{ing.amount}</span>
            </div>
          ))}
        </Card>
      </section>

      <section className="mb-8">
        <SectionTitle>Method</SectionTitle>
        <ol className="space-y-4">
          {detail.steps.map((step, i) => (
            <li key={i} className="flex gap-4">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-subtle text-[13px] font-semibold text-ink-2">{i + 1}</span>
              <p className="pt-0.5 text-[15px] leading-relaxed text-ink-2">{step}</p>
            </li>
          ))}
        </ol>
      </section>

      <Button asChild variant="secondary" size="sm">
        <Link href={`/meals/recipes/${meal.id}/edit`}>
          <Pencil /> {detail.basedOnLibrary ? "Make your own version" : "Edit recipe"}
        </Link>
      </Button>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "have") return <Check className="size-5 shrink-0 text-fresh" strokeWidth={2.5} aria-label="Have it" />;
  if (status === "assumed") return <Check className="size-5 shrink-0 text-ink-4" aria-label="Pantry basic" />;
  if (status === "partial") return <CircleDashed className="size-5 shrink-0 text-soon" aria-label="Have some" />;
  return <Circle className="size-5 shrink-0 text-ink-4" aria-label="Need to buy" />;
}
