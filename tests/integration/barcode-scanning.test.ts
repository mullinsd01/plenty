import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { gs1CheckDigit, parseBarcode } from "@/lib/barcode";
import { pool, systemDb, withUser } from "@/server/db/client";
import { householdMembers, inventoryItems, productBarcodes } from "@/server/db/schema";
import { buildHouseholdContext } from "@/server/auth/build-context";
import type { HouseholdContext } from "@/server/auth/context";
import { addItems } from "@/server/services/inventory";
import { addScannedItem, lookupBarcode, LOOKUPS_PER_WINDOW, type BarcodeDeps } from "@/server/services/barcodes";
import { makeHousehold } from "../helpers/db";

let n = 0;
/** A valid GTIN-13 that no other test uses. */
function newCode(): string {
  n += 1;
  const body = `930633${String(Date.now() % 1_000_000).padStart(6, "0").slice(0, 5)}${n % 10}`.slice(0, 12);
  return `${body}${gs1CheckDigit(body)}`;
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const offProduct = (name: string, extra: Record<string, unknown> = {}) =>
  json({ status: 1, status_verbose: "product found", product: { product_name: name, brands: "Zorblax", quantity: "400 g", ...extra } });

/** A fetch that records every call and answers from a queue (the last answer repeats). */
function fakeFetch(...answers: Array<() => Response>) {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (url) => {
    calls.push(String(url));
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    return answer();
  };
  return { fetch: fetchFn, calls };
}
const online = (f: ReturnType<typeof fakeFetch>): BarcodeDeps => ({ fetch: f.fetch, mode: "openfoodfacts" });

async function activeItemCount(ctx: HouseholdContext): Promise<number> {
  const rows = await systemDb
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.householdId, ctx.household.id), isNull(inventoryItems.deletedAt)));
  return rows.length;
}

async function addChildAccount(home: HouseholdContext): Promise<HouseholdContext> {
  const other = await makeHousehold({ plan: "plus" });
  await systemDb.insert(householdMembers).values({ householdId: home.household.id, userId: other.user.id, role: "child" });
  return (await buildHouseholdContext(other.user, home.household.id))!;
}

describe("barcode scanning", () => {
  let a: HouseholdContext;
  let b: HouseholdContext;
  let free: HouseholdContext;

  beforeAll(async () => {
    a = await makeHousehold({ name: "Scanners A", plan: "plus" });
    b = await makeHousehold({ name: "Scanners B", plan: "plus" });
    free = await makeHousehold({ name: "Free household", plan: "free" });
  });
  afterAll(async () => {
    await pool.end();
  });

  describe("plans", () => {
    it("Free can't scan, is told it's part of Plenty Plus, and can still add by hand", async () => {
      const code = newCode();
      const lookup = await lookupBarcode(free, code).then(() => null, (e: Error) => e);
      expect(lookup?.message).toMatch(/Barcode scanning is part of Plenty Plus/);
      await expect(lookup).toMatchObject({ code: "plan_limit" });
      await expect(addScannedItem(free, { barcode: code, name: "Milk", productId: null, packCount: 1, location: "fridge" })).rejects.toMatchObject({ code: "plan_limit" });
      expect(await activeItemCount(free)).toBe(0);
      await expect(addItems(free, [{ name: "Milk" }])).resolves.toHaveLength(1);
      expect(await activeItemCount(free)).toBe(1);
    });

    it("Plus can scan", async () => {
      const proposal = await lookupBarcode(a, newCode(), undefined, { mode: "off" });
      expect(proposal.status).toBe("unavailable");
    });
  });

  describe("validation", () => {
    it("refuses junk and mistyped numbers before looking anything up", async () => {
      const f = fakeFetch(offProduct("Anything"));
      for (const bad of ["", "abc", "123", "9300633603340", "'; drop table product_barcodes;--", "../../etc/passwd", "1".repeat(200), null, 42]) {
        await expect(lookupBarcode(a, bad, undefined, online(f)), String(bad)).rejects.toMatchObject({ code: "validation" });
      }
      expect(f.calls).toHaveLength(0);
    });

    it("refuses shop-printed labels with an explanation", async () => {
      const body = "200000012345";
      await expect(lookupBarcode(a, `${body}${gs1CheckDigit(body)}`)).rejects.toThrow(/shop's own label/);
    });
  });

  describe("lookup", () => {
    it("never adds anything from a lookup alone", async () => {
      const before = await activeItemCount(a);
      const f = fakeFetch(offProduct("Zorblax Quinoa Crunchies"));
      const proposal = await lookupBarcode(a, newCode(), undefined, online(f));
      expect(proposal).toMatchObject({ status: "found", source: "openfoodfacts" });
      expect(await activeItemCount(a)).toBe(before);
    });

    it("sends only the barcode to a fixed host, and maps a catalogue product with a confidence", async () => {
      const code = newCode();
      const f = fakeFetch(offProduct("Full Cream Milk", { brands: "Pauls", quantity: "2 L" }));
      const p = await lookupBarcode(a, code, undefined, online(f));
      expect(f.calls).toHaveLength(1);
      const url = new URL(f.calls[0]);
      expect(url.hostname).toBe("world.openfoodfacts.org");
      expect(url.pathname).toBe(`/api/v2/product/${code}.json`);
      expect(p.status).toBe("found");
      expect(p.productId).not.toBeNull();
      expect(["confident", "likely"]).toContain(p.match);
      expect(p.packLabel).toMatch(/^Usual pack: /);
    });

    it("offers the public name as a new product when nothing in the catalogue fits", async () => {
      const p = await lookupBarcode(a, newCode(), undefined, online(fakeFetch(offProduct("Xylo Wobblers Zorblax Edition"))));
      expect(p).toMatchObject({ status: "found", match: "none", productId: null });
      expect(p.name).toContain("Xylo Wobblers");
      expect(p.sizeText).toBe("400 g");
    });

    it("caches positive and negative answers for everyone, and the cache holds public data only", async () => {
      const hit = newCode();
      const miss = newCode();
      const f = fakeFetch(offProduct("Zorblax Oat Rings"), json({ status: 0, status_verbose: "product not found" }, 404));
      await lookupBarcode(a, hit, undefined, online(f));
      await lookupBarcode(a, hit, undefined, online(f));
      await lookupBarcode(b, hit, undefined, online(f)); // another household: served from the shared cache
      expect(f.calls).toHaveLength(1);
      const missA = await lookupBarcode(a, miss, undefined, online(f));
      const missB = await lookupBarcode(b, miss, undefined, online(f));
      expect(f.calls).toHaveLength(2);
      expect(missA).toMatchObject({ status: "unknown" });
      expect(missB).toMatchObject({ status: "unknown" });
      expect(missA.notice).toMatch(/Name it and Plenty will remember it/);
      const rows = await systemDb.select().from(productBarcodes).where(eq(productBarcodes.barcode, hit));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ householdId: null, source: "openfoodfacts" });
    });

    it("asks again once a cached answer is stale", async () => {
      const code = newCode();
      const f = fakeFetch(offProduct("Zorblax Stale Snacks"));
      const now = new Date();
      await lookupBarcode(a, code, undefined, { ...online(f), now });
      await lookupBarcode(a, code, undefined, { ...online(f), now: new Date(now.getTime() + 31 * 86_400_000) });
      expect(f.calls).toHaveLength(2);
    });

    it("says it couldn't look it up when offline or blocked, and doesn't cache that", async () => {
      const code = newCode();
      const down = fakeFetch(() => {
        throw new TypeError("fetch failed");
      });
      const p = await lookupBarcode(a, code, undefined, online(down));
      expect(p).toMatchObject({ status: "unavailable", name: "" });
      expect(p.notice).toBe("Couldn't look that up right now. Name it and Plenty will remember it.");
      const blocked = await lookupBarcode(a, code, undefined, online(fakeFetch(() => new Response("no", { status: 403, headers: { "content-type": "text/plain" } }))));
      expect(blocked.status).toBe("unavailable");
      expect(await systemDb.select().from(productBarcodes).where(eq(productBarcodes.barcode, code))).toHaveLength(0);
      // Back online: it just works.
      const back = await lookupBarcode(a, code, undefined, online(fakeFetch(offProduct("Zorblax Back Online"))));
      expect(back.status).toBe("found");
    });

    it("with BARCODE_LOOKUP off, never touches the network", async () => {
      const f = fakeFetch(offProduct("Never"));
      const p = await lookupBarcode(a, newCode(), undefined, { fetch: f.fetch, mode: "off" });
      expect(p.status).toBe("unavailable");
      expect(f.calls).toHaveLength(0);
    });

    it("limits how often one person can look things up", async () => {
      const limited = await makeHousehold({ plan: "plus" });
      await systemDb.execute(sql`insert into rate_limits (key, window_start, count) values (${`barcode-lookup:${limited.user.id}`}, now(), ${LOOKUPS_PER_WINDOW + 5})`);
      await expect(lookupBarcode(limited, newCode(), undefined, { mode: "off" })).rejects.toMatchObject({ code: "rate_limited" });
    });
  });

  describe("confirming, remembering and correcting", () => {
    it("adds only on confirm, with source barcode, then remembers so the next scan is instant", async () => {
      const code = newCode();
      const f = fakeFetch(offProduct("Zorblax Crunchy Granola", { quantity: "500 g" }));
      const proposal = await lookupBarcode(a, code, undefined, online(f));
      const before = await activeItemCount(a);

      const result = await addScannedItem(a, {
        barcode: code,
        name: proposal.name,
        productId: proposal.productId,
        packCount: 2,
        location: "pantry",
        brand: proposal.brand,
        sizeText: proposal.sizeText,
        quantity: 500,
        unit: "g",
      });
      expect(result.remembered).toBe(true);
      expect(await activeItemCount(a)).toBe(before + 1);
      const [item] = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.id, result.itemId));
      expect(item).toMatchObject({ source: "barcode", householdId: a.household.id, quantity: 1000, unit: "g", packCount: 2, location: "pantry", ownerMemberId: null });

      const again = await lookupBarcode(a, code, undefined, online(f));
      expect(f.calls).toHaveLength(1);
      expect(again).toMatchObject({ status: "remembered", source: "household", productId: item.productId, name: proposal.name, match: "confident" });
    });

    it("a correction replaces the mapping", async () => {
      const code = newCode();
      const first = await addScannedItem(a, { barcode: code, name: "Mystery tin", productId: null, packCount: 1, location: "cupboard" });
      expect(first.remembered).toBe(true);
      const second = await addScannedItem(a, { barcode: code, name: "Chickpeas", productId: null, packCount: 1, location: "cupboard" });
      expect(second.remembered).toBe(true);
      const rows = await systemDb.select().from(productBarcodes).where(and(eq(productBarcodes.barcode, code), eq(productBarcodes.householdId, a.household.id)));
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("Chickpeas");
      const p = await lookupBarcode(a, code, undefined, { mode: "off" });
      expect(p).toMatchObject({ status: "remembered", name: "Chickpeas" });
    });

    it("can be told not to remember", async () => {
      const code = newCode();
      const r = await addScannedItem(a, { barcode: code, name: "One-off thing", productId: null, packCount: 1, location: "pantry", remember: false });
      expect(r.remembered).toBe(false);
      expect(await systemDb.select().from(productBarcodes).where(eq(productBarcodes.barcode, code))).toHaveLength(0);
    });

    it("accepts the same barcode in every written form and stores one key", async () => {
      const upcA = "012345678905";
      expect(parseBarcode(upcA)).toMatchObject({ ok: true, barcode: { gtin: "0012345678905" } });
      await addScannedItem(a, { barcode: upcA, name: "UPC thing", productId: null, packCount: 1, location: "pantry" });
      const viaEan = await lookupBarcode(a, "0012345678905", undefined, { mode: "off" });
      expect(viaEan).toMatchObject({ status: "remembered", name: "UPC thing" });
    });

    it("refuses a product that belongs to another household", async () => {
      const [bItem] = await addItems(b, [{ name: "Zorblax private custom food" }]);
      const [{ productId }] = await systemDb.select({ productId: inventoryItems.productId }).from(inventoryItems).where(eq(inventoryItems.id, bItem));
      expect(productId).not.toBeNull();
      await expect(addScannedItem(a, { barcode: newCode(), name: "Sneaky", productId, packCount: 1, location: "pantry" })).rejects.toThrow(/isn't available/);
    });

    it("rejects a bad barcode or an empty name when confirming", async () => {
      await expect(addScannedItem(a, { barcode: "123", name: "X", productId: null, packCount: 1, location: "pantry" })).rejects.toMatchObject({ code: "validation" });
      await expect(addScannedItem(a, { barcode: newCode(), name: "   ", productId: null, packCount: 1, location: "pantry" })).rejects.toMatchObject({ code: "validation" });
    });

    it("respects the kitchen's size limit", async () => {
      const tight = { ...a, plan: { ...a.plan, entitlements: { ...a.plan.entitlements, max_inventory_items: (await activeItemCount(a)) + 1 } } };
      await expect(addScannedItem(tight, { barcode: newCode(), name: "Fits", productId: null, packCount: 1, location: "pantry" })).resolves.toBeTruthy();
      await expect(addScannedItem(tight, { barcode: newCode(), name: "One too many", productId: null, packCount: 1, location: "pantry" })).rejects.toMatchObject({ code: "plan_limit" });
    });
  });

  describe("people", () => {
    it("lets an adult scan something in for another member, and keeps it theirs", async () => {
      const kid = await (await import("@/server/services/members")).addManagedMember(a, { name: "Sam", role: "child" });
      const r = await addScannedItem(a, { barcode: newCode(), name: "Sam's yoghurt", productId: null, packCount: 1, location: "fridge", ownerMemberId: kid.id });
      const [item] = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.id, r.itemId));
      expect(item.ownerMemberId).toBe(kid.id);
    });

    it("a child can only add their own items, and can't change what the household remembers", async () => {
      const child = await addChildAccount(a);
      const kid = await (await import("@/server/services/members")).addManagedMember(a, { name: "Alex", role: "member" });
      await expect(addScannedItem(child, { barcode: newCode(), name: "For Alex", productId: null, packCount: 1, location: "pantry", ownerMemberId: kid.id })).rejects.toMatchObject({ code: "forbidden" });

      const code = newCode();
      const r = await addScannedItem(child, { barcode: code, name: "Kid snack", productId: null, packCount: 1, location: "pantry" });
      expect(r.remembered).toBe(false);
      const [item] = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.id, r.itemId));
      expect(item.ownerMemberId).toBe(child.member.id);
      expect(await systemDb.select().from(productBarcodes).where(eq(productBarcodes.barcode, code))).toHaveLength(0);
      // Children can still look things up.
      await expect(lookupBarcode(child, code, undefined, { mode: "off" })).resolves.toMatchObject({ status: "unavailable" });
    });
  });

  describe("household isolation of mappings", () => {
    it("one household's remembered barcode is invisible to another", async () => {
      const code = newCode();
      await addScannedItem(a, { barcode: code, name: "A's secret sauce", productId: null, packCount: 1, location: "pantry" });
      const asB = await lookupBarcode(b, code, undefined, { mode: "off" });
      expect(asB.status).toBe("unavailable");
      expect(JSON.stringify(asB)).not.toContain("secret sauce");
      const peek = await withUser(b.user.id, (tx) => tx.select().from(productBarcodes).where(eq(productBarcodes.barcode, code)));
      expect(peek).toHaveLength(0);
      const peekByHousehold = await withUser(b.user.id, (tx) => tx.select().from(productBarcodes).where(eq(productBarcodes.householdId, a.household.id)));
      expect(peekByHousehold).toHaveLength(0);
    });

    it("the database refuses writes into another household's mappings, and to the shared cache", async () => {
      const code = newCode();
      await addScannedItem(a, { barcode: code, name: "A's thing", productId: null, packCount: 1, location: "pantry" });
      await expect(
        withUser(b.user.id, (tx) => tx.insert(productBarcodes).values({ barcode: newCode(), householdId: a.household.id, name: "Planted", source: "household" })),
      ).rejects.toThrow();
      await expect(
        withUser(b.user.id, (tx) => tx.insert(productBarcodes).values({ barcode: newCode(), householdId: null, name: "Planted in the shared cache", source: "openfoodfacts" })),
      ).rejects.toThrow();
      const changed = await withUser(b.user.id, (tx) => tx.update(productBarcodes).set({ name: "Hacked" }).where(eq(productBarcodes.barcode, code)).returning());
      expect(changed).toHaveLength(0);
      const deleted = await withUser(b.user.id, (tx) => tx.delete(productBarcodes).where(eq(productBarcodes.barcode, code)).returning());
      expect(deleted).toHaveLength(0);
      const [still] = await systemDb.select().from(productBarcodes).where(eq(productBarcodes.barcode, code));
      expect(still.name).toBe("A's thing");
    });
  });
});
