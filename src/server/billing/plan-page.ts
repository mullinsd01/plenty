import "server-only";
import type { BillingPeriod } from "@/lib/billing/plans";
import { isNativePlatform, type ClientPlatform } from "@/lib/billing/platform";
import { can } from "@/lib/members/permissions";
import type { HouseholdContext } from "@/server/auth/context";
import { checkoutDisclosure } from "./providers/stripe";
import { confirmWebCheckout, getBillingOverview, type BillingOverview } from "./service";

/** Where a person lands after Stripe Checkout: what happened, in a sentence. */
export interface CheckoutReturn {
  status: "success" | "pending" | "cancelled";
  message: string;
}

export interface PlanPageData {
  overview: BillingOverview;
  checkout: CheckoutReturn | null;
  /** Web purchase disclosures by `plan.period` (price, renewal, how to cancel), shown beside each checkout button. */
  disclosures: Record<string, string>;
}

const PAID = ["plus", "family"] as const;
const PERIODS: BillingPeriod[] = ["monthly", "annual"];

export function webDisclosures(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const plan of PAID) for (const period of PERIODS) out[`${plan}.${period}`] = checkoutDisclosure(plan, period);
  return out;
}

/**
 * Everything the plan page needs in one place. On return from Checkout
 * (`?checkout=success&session_id=…`) the purchase is confirmed first, so the
 * page already shows the new plan instead of waiting for the webhook; if that
 * can't be confirmed yet the message says the payment is being confirmed
 * rather than claiming anything.
 */
export async function loadPlanPage(
  ctx: HouseholdContext,
  opts: { platform?: ClientPlatform; checkout?: string | null; sessionId?: string | null; now?: Date } = {},
): Promise<PlanPageData> {
  const platform = opts.platform ?? "web";
  const native = isNativePlatform(platform);

  let confirmed = false;
  if (opts.checkout === "success" && opts.sessionId && !native && can(ctx.role, "manage_billing")) {
    try {
      confirmed = (await confirmWebCheckout(ctx, opts.sessionId)).confirmed;
    } catch {
      // The webhook still applies the purchase; never turn a confirmation hiccup into an error page.
    }
  }

  const overview = await getBillingOverview(ctx, { platform, now: opts.now });

  let checkout: CheckoutReturn | null = null;
  if (opts.checkout === "cancelled") {
    checkout = { status: "cancelled", message: "Checkout was cancelled. Nothing was charged and your plan hasn't changed." };
  } else if (opts.checkout === "success") {
    checkout =
      confirmed && overview.plan !== "free"
        ? { status: "success", message: `Thank you. You're now on ${overview.planName}.` }
        : {
            status: "pending",
            message:
              "Thank you. Your payment is being confirmed, and your plan will update here shortly. You can refresh this page in a moment.",
          };
  }

  return { overview, checkout, disclosures: native ? {} : webDisclosures() };
}
