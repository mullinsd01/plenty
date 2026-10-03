/**
 * Strict validation of analytics events sent from a browser or app.
 *
 * Nothing a client sends is trusted or stored as given. An event must be one
 * the browser is allowed to report, and every property must be one that event
 * defines with a value from its fixed list (or a small non-negative integer).
 * Anything else is rejected outright rather than quietly trimmed, so a bug (or
 * a person) that tries to put a name, an item or an email into analytics gets
 * an error instead of a partial record.
 */

import { ANALYTICS_PROPS, isAnalyticsEvent, type AnalyticsEvent, type AnalyticsProps } from "@/lib/analytics-events";

/**
 * Events a client may report: things only the screen can know. The rest
 * (receipts, items, subscriptions, …) are recorded by the server where they
 * happen, so a client can't invent them.
 */
export const CLIENT_ANALYTICS_EVENTS = [
  "paywall_viewed",
  "prediction_shown",
  "prediction_accepted",
  "prediction_rejected",
  "meal_suggested",
  "meal_selected",
] as const satisfies readonly AnalyticsEvent[];
export type ClientAnalyticsEvent = (typeof CLIENT_ANALYTICS_EVENTS)[number];

export function isClientAnalyticsEvent(value: unknown): value is ClientAnalyticsEvent {
  return typeof value === "string" && (CLIENT_ANALYTICS_EVENTS as readonly string[]).includes(value);
}

/** The biggest request body accepted, in characters. Real events are far smaller. */
export const MAX_ANALYTICS_BODY = 1024;

export type ClientEventResult = { ok: true; event: ClientAnalyticsEvent; props: AnalyticsProps } | { ok: false; reason: string };

/** Validate a parsed request body of the form `{ event, props? }`. */
export function validateClientEvent(body: unknown): ClientEventResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, reason: "Body must be an object." };
  const input = body as Record<string, unknown>;
  const extra = Object.keys(input).filter((k) => k !== "event" && k !== "props");
  if (extra.length > 0) return { ok: false, reason: "Unknown field." };
  const event = input.event;
  if (!isAnalyticsEvent(event) || !isClientAnalyticsEvent(event)) return { ok: false, reason: "Unknown event." };

  const rawProps = input.props ?? {};
  if (typeof rawProps !== "object" || rawProps === null || Array.isArray(rawProps)) return { ok: false, reason: "Props must be an object." };
  const allowed = ANALYTICS_PROPS[event] as Record<string, readonly string[] | number>;
  const props: AnalyticsProps = {};
  for (const [key, value] of Object.entries(rawProps)) {
    const rule = Object.hasOwn(allowed, key) ? allowed[key] : undefined;
    if (rule === undefined) return { ok: false, reason: "Unknown property." };
    if (typeof rule === "number") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > rule) return { ok: false, reason: "Invalid property value." };
    } else if (typeof value !== "string" || !rule.includes(value)) {
      return { ok: false, reason: "Invalid property value." };
    }
    props[key] = value as string | number;
  }
  return { ok: true, event, props };
}
