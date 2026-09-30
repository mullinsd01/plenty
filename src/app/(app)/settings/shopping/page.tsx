import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { ShoppingPreferencesForm } from "@/features/settings/forms";
import { requireHousehold } from "@/server/auth/context";
import { withUser } from "@/server/db/client";
import { getPreferences } from "@/server/services/household";
import { loadShoppingRhythm } from "@/server/services/shopping";

export const metadata: Metadata = { title: "Shopping & budget" };

export default async function ShoppingSettingsPage() {
  const ctx = await requireHousehold();
  const [p, rhythm] = await Promise.all([getPreferences(ctx), withUser(ctx.user.id, (tx) => loadShoppingRhythm(tx, ctx.household, new Date()))]);
  return (
    <div className="mx-auto max-w-2xl animate-fade-in">
      <PageHeader back={{ href: "/settings", label: "Settings" }} title="Shopping & budget" />
      <ShoppingPreferencesForm
        currency={ctx.household.currency}
        learnedLabel={rhythm.basis === "history" ? rhythm.label : null}
        initial={{
          preferredStores: p.preferredStores,
          weeklyBudget: p.weeklyBudget,
          usualShopDay: p.usualShopDay,
          shopIntervalDays: p.shopIntervalDays,
          takeawayPerWeek: p.takeawayPerWeek,
        }}
      />
    </div>
  );
}
