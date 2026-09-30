import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { PageHeader } from "@/components/ui/page-header";
import { RecipeEditor } from "@/features/meals/recipe-editor";
import type { Unit } from "@/lib/units";
import { requireHousehold } from "@/server/auth/context";
import { withUser } from "@/server/db/client";
import { mealIngredients, meals } from "@/server/db/schema";

export const metadata: Metadata = { title: "Edit recipe" };

export default async function EditRecipePage({ params }: PageProps<"/meals/recipes/[id]/edit">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const ctx = await requireHousehold();
  const data = await withUser(ctx.user.id, async (tx) => {
    const [meal] = await tx
      .select()
      .from(meals)
      .where(and(eq(meals.id, id), or(isNull(meals.householdId), eq(meals.householdId, ctx.household.id)), isNull(meals.deletedAt)))
      .limit(1);
    if (!meal) return null;
    const ingredients = await tx.select().from(mealIngredients).where(eq(mealIngredients.mealId, id)).orderBy(asc(mealIngredients.position));
    return { meal, ingredients };
  });
  if (!data) notFound();
  const { meal, ingredients } = data;
  const isCopy = meal.householdId === null || meal.source !== "user";
  return (
    <div className="mx-auto max-w-2xl animate-fade-in">
      <PageHeader
        back={{ href: `/meals/recipes/${meal.id}`, label: meal.name }}
        title={isCopy ? "Make it your own" : "Edit recipe"}
        subtitle={isCopy ? "Your changes are saved as your household's version. The original stays in the collection." : undefined}
      />
      <RecipeEditor
        mealId={meal.id}
        canDelete={!isCopy}
        initial={{
          name: meal.name,
          description: meal.description,
          timeMinutes: meal.timeMinutes,
          servings: meal.servings,
          ingredients: ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: (i.unit as Unit | null) ?? null, optional: i.optional })),
          steps: meal.steps,
        }}
      />
    </div>
  );
}
