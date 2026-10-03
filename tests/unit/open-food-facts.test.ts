import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanText,
  fetchOffProduct,
  interpretOffResponse,
  parseSizeText,
  OFF_HOST,
  OFF_USER_AGENT,
} from "@/server/barcodes/open-food-facts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(__dirname, "../fixtures/barcodes", `${name}.json`), "utf8"));

describe("interpretOffResponse (recorded-shape fixtures)", () => {
  it("reads a product's name, first brand and pack size", () => {
    expect(interpretOffResponse(200, fixture("off-found-hazelnut-spread"))).toEqual({
      kind: "found",
      product: { name: "Nutella", brand: "Nutella", sizeText: "400 g" },
    });
    expect(interpretOffResponse(200, fixture("off-found-milk"))).toEqual({
      kind: "found",
      product: { name: "Full Cream Milk", brand: "Pauls", sizeText: "2 L" },
    });
  });

  it("falls back to the generic name, and leaves out what's missing", () => {
    expect(interpretOffResponse(200, fixture("off-found-generic-name-only"))).toEqual({
      kind: "found",
      product: { name: "Highlighter pen", brand: null, sizeText: null },
    });
  });

  it("treats status 0 and 404 as 'not found', not as an error", () => {
    expect(interpretOffResponse(200, fixture("off-not-found"))).toEqual({ kind: "not_found" });
    expect(interpretOffResponse(404, fixture("off-not-found"))).toEqual({ kind: "not_found" });
    expect(interpretOffResponse(404, null)).toEqual({ kind: "not_found" });
  });

  it("a product with no usable name is not a result", () => {
    expect(interpretOffResponse(200, fixture("off-no-name"))).toEqual({ kind: "not_found" });
    expect(interpretOffResponse(200, fixture("off-url-as-name"))).toEqual({ kind: "not_found" });
  });

  it("cleans hostile community-edited text", () => {
    const r = interpretOffResponse(200, fixture("off-hostile"));
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.product.name).not.toMatch(/[<>\u0000​‮]/);
    expect(r.product.name).toContain("Oat");
    expect(r.product.brand ?? "").not.toMatch(/[<>]/);
    // Text that isn't a size is not kept as one, and has no markup.
    expect(r.product.sizeText ?? "").not.toMatch(/[<>]/);
  });

  it("treats servers errors and malformed bodies as unavailable", () => {
    expect(interpretOffResponse(429, null)).toEqual({ kind: "unavailable", reason: "rate_limited" });
    expect(interpretOffResponse(500, null)).toEqual({ kind: "unavailable", reason: "bad_response" });
    expect(interpretOffResponse(403, {})).toEqual({ kind: "unavailable", reason: "bad_response" });
    expect(interpretOffResponse(200, "<html>captive portal</html>")).toEqual({ kind: "unavailable", reason: "bad_response" });
    expect(interpretOffResponse(200, fixture("off-wrong-shape"))).toEqual({ kind: "unavailable", reason: "bad_response" });
    expect(interpretOffResponse(200, null)).toEqual({ kind: "unavailable", reason: "bad_response" });
  });
});

describe("cleanText and parseSizeText", () => {
  it("cleans and caps text", () => {
    expect(cleanText("  Oat ​ milk\u0000  ", 40)).toBe("Oat milk");
    expect(cleanText("a".repeat(500), 20)).toHaveLength(20);
    expect(cleanText("<b>x</b>", 20)).toBe("bx/b");
    expect(cleanText(42, 20)).toBeNull();
    expect(cleanText("   ", 20)).toBeNull();
  });

  it("reads plain weights and volumes only", () => {
    expect(parseSizeText("500 g")).toEqual({ quantity: 500, unit: "g" });
    expect(parseSizeText("1.5kg")).toEqual({ quantity: 1.5, unit: "kg" });
    expect(parseSizeText("1,5 L")).toEqual({ quantity: 1.5, unit: "l" });
    expect(parseSizeText("75 cl")).toEqual({ quantity: 750, unit: "ml" });
    expect(parseSizeText("6 x 330 ml")).toEqual({ quantity: 1980, unit: "ml" });
    expect(parseSizeText("12 slices")).toBeNull();
    expect(parseSizeText("lots")).toBeNull();
    expect(parseSizeText("0 g")).toBeNull();
    expect(parseSizeText("99999999 g")).toBeNull();
    expect(parseSizeText(null)).toBeNull();
  });
});

describe("fetchOffProduct", () => {
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

  it("asks one fixed host about one barcode, sending nothing else", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await fetchOffProduct("3017620422003", {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return json(fixture("off-found-hazelnut-spread"));
      },
    });
    expect(result.kind).toBe("found");
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe(OFF_HOST);
    expect(url.pathname).toBe("/api/v2/product/3017620422003.json");
    expect(Object.fromEntries(url.searchParams)).toEqual({ fields: expect.any(String) });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["accept", "user-agent"]);
    expect(headers["user-agent"]).toBe(OFF_USER_AGENT);
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].init.credentials).toBe("omit");
    expect(calls[0].init.body).toBeUndefined();
  });

  it("refuses anything that isn't a validated barcode, so nothing else can reach the URL", async () => {
    const never = async () => {
      throw new Error("must not be called");
    };
    for (const bad of [
      "../../admin",
      "3017620422003?x=1",
      "3017620422003/../x",
      "evil.com",
      "",
      "123",
      "１２３４５６７８",
      "1".repeat(15),
    ]) {
      await expect(fetchOffProduct(bad, { fetch: never })).rejects.toThrow(/validated barcode/);
    }
  });

  it("reports a network failure, a block and a slow answer as unavailable", async () => {
    const down = await fetchOffProduct("3017620422003", {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(down).toEqual({ kind: "unavailable", reason: "network" });
    const slow = await fetchOffProduct("3017620422003", {
      timeoutMs: 30,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    expect(slow).toEqual({ kind: "unavailable", reason: "timeout" });
    const blocked = await fetchOffProduct("3017620422003", {
      fetch: async () => new Response("denied", { status: 403, headers: { "content-type": "text/plain" } }),
    });
    expect(blocked.kind).toBe("unavailable");
  });

  it("refuses to read an oversized answer", async () => {
    const big = "x".repeat(2000);
    const declared = await fetchOffProduct("3017620422003", {
      maxBytes: 1000,
      fetch: async () =>
        json({ product: { product_name: big } }, { headers: { "content-type": "application/json", "content-length": "2048" } }),
    });
    expect(declared).toEqual({ kind: "unavailable", reason: "too_large" });
    // No content-length: stops reading once past the cap.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(big));
      },
    });
    const streamed = await fetchOffProduct("3017620422003", {
      maxBytes: 1000,
      fetch: async () => new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
    });
    expect(streamed).toEqual({ kind: "unavailable", reason: "too_large" });
  });

  it("ignores answers that aren't JSON, and treats a 404 as not found", async () => {
    const html = await fetchOffProduct("3017620422003", {
      fetch: async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(html).toEqual({ kind: "unavailable", reason: "bad_response" });
    const missing = await fetchOffProduct("3017620422003", { fetch: async () => json(fixture("off-not-found"), { status: 404 }) });
    expect(missing).toEqual({ kind: "not_found" });
    const garbage = await fetchOffProduct("3017620422003", {
      fetch: async () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
    });
    expect(garbage).toEqual({ kind: "unavailable", reason: "bad_response" });
  });
});
