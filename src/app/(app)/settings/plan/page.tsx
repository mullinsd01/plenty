import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { SectionTitle } from "@/components/ui/card";
import { CheckoutReturnNotice, CurrentPlanCard, RestoreCard, UsageCard } from "@/features/billing/plan-sections";
import { PlanComparison } from "@/features/billing/plan-comparison";
import { TrackPaywallView } from "@/features/billing/track-paywall";
import { paywallPlanFor, parsePaywallFeature } from "@/lib/billing/paywall";
import { buildComparison } from "@/lib/billing/plan-view";
import { detectPlatform } from "@/lib/billing/platform";
import { isRestricted } from "@/lib/members/permissions";
import { requireHousehold } from "@/server/auth/context";
import { loadPlanPage } from "@/server/billing/plan-page";

export const metadata: Metadata = { title: "Plan & billing" };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function PlanPage({ searchParams }: PageProps<"/settings/plan">) {
  const ctx = await requireHousehold();
  // Children don't see prices or plan management.
  if (isRestricted(ctx.role)) redirect("/settings");

  const sp = await searchParams;
  const platform = detectPlatform(await headers());
  const { overview, checkout, disclosures } = await loadPlanPage(ctx, {
    platform,
    checkout: first(sp.checkout),
    sessionId: first(sp.session_id),
  });
  const comparison = buildComparison(overview, disclosures);
  const from = parsePaywallFeature(sp.from);

  return (
    <div className="mx-auto max-w-4xl animate-fade-in space-y-6">
      <PageHeader
        back={{ href: "/settings", label: "Settings" }}
        title="Plan & billing"
        subtitle={`${ctx.household.name} · ${overview.planName}`}
      />
      {from && <TrackPaywallView feature={from} plan={paywallPlanFor(from, ctx.plan.plan)} />}
      {checkout && <CheckoutReturnNotice checkout={checkout} />}
      <CurrentPlanCard overview={overview} />
      <UsageCard overview={overview} />
      <section aria-labelledby="plans-heading">
        <SectionTitle id="plans-heading">Plans</SectionTitle>
        <PlanComparison model={comparison} />
        <p className="mt-4 text-[13px] text-ink-3">
          Subscriptions renew automatically until cancelled. See the{" "}
          <Link href="/terms" className="font-medium text-ink underline underline-offset-2">
            Terms of Use
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="font-medium text-ink underline underline-offset-2">
            Privacy Policy
          </Link>
          .
        </p>
      </section>
      <RestoreCard overview={overview} />
    </div>
  );
}
