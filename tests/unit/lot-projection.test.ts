import { describe, expect, it } from "vitest";
import { catalogProductMap } from "@/lib/meals/adapters";
import { assessMealAvailability, projectLotToDate } from "@/lib/meals/matching";
import { computePlanRequirements } from "@/lib/meals/requirements";
import type { InventoryLot, PlannableMeal } from "@/lib/meals/types";

const products = catalogProductMap();
const TODAY = "2026-09-30";

const bread: InventoryLot = {
  id: "bread-1",
  productId: "white-bread",
  name: "White bread",
  quantity: 1,
  unit: "loaf",
  remainingFraction: 1,
  expiresOn: "2026-10-06",
  location: "pantry",
  // The household gets through a quarter of a loaf a day in sandwiches and toast.
  dailyUseFraction: 0.25,
  levelAsOf: TODAY,
};

const toastie: PlannableMeal = {
  id: "toastie",
  slug: "toastie",
  name: "Cheese toasties",
  cuisine: "australian",
  timeMinutes: 10,
  difficulty: "easy",
  servings: 2,
  mainIngredient: "bread",
  tags: [],
  contains: ["gluten"],
  ingredients: [{ name: "white bread", productId: "white-bread", quantity: 0.5, unit: "loaf", optional: false }],
  source: "user",
};

describe("everyday use between now and the meal", () => {
  it("projects a lot down to the meal date", () => {
    const { lot, routine } = projectLotToDate(bread, "2026-10-02");
    expect(lot.remainingFraction).toBeCloseTo(0.5);
    expect(routine).toBeCloseTo(0.5);
    expect(projectLotToDate(bread, TODAY).lot.remainingFraction).toBe(1);
    expect(projectLotToDate({ ...bread, dailyUseFraction: 0 }, "2026-10-05").lot.remainingFraction).toBe(1);
  });

  it("tonight's toasties have the bread, but Saturday's won't", () => {
    const tonight = assessMealAvailability(toastie, [bread], products, { servings: 2, date: TODAY });
    expect(tonight[0].status).toBe("have");
    const saturday = assessMealAvailability(toastie, [bread], products, { servings: 2, date: "2026-10-03" });
    expect(saturday[0].status).not.toBe("have");
  });

  it("across a plan, everyday use isn't subtracted twice", () => {
    // Thursday takes half a loaf from the (by then) 0.75 left; Friday's projection starts from what's
    // really left after Thursday, not from Thursday's already-projected level.
    const result = computePlanRequirements({
      items: [
        { planItemId: "thu", date: "2026-10-01", servings: 2, meal: toastie },
        { planItemId: "fri", date: "2026-10-02", servings: 2, meal: { ...toastie, id: "toastie-2" } },
      ],
      lots: [bread],
      products,
    });
    expect(result.meals[0].allAvailable).toBe(true);
    // 1 − 0.5 (Thursday) − 0.5 (two days of everyday use) = 0 left for Friday.
    expect(result.meals[1].allAvailable).toBe(false);
    expect(result.missing.some((m) => m.productId === "white-bread")).toBe(true);
  });
});
