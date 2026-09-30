import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { pool, systemDb, withUser } from "@/server/db/client";
import { consumptionEvents, consumptionStats, inventoryItems, predictions } from "@/server/db/schema";
import type { HouseholdContext } from "@/server/auth/context";
import { addItems, addItemsTx, answerCheckIn, finishItem, finishItemTx, getInventory, restoreItem, setLevel } from "@/server/services/inventory";
import { computeLiveState, refreshLearning } from "@/server/services/learning";
import { makeHousehold } from "../helpers/db";

const DAY = 86_400_000;

describe("inventory → consumption → learning → prediction", () => {
  let ctx: HouseholdContext;

  beforeAll(async () => {
    ctx = await makeHousehold({ adults: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("adds items with inferred product, pack size, location and expiry", async () => {
    const [id] = await addItems(ctx, [{ name: "milk" }]);
    const [row] = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.id, id));
    expect(row.productId).not.toBeNull();
    expect(row.location).toBe("fridge");
    expect(row.unit).toBe("l");
    expect(row.quantity).toBe(2);
    expect(row.estimatedExpiry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.remainingFraction).toBe(1);
  });

  it("a brand-new product predicts from Plenty's estimate, not history", async () => {
    const inv = await getInventory(ctx);
    const milk = inv.items.find((i) => i.name.toLowerCase() === "milk");
    expect(milk?.prediction?.basis).toBe("estimate");
    expect(milk?.prediction?.confidence).toBe("low");
  });

  it("finishing an item records a consumption event, and undo removes it", async () => {
    const [id] = await addItems(ctx, [{ name: "Greek yoghurt" }]);
    await finishItem(ctx, id, "consumed");
    const events = await systemDb.select().from(consumptionEvents).where(eq(consumptionEvents.inventoryItemId, id));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("consumed");
    expect(events[0].amountWastedBase).toBe(0);
    await restoreItem(ctx, id);
    const after = await systemDb.select().from(consumptionEvents).where(eq(consumptionEvents.inventoryItemId, id));
    expect(after).toHaveLength(0);
    const [row] = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.id, id));
    expect(row.status).toBe("active");
  });

  it("wasting records the thrown-out portion", async () => {
    const [id] = await addItems(ctx, [{ name: "Baby spinach" }]);
    await setLevel(ctx, id, 0.5);
    await finishItem(ctx, id, "wasted");
    const [event] = await systemDb.select().from(consumptionEvents).where(eq(consumptionEvents.inventoryItemId, id));
    expect(event.outcome).toBe("wasted");
    expect(event.amountWastedBase).toBeGreaterThan(0);
    expect(event.amountUsedBase).toBeGreaterThan(0);
  });

  it("learns the household's real pace from repeated purchases and moves from estimate to history", async () => {
    const household = { ...ctx.household };
    const now = new Date();
    // Six 2 L bottles of milk over ~5 weeks, each finished after ~3 days (faster than the default estimate).
    await withUser(ctx.user.id, async (tx) => {
      for (let i = 6; i >= 1; i--) {
        const purchasedAt = new Date(now.getTime() - i * 6 * DAY);
        const [item] = await addItemsTx(tx, household, ctx.user.id, [{ name: "Full cream milk", purchasedAt }], "receipt", purchasedAt);
        const endedAt = new Date(purchasedAt.getTime() + (3 + (i % 2) * 0.4) * DAY);
        await finishItemTx(tx, household, ctx.user.id, item, "consumed", { endedAt, estimatedFraction: 0 });
      }
      const [fresh] = await addItemsTx(tx, household, ctx.user.id, [{ name: "Full cream milk", purchasedAt: new Date(now.getTime() - 2 * DAY) }], "receipt", now);
      await refreshLearning(tx, household, [fresh.productId], now);
    });
    const [milkItem] = await systemDb
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.householdId, ctx.household.id), eq(inventoryItems.name, "Full cream milk"), eq(inventoryItems.status, "active")));
    const [stats] = await systemDb
      .select()
      .from(consumptionStats)
      .where(and(eq(consumptionStats.householdId, ctx.household.id), eq(consumptionStats.productId, milkItem.productId!)));
    expect(stats.basis).toBe("history");
    expect(stats.observations).toBeGreaterThanOrEqual(6);
    expect(["medium", "high"]).toContain(stats.confidence);
    // ~2 L per ~3.2 days ≈ 600 ml/day, well above the 2-adult prior of ~400 ml/day.
    expect(stats.dailyRate!).toBeGreaterThan(450);
    expect(stats.dailyRate!).toBeLessThan(800);

    const [pred] = await systemDb
      .select()
      .from(predictions)
      .where(and(eq(predictions.householdId, ctx.household.id), eq(predictions.productId, milkItem.productId!)));
    expect(pred).toBeDefined();
    expect(pred.basis).toBe("history");
    // Two 2 L bottles are active (the earlier "milk" + the fresh one); a couple of days left, not weeks.
    expect(pred.daysRemaining).toBeGreaterThan(0);
    expect(pred.daysRemaining).toBeLessThan(8);
  });

  it("asks 'did you finish it?' when a prediction says it's gone, and learns from the answer", async () => {
    const household = { ...ctx.household };
    const now = new Date();
    await withUser(ctx.user.id, async (tx) => {
      // Orange juice with history: finishes in ~4 days; latest bottle bought 9 days ago and never updated.
      for (let i = 4; i >= 1; i--) {
        const purchasedAt = new Date(now.getTime() - (9 + i * 5) * DAY);
        const [item] = await addItemsTx(tx, household, ctx.user.id, [{ name: "Orange juice", purchasedAt }], "receipt", purchasedAt);
        await finishItemTx(tx, household, ctx.user.id, item, "consumed", { endedAt: new Date(purchasedAt.getTime() + 4 * DAY), estimatedFraction: 0 });
      }
      const purchasedAt = new Date(now.getTime() - 9 * DAY);
      const [stale] = await addItemsTx(tx, household, ctx.user.id, [{ name: "Orange juice", purchasedAt }], "receipt", purchasedAt);
      await refreshLearning(tx, household, [stale.productId], now);
    });
    const live = await withUser(ctx.user.id, (tx) => computeLiveState(tx, ctx.household, now));
    const oj = [...live.predictions.values()].find((p) => p.product.name.toLowerCase().includes("orange juice"));
    expect(oj?.prediction.needsCheckIn).toBe(true);

    await answerCheckIn(ctx, oj!.productId, true);
    const active = await systemDb
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.householdId, ctx.household.id), eq(inventoryItems.productId, oj!.productId), eq(inventoryItems.status, "active")));
    expect(active).toHaveLength(0);
    const events = await systemDb
      .select()
      .from(consumptionEvents)
      .where(and(eq(consumptionEvents.householdId, ctx.household.id), eq(consumptionEvents.productId, oj!.productId)));
    expect(events.length).toBe(5);
    // The inferred finish time is near the predicted run-out, not "now" (which would skew learning).
    const last = events.sort((x, y) => y.endedAt.getTime() - x.endedAt.getTime())[0];
    expect(now.getTime() - last.endedAt.getTime()).toBeGreaterThan(2 * DAY);
  });

  it("rejects invalid levels", async () => {
    const [id] = await addItems(ctx, [{ name: "Butter" }]);
    await expect(setLevel(ctx, id, 1.5)).rejects.toThrow();
    await expect(setLevel(ctx, id, Number.NaN)).rejects.toThrow();
  });
});
