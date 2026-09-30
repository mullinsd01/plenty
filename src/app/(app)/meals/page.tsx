import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { MealsTabs } from "@/features/meals/meals-tabs";
import { PlanView } from "@/features/meals/plan-view";
import { aiStatus } from "@/server/ai";
import { requireHousehold } from "@/server/auth/context";
import { getMealPlan } from "@/server/services/meals";

export const metadata: Metadata = { title: "Meals" };

export default async function MealsPage() {
  const ctx = await requireHousehold();
  const plan = await getMealPlan(ctx);
  const planned = plan.days.filter((d) => d.item && d.item.status === "planned").length;
  return (
    <div className="mx-auto max-w-3xl animate-fade-in">
      <PageHeader
        title="Meals"
        subtitle={planned === 0 ? "Plenty plans around what you already have." : `${planned} ${planned === 1 ? "dinner" : "dinners"} planned this week`}
      />
      <MealsTabs />
      <PlanView plan={plan} aiAvailable={aiStatus().externalConfigured} />
    </div>
  );
}
