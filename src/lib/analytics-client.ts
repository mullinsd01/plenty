"use client";

import type { AnalyticsProps } from "@/lib/analytics-events";
import { MAX_ANALYTICS_BODY, validateClientEvent, type ClientAnalyticsEvent } from "@/lib/analytics-validate";

/**
 * Report a product event from the UI.
 *
 *   trackClient("paywall_viewed", { feature: "photo", plan: "plus" });
 *
 * Only the events in `CLIENT_ANALYTICS_EVENTS`, with only the properties
 * `ANALYTICS_PROPS` defines for them, are accepted (here and, again, on the
 * server). It is first-party: the event goes to Plenty's own `/api/analytics`,
 * which records it only for a signed-in household, only when the person
 * hasn't turned analytics off in Privacy & data, and only when the server has
 * an `ANALYTICS_SECRET` in production. Never put names, item names, receipt
 * text or anything typed by a person into the properties — they are rejected.
 *
 * Fire and forget: it never throws, never waits, and does nothing when the
 * browser says "Do Not Track" or sends the Global Privacy Control signal.
 *
 * Server-side events (receipts, items, subscriptions) use `track()` from
 * `src/server/analytics.ts` instead, from the service where the thing happens:
 *
 *   await track("receipt_confirmed", { householdId, userId, plan: ctx.plan.plan }, { lines: 12, corrected: 2 });
 */
export function trackClient(event: ClientAnalyticsEvent, props?: AnalyticsProps): void {
  try {
    if (typeof window === "undefined") return;
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (nav.doNotTrack === "1" || nav.globalPrivacyControl === true) return;
    const checked = validateClientEvent({ event, props });
    if (!checked.ok) return;
    const body = JSON.stringify({ event: checked.event, props: checked.props });
    if (body.length > MAX_ANALYTICS_BODY) return;
    void fetch("/api/analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => undefined);
  } catch {
    // Analytics never gets in the way of the app.
  }
}
