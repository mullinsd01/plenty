/** Calls to the billing routes from the browser. Errors carry the server's plain-language message. */

export class BillingRequestError extends Error {}

const FALLBACK = "Something went wrong. Nothing has been charged. Please try again in a moment.";

/** POST to a billing route that answers `{ url }`, and return that address (https only). */
export async function postForUrl(path: "/api/billing/checkout" | "/api/billing/portal", body?: Record<string, string>): Promise<string> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      credentials: "same-origin",
    });
  } catch {
    throw new BillingRequestError("Couldn't reach Plenty. Check your connection and try again. Nothing has been charged.");
  }
  const data: unknown = await res.json().catch(() => null);
  const message = typeof (data as { error?: unknown } | null)?.error === "string" ? (data as { error: string }).error : null;
  if (!res.ok) throw new BillingRequestError(message ?? FALLBACK);
  const url = (data as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || !isHttpUrl(url)) throw new BillingRequestError(FALLBACK);
  return url;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * How a native shell (iOS / Android) is asked to check the store for purchases.
 * The shell owns the store sheet and calls `POST /api/billing/restore` itself,
 * so from the page this is only a request. Contracts the shells can implement:
 *   Android: `window.PlentyNative.restorePurchases()`   (a JavascriptInterface)
 *   iOS:     `webkit.messageHandlers.plentyRestorePurchases.postMessage({})`
 * A `plenty:restore-purchases` event is also fired on `window`.
 */
export function requestNativeRestore(): "requested" | "unavailable" {
  if (typeof window === "undefined") return "unavailable";
  const w = window as unknown as {
    PlentyNative?: { restorePurchases?: () => void };
    webkit?: { messageHandlers?: { plentyRestorePurchases?: { postMessage: (message: unknown) => void } } };
  };
  try {
    if (typeof w.PlentyNative?.restorePurchases === "function") {
      w.PlentyNative.restorePurchases();
    } else if (w.webkit?.messageHandlers?.plentyRestorePurchases) {
      w.webkit.messageHandlers.plentyRestorePurchases.postMessage({});
    } else {
      window.dispatchEvent(new CustomEvent("plenty:restore-purchases"));
      return "unavailable";
    }
    window.dispatchEvent(new CustomEvent("plenty:restore-purchases"));
    return "requested";
  } catch {
    return "unavailable";
  }
}
