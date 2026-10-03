import { describe, expect, it } from "vitest";
import { CAPABILITIES, can, isRestricted, refusalMessage, ROLES } from "@/lib/members/permissions";
import { feedsHouseholdPattern, HOUSEHOLD_SCOPE, isPrivateScope, learningKey, learningScopeOf, scopeOf, scopeOwner } from "@/lib/members/scope";
import { shoppingItemKey } from "@/lib/shopping/keys";
import { reconcileShoppingList } from "@/lib/shopping/reconcile";
import { computeShoppingNeeds } from "@/lib/shopping/needs";
import type { ExistingListItem, PredictionInput, ShoppingNeed } from "@/lib/meals/types";

const ALEX = "11111111-1111-4111-8111-111111111111";
const JORDAN = "22222222-2222-4222-8222-222222222222";

describe("learning scopes", () => {
  it("household items have no owner scope", () => {
    expect(scopeOf({ ownerMemberId: null, visibility: "household" })).toBe(HOUSEHOLD_SCOPE);
  });

  it("a person's shared and private items have their own scopes", () => {
    expect(scopeOf({ ownerMemberId: ALEX, visibility: "household" })).toBe(`member:${ALEX}`);
    expect(scopeOf({ ownerMemberId: ALEX, visibility: "private" })).toBe(`private:${ALEX}`);
  });

  it("without individual patterns shared items feed one household pattern, but private ones never do", () => {
    expect(learningScopeOf({ ownerMemberId: ALEX, visibility: "household" }, false)).toBe(HOUSEHOLD_SCOPE);
    expect(learningScopeOf({ ownerMemberId: ALEX, visibility: "household" }, true)).toBe(`member:${ALEX}`);
    expect(learningScopeOf({ ownerMemberId: ALEX, visibility: "private" }, false)).toBe(`private:${ALEX}`);
    expect(feedsHouseholdPattern(`private:${ALEX}`, false)).toBe(false);
    expect(feedsHouseholdPattern(`private:${ALEX}`, true)).toBe(false);
    expect(feedsHouseholdPattern(`member:${ALEX}`, false)).toBe(true);
    expect(feedsHouseholdPattern(`member:${ALEX}`, true)).toBe(false);
    expect(feedsHouseholdPattern(HOUSEHOLD_SCOPE, true)).toBe(true);
  });

  it("reads the owner and privacy back out of a scope", () => {
    expect(scopeOwner(`member:${JORDAN}`)).toBe(JORDAN);
    expect(scopeOwner(`private:${JORDAN}`)).toBe(JORDAN);
    expect(scopeOwner(HOUSEHOLD_SCOPE)).toBeNull();
    expect(scopeOwner("member:")).toBeNull();
    expect(isPrivateScope(`private:${JORDAN}`)).toBe(true);
    expect(isPrivateScope(`member:${JORDAN}`)).toBe(false);
    expect(learningKey("p1", HOUSEHOLD_SCOPE)).not.toBe(learningKey("p1", `member:${ALEX}`));
  });
});

describe("roles", () => {
  it("children see and ask, owners run the household, members do everyday things", () => {
    expect(can("child", "make_requests")).toBe(true);
    expect(can("child", "edit_own_items")).toBe(true);
    for (const cap of ["edit_shopping_list", "complete_shop", "scan_receipts", "view_receipts_and_prices", "plan_meals", "change_settings", "manage_members", "manage_billing", "delete_household"] as const) {
      expect(can("child", cap)).toBe(false);
    }
    expect(can("member", "edit_shopping_list")).toBe(true);
    expect(can("member", "manage_members")).toBe(false);
    expect(can("member", "manage_billing")).toBe(false);
    for (const cap of CAPABILITIES) expect(can("owner", cap)).toBe(true);
  });

  it("only the child role is restricted, and every refusal reads like a person wrote it", () => {
    expect(ROLES.filter(isRestricted)).toEqual(["child"]);
    for (const cap of CAPABILITIES) {
      const message = refusalMessage(cap);
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toMatch(/undefined|_|Error/);
    }
  });
});

describe("shopping lines per person", () => {
  it("gives each person's version of the same product its own key", () => {
    const base = { productId: "p-pepsi", name: "Pepsi Max" };
    const household = shoppingItemKey(base);
    const alex = shoppingItemKey({ ...base, scope: `member:${ALEX}` });
    const jordan = shoppingItemKey({ ...base, scope: `member:${JORDAN}` });
    expect(household).toBe("p:p-pepsi");
    expect(new Set([household, alex, jordan]).size).toBe(3);
    expect(shoppingItemKey({ ...base, scope: HOUSEHOLD_SCOPE })).toBe(household);
    expect(shoppingItemKey({ productId: null, name: "Tomatoes", scope: `member:${ALEX}` })).toBe(`n:tomato@member:${ALEX}`);
  });

  const prediction = (scope: string, ownerMemberId: string | null): PredictionInput => ({
    productId: "p-pepsi",
    itemKey: shoppingItemKey({ productId: "p-pepsi", name: "Pepsi Max", scope }),
    scope,
    ownerMemberId,
    name: "Pepsi Max",
    aisle: "drinks",
    daysRemaining: 1,
    daysLow: 0,
    daysHigh: 2,
    confidence: "medium",
    basis: "history",
    dailyRate: 1,
    baseUnit: "each",
  });

  it("suggests Pepsi Max for each person who is running out, on their own line, and not for the one who isn't", () => {
    const needs = computeShoppingNeeds({
      predictions: [prediction(`member:${ALEX}`, ALEX), { ...prediction(`member:${JORDAN}`, JORDAN), daysRemaining: 40, daysLow: 30, daysHigh: 50 }],
      planMissing: [],
      staples: [],
      products: new Map(),
      waste: new Map(),
      horizonDays: 7,
      now: new Date("2026-10-03T00:00:00Z"),
    });
    expect(needs).toHaveLength(1);
    expect(needs[0].ownerMemberId).toBe(ALEX);
    expect(needs[0].visibility).toBe("household");
    expect(needs[0].itemKey).toBe(`p:p-pepsi@member:${ALEX}`);
  });

  it("keeps a private pattern's suggestion private", () => {
    const needs = computeShoppingNeeds({
      predictions: [prediction(`private:${ALEX}`, ALEX)],
      planMissing: [],
      staples: [],
      products: new Map(),
      waste: new Map(),
      horizonDays: 7,
      now: new Date("2026-10-03T00:00:00Z"),
    });
    expect(needs[0].visibility).toBe("private");
  });

  const line = (over: Partial<ExistingListItem>): ExistingListItem => ({
    id: "l1",
    itemKey: "n:oat milk",
    productId: null,
    name: "Oat milk",
    aisle: "dairy",
    quantity: null,
    unit: null,
    suggestedQuantity: null,
    suggestedUnit: null,
    source: "manual",
    userEdited: false,
    checkedAt: null,
    dismissedUntil: null,
    purchasedAt: null,
    ...over,
  });
  const need: ShoppingNeed = {
    itemKey: "n:oat milk",
    productId: null,
    name: "Oat milk",
    aisle: "dairy",
    quantity: 1,
    unit: "l",
    sources: [{ source: "predicted", quantity: 1, unit: "l", note: "Likely to run out in 2 days" }],
    primarySource: "predicted",
    reason: "Likely to run out in 2 days",
  };

  it("never removes or rewrites what a person asked for, however Plenty's reasoning changes", () => {
    for (const source of ["manual", "request", "recurring"] as const) {
      const none = reconcileShoppingList([line({ source })], [], new Date());
      expect(none.remove).toEqual([]);
      const some = reconcileShoppingList([line({ source, suggestedQuantity: 3 })], [need], new Date());
      expect(some.update[0].source).toBe(source);
      expect(some.update[0].suggestedQuantity).toBe(3);
    }
  });

  it("still tidies up its own suggestions when they're no longer needed", () => {
    expect(reconcileShoppingList([line({ source: "predicted" })], [], new Date()).remove).toEqual(["l1"]);
    expect(reconcileShoppingList([line({ source: "predicted", userEdited: true })], [], new Date()).remove).toEqual([]);
  });
});
