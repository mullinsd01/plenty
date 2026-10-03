import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { pool, systemDb } from "@/server/db/client";
import { analyticsEvents, profiles, rateLimits } from "@/server/db/schema";
import type { HouseholdContext } from "@/server/auth/context";
import { analyticsSubject, deleteAnalyticsFor, track } from "@/server/analytics";
import { ANALYTICS_RATE_LIMIT, ANALYTICS_RETENTION_DAYS, pruneAnalyticsEvents, recordClientAnalytics } from "@/server/analytics-intake";
import { setAnalyticsOptOut } from "@/server/services/privacy";
import { makeHousehold } from "../helpers/db";

const headers = (platform?: string) => ({ get: (name: string) => (name.toLowerCase() === "x-plenty-platform" && platform ? platform : null) });
const body = (event: string, props?: unknown) => JSON.stringify({ event, props });

describe("analytics intake", () => {
  let ctx: HouseholdContext;
  let other: HouseholdContext;

  beforeAll(async () => {
    ctx = await makeHousehold({ plan: "plus" });
    other = await makeHousehold({ plan: "plus" });
    // Analytics are off until someone turns them on; these two have.
    await setAnalyticsOptOut(ctx.user, false);
    await setAnalyticsOptOut(other.user, false);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await systemDb.delete(analyticsEvents);
    await systemDb.delete(rateLimits);
    await setAnalyticsOptOut(ctx.user, false);
  });

  const rows = () => systemDb.select().from(analyticsEvents);

  it("records a whitelisted client event with its plan and platform, and no one's identity", async () => {
    const res = await recordClientAnalytics(ctx, body("paywall_viewed", { feature: "photo", plan: "plus" }), headers("ios"));
    expect(res).toEqual({ status: 202, recorded: true });
    const [row] = await rows();
    expect(row).toMatchObject({ event: "paywall_viewed", plan: "plus", platform: "ios", props: JSON.stringify({ feature: "photo", plan: "plus" }) });
    expect(row.subject).toBe(analyticsSubject(ctx.household.id));
    const stored = JSON.stringify(row);
    for (const secret of [ctx.household.id, ctx.user.id, ctx.user.email, ctx.household.name]) expect(stored).not.toContain(secret);
  });

  it("rejects unknown events, unknown properties and PII-looking values, recording nothing", async () => {
    const bad: Array<[string, unknown]> = [
      ["made_up", {}],
      ["subscription_started", { plan: "plus", period: "monthly", provider: "web" }],
      ["paywall_viewed", { feature: "jane@example.com" }],
      ["paywall_viewed", { feature: "Jane Citizen" }],
      ["paywall_viewed", { name: "Jane" }],
      ["meal_selected", { surface: "Spaghetti bolognese" }],
    ];
    for (const [event, props] of bad) {
      const res = await recordClientAnalytics(ctx, body(event, props), headers());
      expect(res.status, event).toBe(400);
    }
    expect(await recordClientAnalytics(ctx, "not json", headers())).toMatchObject({ status: 400 });
    expect(await recordClientAnalytics(ctx, "x".repeat(5000), headers())).toMatchObject({ status: 413 });
    expect(await rows()).toHaveLength(0);
  });

  it("records nothing about someone who hasn't turned analytics on", async () => {
    const stranger = await makeHousehold({ plan: "plus" });
    // A new account is off by default.
    const [profile] = await systemDb.select({ o: profiles.analyticsOptOut }).from(profiles).where(eq(profiles.userId, stranger.user.id));
    expect(profile.o).toBe(true);
    const before = (await rows()).length;
    await recordClientAnalytics(stranger, body("meal_selected", { surface: "plan" }), headers());
    await track("receipt_confirmed", { householdId: stranger.household.id, userId: stranger.user.id }, { lines: 2, corrected: 0 });
    expect(await rows()).toHaveLength(before);
    // Turning it on starts recording; nothing earlier is back-filled.
    await setAnalyticsOptOut(stranger.user, false);
    await recordClientAnalytics(stranger, body("meal_selected", { surface: "plan" }), headers());
    expect(await rows()).toHaveLength(before + 1);
  });

  it("honours the person's opt-out: accepted, but nothing is recorded", async () => {
    await setAnalyticsOptOut(ctx.user, true);
    expect(await recordClientAnalytics(ctx, body("meal_selected", { surface: "plan" }), headers())).toEqual({ status: 202, recorded: true });
    expect(await rows()).toHaveLength(0);
    // Server-side events respect it too.
    await track("receipt_confirmed", { householdId: ctx.household.id, userId: ctx.user.id }, { lines: 4, corrected: 1 });
    expect(await rows()).toHaveLength(0);
    // And it's per person: someone else's events are still recorded.
    await track("receipt_confirmed", { householdId: other.household.id, userId: other.user.id }, { lines: 4, corrected: 1 });
    expect(await rows()).toHaveLength(1);
    // Turning it back on resumes.
    await setAnalyticsOptOut(ctx.user, false);
    await recordClientAnalytics(ctx, body("meal_selected", { surface: "plan" }), headers());
    expect(await rows()).toHaveLength(2);
    const [profile] = await systemDb.select({ o: profiles.analyticsOptOut }).from(profiles).where(eq(profiles.userId, ctx.user.id));
    expect(profile.o).toBe(false);
  });

  it("rate limits per person, with a friendly 429", async () => {
    for (let i = 0; i < ANALYTICS_RATE_LIMIT.limit; i++) {
      const res = await recordClientAnalytics(ctx, body("meal_selected", { surface: "plan" }), headers());
      if (res.status !== 202) throw new Error(`call ${i} was ${res.status}`);
    }
    const limited = await recordClientAnalytics(ctx, body("meal_selected", { surface: "plan" }), headers());
    expect(limited).toMatchObject({ status: 429 });
    // Someone else isn't affected.
    expect(await recordClientAnalytics(other, body("meal_selected", { surface: "plan" }), headers())).toMatchObject({ status: 202 });
  });

  it("deletes everything recorded for a household, and only that household", async () => {
    await recordClientAnalytics(ctx, body("meal_selected", { surface: "plan" }), headers());
    await recordClientAnalytics(other, body("meal_selected", { surface: "plan" }), headers());
    await deleteAnalyticsFor(ctx.household.id);
    const left = await rows();
    expect(left).toHaveLength(1);
    expect(left[0].subject).toBe(analyticsSubject(other.household.id));
  });

  it("prunes events past the retention period and nothing newer", async () => {
    const now = new Date();
    await systemDb.insert(analyticsEvents).values([
      { event: "meal_selected", subject: "old", occurredAt: new Date(now.getTime() - (ANALYTICS_RETENTION_DAYS + 1) * 86_400_000) },
      { event: "meal_selected", subject: "recent", occurredAt: new Date(now.getTime() - (ANALYTICS_RETENTION_DAYS - 1) * 86_400_000) },
    ]);
    expect(await pruneAnalyticsEvents(now)).toBe(1);
    expect((await rows()).map((r) => r.subject)).toEqual(["recent"]);
    expect(await pruneAnalyticsEvents(now)).toBe(0);
  });
});

describe("analytics is off in production without a secret", () => {
  it("makes no key, so nothing can be recorded", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANALYTICS_SECRET", undefined);
    try {
      const fresh = await import("@/server/analytics");
      expect(fresh.analyticsSubject("00000000-0000-0000-0000-000000000000")).toBeNull();
      vi.stubEnv("ANALYTICS_SECRET", "a-secret-of-at-least-16-chars");
      vi.resetModules();
      const configured = await import("@/server/analytics");
      expect(configured.analyticsSubject("00000000-0000-0000-0000-000000000000")).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
