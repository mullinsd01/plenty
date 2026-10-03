"use client";

import { useEffect, useRef } from "react";
import { trackClient } from "@/lib/analytics-client";
import type { PaywallFeature } from "@/lib/billing/paywall";

/** Records that the plan page was opened from a paid-feature note, once per visit. Renders nothing. */
export function TrackPaywallView({ feature, plan }: { feature: PaywallFeature; plan: "plus" | "family" }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    trackClient("paywall_viewed", { feature, plan });
  }, [feature, plan]);
  return null;
}
