import Link from "next/link";
import { Sparkles } from "lucide-react";
import { PLANS, type PlanId } from "@/lib/billing/plans";
import { cn } from "@/lib/cn";
import { planPageHref, type PaywallFeature } from "@/lib/billing/paywall";

/**
 * A quiet, honest "this is part of a paid plan" note. It says what is limited and which
 * plan includes it, links to the plan page, and never stops anything that already works.
 */
export function UpgradeNote({
  plan,
  feature,
  children,
  className,
}: {
  /** The cheapest plan that includes the feature. */
  plan: PlanId;
  /** Which feature this is about (the `paywall_viewed` vocabulary), so the plan page knows where the visit began. */
  feature?: PaywallFeature;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-2.5 rounded-xl bg-brand-soft/60 px-3.5 py-3 text-[13px] text-ink-2", className)}>
      <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0 text-brand-ink" />
      <p className="min-w-0">
        {children}{" "}
        <PaywallLink feature={feature} className="font-semibold text-brand-ink underline-offset-2 hover:underline">
          See {PLANS[plan].name}
        </PaywallLink>
      </p>
    </div>
  );
}

/** A link to the plan page that remembers which feature sent the person there. */
export function PaywallLink({ feature, className, children }: { feature?: PaywallFeature; className?: string; children: React.ReactNode }) {
  return (
    <Link href={planPageHref(feature)} className={className}>
      {children}
    </Link>
  );
}
