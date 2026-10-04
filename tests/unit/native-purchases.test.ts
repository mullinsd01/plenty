import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buyFromStore, loadStoreProducts, purchasesPlugin, restoreFromStore } from "@/features/billing/native-purchases";

type Plugin = {
  products: ReturnType<typeof vi.fn>;
  purchase: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
};

function installApp(plugin: Plugin | null) {
  vi.stubGlobal("window", { Capacitor: plugin ? { Plugins: { PlentyPurchases: plugin } } : undefined });
}

/** A fake of Plenty's two billing routes. `restoreReplies` are consumed in order; an `Error` becomes a 4xx with its message. */
function installServer(restoreReplies: Array<{ outcome: string; message: string } | Error> = []) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(init.body) : undefined });
      if (path === "/api/billing/account-token") return Response.json({ token: "11111111-2222-3333-4444-555555555555" });
      const reply = restoreReplies.shift();
      if (reply instanceof Error) return Response.json({ error: reply.message }, { status: 409 });
      return Response.json(reply ?? { outcome: "linked", message: "Plenty Plus is now part of your household." });
    }),
  );
  return calls;
}

let plugin: Plugin;
beforeEach(() => {
  plugin = { products: vi.fn(), purchase: vi.fn(), restore: vi.fn() };
});
afterEach(() => vi.unstubAllGlobals());

describe("the purchase plugin", () => {
  it("is absent in a plain browser", () => {
    installApp(null);
    expect(purchasesPlugin()).toBeNull();
  });

  it("gives back Apple's own prices, and nothing when the app can't say", async () => {
    installApp(plugin);
    plugin.products.mockResolvedValue({ products: [{ productId: "plus.monthly", displayName: "Plus", displayPrice: "A$7.99", period: "monthly" }] });
    expect(await loadStoreProducts(["plus.monthly"])).toEqual([expect.objectContaining({ displayPrice: "A$7.99" })]);
    plugin.products.mockRejectedValue(new Error("no store"));
    expect(await loadStoreProducts(["plus.monthly"])).toEqual([]);
    installApp(null);
    expect(await loadStoreProducts(["plus.monthly"])).toEqual([]);
  });
});

describe("subscribing in the app", () => {
  it("tags the purchase with the household's token, then has Plenty verify what Apple returned", async () => {
    installApp(plugin);
    const calls = installServer();
    plugin.purchase.mockResolvedValue({ status: "purchased", signedTransaction: "jws.transaction.value-long-enough", signedRenewalInfo: "jws.renewal" });
    const result = await buyFromStore("family.annual");
    expect(plugin.purchase).toHaveBeenCalledWith({ productId: "family.annual", appAccountToken: "11111111-2222-3333-4444-555555555555" });
    expect(calls.map((c) => c.path)).toEqual(["/api/billing/account-token", "/api/billing/restore"]);
    expect(calls[1].body).toEqual({ provider: "apple", signedTransaction: "jws.transaction.value-long-enough", signedRenewalInfo: "jws.renewal" });
    expect(result).toEqual({ kind: "linked", message: "Plenty Plus is now part of your household." });
  });

  it("treats cancelling as nothing happening: no server call, no error", async () => {
    installApp(plugin);
    const calls = installServer();
    plugin.purchase.mockResolvedValue({ status: "cancelled" });
    expect(await buyFromStore("plus.monthly")).toEqual({ kind: "cancelled" });
    expect(calls.map((c) => c.path)).toEqual(["/api/billing/account-token"]);
  });

  it("says plainly when it's waiting for approval (Ask to Buy)", async () => {
    installApp(plugin);
    installServer();
    plugin.purchase.mockResolvedValue({ status: "pending" });
    const result = await buyFromStore("plus.monthly");
    expect(result.kind).toBe("pending");
    expect(result.kind === "pending" && result.message).toMatch(/approval/i);
  });

  it("never loses a payment: if Apple took it but linking failed, it says to restore and that nobody is charged twice", async () => {
    installApp(plugin);
    installServer([new Error("temporary")]);
    plugin.purchase.mockResolvedValue({ status: "purchased", signedTransaction: "jws.transaction.value-long-enough" });
    const result = await buyFromStore("plus.monthly");
    expect(result.kind).toBe("unlinked");
    expect(result.kind === "unlinked" && result.message).toMatch(/Restore purchases.*charged again/s);
  });

  it("turns a plugin failure into a plain message that says nothing was charged", async () => {
    installApp(plugin);
    installServer();
    plugin.purchase.mockRejectedValue(new Error("StoreKitError.unknown"));
    await expect(buyFromStore("plus.monthly")).rejects.toThrow(/Nothing has been charged/);
    await expect(buyFromStore("plus.monthly")).rejects.not.toThrow(/StoreKit/);
  });

  it("explains itself outside the app instead of failing silently", async () => {
    installApp(null);
    installServer();
    await expect(buyFromStore("plus.monthly")).rejects.toThrow(/Open Plenty on your iPhone/);
  });
});

describe("restoring", () => {
  it("reports nothing found without calling Plenty", async () => {
    installApp(plugin);
    const calls = installServer();
    plugin.restore.mockResolvedValue({ transactions: [] });
    expect((await restoreFromStore()).outcome).toBe("nothing_to_restore");
    expect(calls).toHaveLength(0);
  });

  it("tries each entitlement until one links, and uses Plenty's own words", async () => {
    installApp(plugin);
    const calls = installServer([new Error("That subscription already belongs to another household."), { outcome: "linked", message: "Plenty Family is now part of your household." }]);
    plugin.restore.mockResolvedValue({ transactions: [{ signedTransaction: "jws.one.long-enough-value" }, { signedTransaction: "jws.two.long-enough-value" }] });
    expect(await restoreFromStore()).toEqual({ outcome: "linked", message: "Plenty Family is now part of your household." });
    expect(calls).toHaveLength(2);
  });

  it("surfaces the refusal when none can be linked", async () => {
    installApp(plugin);
    installServer([new Error("That subscription already belongs to another household.")]);
    plugin.restore.mockResolvedValue({ transactions: [{ signedTransaction: "jws.one.long-enough-value" }] });
    await expect(restoreFromStore()).rejects.toThrow(/already belongs to another household/);
  });
});
