import type { BillingLink, SnapshotEvent, PaidPlanId } from "@/lib/billing/events";
import type { BillingPeriod } from "@/lib/billing/plans";

/** A store subscription as proven by the store, for linking it to a household ("restore purchases"). */
export interface StoreRestoreResult {
  provider: "apple" | "google";
  /** The store's id for the subscription: Apple's original transaction id, Google's purchase token. */
  providerSubscriptionId: string;
  providerProductId: string;
  plan: PaidPlanId;
  period: BillingPeriod;
  /** Sandbox / production / test, for the audit trail. */
  environment: string;
  /** The household the purchase was made for, when its account token says so. */
  householdHint: string | null;
  /**
   * `live`: a subscription that exists and can be linked (even one that is on
   * hold or paused: it needs to be linked to recover); `ended`: it lapsed;
   * `refunded`: the store took it back; `unsupported`: not something Plenty
   * grants (family-shared, still pending).
   */
  state: "live" | "ended" | "refunded" | "unsupported";
  /** Plain-language reason when it isn't active. */
  reason: string | null;
  /** What to apply when it's live. */
  event: SnapshotEvent | null;
  /** Google: the purchase still has to be acknowledged (once it has been linked) or Google refunds it. */
  needsAcknowledgement?: boolean;
  link: BillingLink;
}
