/**
 * The first-run nudge ("teach Plenty your rhythm": scan your last few shops) and the Plus preview shown to a
 * household without predictions: what Plenty can already see, as names only, with nothing stored or listed.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { pool, systemDb } from "@/server/db/client";
import { predictions, receipts, shoppingListItems } from "@/server/db/schema";
import type { HouseholdContext } from "@/server/auth/context";
import { TEACH_RECEIPTS_TARGET, getDashboard } from "@/server/services/dashboard";
import { addItems } from "@/server/services/inventory";
import { makeHousehold } from "../helpers/db";

const DAY = 86_400_000;

async function withMilkBoughtSixDaysAgo(ctx: HouseholdContext) {
  await addItems(ctx, [{ name: "Full cream milk", purchasedAt: new Date(Date.now() - 6 * DAY) }]);
}

afterAll(async () => {
  await pool.end();
});

describe("the Plus preview on a plan without predictions", () => {
  it("names what Plenty can already see running out, and stores and lists nothing", async () => {
    const free = await makeHousehold({ name: "Preview free", plan: "free" });
    await withMilkBoughtSixDaysAgo(free);
    const home = await getDashboard(free);
    expect(home.predictionPreview).not.toBeNull();
    expect(home.predictionPreview!.names.join(" ").toLowerCase()).toContain("milk");
    expect(home.predictionPreview!.count).toBeGreaterThanOrEqual(1);
    // The plan's limits are exactly as they were: no stored prediction, no suggested line, no running-low entry.
    expect(await systemDb.select().from(predictions).where(eq(predictions.householdId, free.household.id))).toHaveLength(0);
    expect(await systemDb.select().from(shoppingListItems).where(eq(shoppingListItems.householdId, free.household.id))).toHaveLength(0);
    expect(home.runningLow.filter((r) => r.source === "prediction")).toHaveLength(0);
  });

  it("is absent when there's nothing to say, for a plan that already has predictions, and for a child", async () => {
    const empty = await makeHousehold({ name: "Preview empty", plan: "free" });
    expect((await getDashboard(empty)).predictionPreview).toBeNull();

    const plus = await makeHousehold({ name: "Preview plus", plan: "plus" });
    await withMilkBoughtSixDaysAgo(plus);
    expect((await getDashboard(plus)).predictionPreview).toBeNull();

    const free = await makeHousehold({ name: "Preview child", plan: "free" });
    await withMilkBoughtSixDaysAgo(free);
    expect((await getDashboard({ ...free, role: "child" })).predictionPreview).toBeNull();
  });

  it("shows only a few names, never more than three", async () => {
    const free = await makeHousehold({ name: "Preview many", plan: "free" });
    const bought = new Date(Date.now() - 6 * DAY);
    await addItems(free, ["Full cream milk", "White bread", "Eggs", "Natural yoghurt", "Baby spinach"].map((name) => ({ name, purchasedAt: bought })));
    const preview = (await getDashboard(free)).predictionPreview!;
    expect(preview.names.length).toBeLessThanOrEqual(3);
    expect(preview.count).toBeGreaterThanOrEqual(preview.names.length);
  });
});

describe("teach Plenty your rhythm", () => {
  it("counts confirmed shops towards the number the learning engine needs, then goes away", async () => {
    expect(TEACH_RECEIPTS_TARGET).toBe(3);
    const ctx = await makeHousehold({ name: "Teach progress", plan: "family" });
    expect((await getDashboard(ctx)).learningProgress).toEqual({ receipts: 0, target: 3 });
    const shop = (daysAgo: number, status: "confirmed" | "needs_review" = "confirmed") =>
      systemDb.insert(receipts).values({ householdId: ctx.household.id, uploadedBy: ctx.user.id, status, storeName: "Shop", purchasedAt: new Date(Date.now() - daysAgo * DAY) });
    await shop(21);
    await shop(14, "needs_review"); // a receipt still being checked isn't a shop yet
    expect((await getDashboard(ctx)).learningProgress).toEqual({ receipts: 1, target: 3 });
    await shop(14);
    await shop(7);
    expect((await getDashboard(ctx)).learningProgress).toBeNull();
  });

  it("isn't shown to a child, who can't scan receipts", async () => {
    const ctx = await makeHousehold({ name: "Teach child", plan: "family" });
    expect((await getDashboard({ ...ctx, role: "child" })).learningProgress).toBeNull();
  });
});
