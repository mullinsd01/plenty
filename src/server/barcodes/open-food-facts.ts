import "server-only";
import { z } from "zod";
import { parseUnit, type Unit } from "@/lib/units";

/**
 * Open Food Facts lookups (https://world.openfoodfacts.org, a public,
 * community-edited product database).
 *
 * What this module promises:
 *   - It only ever talks to one fixed host. The only variable part of the
 *     request is a barcode that has already passed `parseBarcode`, so there is
 *     nothing a person can steer it to (no SSRF), and redirects are refused.
 *   - It sends the barcode digits and a User-Agent that says what Plenty is,
 *     and nothing else: no account, household, cookies or other identifiers.
 *   - It gives up after a short time, reads at most a small response, and
 *     validates the JSON before using any of it. Community-edited text is
 *     cleaned (control characters, markup, length) and is only ever shown as
 *     text and offered as a suggestion.
 *   - Failing (offline, blocked, slow, odd answer) is a normal outcome:
 *     `unavailable`, never an exception.
 */

export const OFF_HOST = "world.openfoodfacts.org";
export const OFF_TIMEOUT_MS = 3000;
export const OFF_MAX_BYTES = 128 * 1024;
export const OFF_USER_AGENT = "Plenty/0.1 (household kitchen app; barcode lookup)";
const OFF_FIELDS = "code,product_name,product_name_en,generic_name,brands,quantity";

export interface OffProduct {
  name: string;
  brand: string | null;
  /** The pack size as printed ("500 g"). */
  sizeText: string | null;
}

export type OffUnavailableReason = "network" | "timeout" | "rate_limited" | "bad_response" | "too_large";

export type OffLookup =
  | { kind: "found"; product: OffProduct }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: OffUnavailableReason };

// ─── Cleaning ───────────────────────────────────────────────────────────────

/** Plain single-line text of at most `max` characters, or null when nothing usable is left. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[<>`{}\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return text || null;
}

/** A product name worth showing: has letters, isn't a link or an address. */
function plausibleName(text: string | null): text is string {
  return Boolean(text) && /\p{L}/u.test(text!) && !/https?:|www\.|@|\.(com|net|org)\b/i.test(text!);
}

// ─── Response ───────────────────────────────────────────────────────────────

const text = z.string().nullish();
const responseSchema = z.object({
  status: z.union([z.number(), z.string()]).nullish(),
  product: z
    .object({
      product_name: text,
      product_name_en: text,
      generic_name: text,
      brands: text,
      quantity: text,
    })
    .nullish(),
});

/** Turn Open Food Facts' answer into a product, "not found", or "unavailable". Pure: used with recorded fixtures in tests. */
export function interpretOffResponse(httpStatus: number, body: unknown): OffLookup {
  if (httpStatus === 429) return { kind: "unavailable", reason: "rate_limited" };
  if (httpStatus >= 500 || (httpStatus >= 400 && httpStatus !== 404)) return { kind: "unavailable", reason: "bad_response" };
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) return httpStatus === 404 ? { kind: "not_found" } : { kind: "unavailable", reason: "bad_response" };
  const { status, product } = parsed.data;
  if (httpStatus === 404 || Number(status) === 0 || !product) return { kind: "not_found" };
  const name = [product.product_name, product.product_name_en, product.generic_name].map((n) => cleanText(n, 80)).find(plausibleName);
  if (!name) return { kind: "not_found" };
  const brand = cleanText(product.brands?.split(",")[0], 40);
  const size = cleanText(product.quantity, 30);
  return {
    kind: "found",
    product: {
      name,
      brand: plausibleName(brand) ? brand : null,
      sizeText: size && /\d/.test(size) ? size : null,
    },
  };
}

// ─── Pack size ──────────────────────────────────────────────────────────────

/** "500 g", "1.5kg", "2 L", "75 cl", "6 x 330 ml" → an amount and unit, or null when it isn't a plain weight or volume. */
export function parseSizeText(size: string | null): { quantity: number; unit: Unit } | null {
  if (!size) return null;
  const m = size.toLowerCase().match(/^\s*(?:(\d{1,3})\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l|litres?|liters?)\b/);
  if (!m) return null;
  const count = m[1] ? Number(m[1]) : 1;
  let amount = Number(m[2].replace(",", ".")) * count;
  let unitText = m[3];
  if (unitText === "cl") {
    amount *= 10;
    unitText = "ml";
  }
  const unit = parseUnit(unitText);
  if (!unit || !Number.isFinite(amount) || amount <= 0 || amount > 100_000) return null;
  return { quantity: Math.round(amount * 1000) / 1000, unit };
}

// ─── Fetching ───────────────────────────────────────────────────────────────

export interface OffFetchOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Read a body but stop (and report) when it grows past `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Ask Open Food Facts about one barcode. `gtin` must already be a validated barcode (8–14 digits). */
export async function fetchOffProduct(gtin: string, options: OffFetchOptions = {}): Promise<OffLookup> {
  if (!/^[0-9]{8,14}$/.test(gtin)) throw new Error("fetchOffProduct needs a validated barcode");
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `https://${OFF_HOST}/api/v2/product/${gtin}.json?fields=${OFF_FIELDS}`;
  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: { "user-agent": OFF_USER_AGENT, accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(options.timeoutMs ?? OFF_TIMEOUT_MS),
    });
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      return interpretOffResponse(res.status, null);
    }
    if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
      await res.body?.cancel().catch(() => undefined);
      return res.status === 404 ? { kind: "not_found" } : { kind: "unavailable", reason: "bad_response" };
    }
    const raw = await readCapped(res, options.maxBytes ?? OFF_MAX_BYTES);
    if (raw === null) return { kind: "unavailable", reason: "too_large" };
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      return res.status === 404 ? { kind: "not_found" } : { kind: "unavailable", reason: "bad_response" };
    }
    return interpretOffResponse(res.status, json);
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return { kind: "unavailable", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
}
