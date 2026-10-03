import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { MealsTabs } from "@/features/meals/meals-tabs";
import { PlanView } from "@/features/meals/plan-view";
import { can } from "@/lib/members/permissions";
import { resolveAiAccess } from "@/server/ai";
import { requireHousehold } from "@/server/auth/context";
import { getMealPlan } from "@/server/services/meals";

export const metadata: Metadata = { title: "Meals" };

export default async function MealsPage() {
  const ctx = await requireHousehold();
  const [plan, ai] = await Promise.all([getMealPlan(ctx), resolveAiAccess(ctx.household.id)]);
  const planned = plan.days.filter((d) => d.item && d.item.status === "planned").length;
  return (
    <div className="mx-auto max-w-3xl animate-fade-in">
      <PageHeader
        title="Meals"
        subtitle={planned === 0 ? "Plenty plans around what you already have." : `${planned} ${planned === 1 ? "dinner" : "dinners"} planned this week`}
      />
      <MealsTabs />
      <PlanView
        plan={plan}
        // "Fresh ideas" sends the kitchen to an outside AI service, so it only appears once the household has agreed to that.
        aiAvailable={ai.decision.allowed}
        canPlan={can(ctx.role, "plan_meals")}
        canPlanWeek={ctx.plan.entitlements.advanced_meal_planning}
      />
    </div>
  );
}
