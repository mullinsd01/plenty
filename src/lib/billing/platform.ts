/**
 * Which kind of client is asking, so the plan page only offers a way of paying
 * that the platform allows.
 *
 * The App Store and Google Play require their own purchase systems for digital
 * subscriptions bought inside an app, and restrict steering people to other
 * ways of paying. So inside the iOS and Android shells Plenty shows no web
 * checkout, no billing-portal link and no price-comparison text: it shows the
 * store's purchase sheet (started by the native shell) and the store's own
 * subscription settings. On the web, Stripe is the way to pay.
 *
 * The native shells identify themselves with the `X-Plenty-Platform` header
 * (`ios` or `android`), or a `PlentyApp/<version> (ios|android)` token in the
 * user agent. Anything else is the web. This is a presentation rule, not a
 * security boundary: the server routes enforce the same rule (see service.ts),
 * and a household's plan is never decided by the client's platform.
 */

export const CLIENT_PLATFORMS = ["web", "ios", "android"] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

export function isNativePlatform(platform: ClientPlatform): boolean {
  return platform !== "web";
}

export function detectPlatform(headers: { get(name: string): string | null }): ClientPlatform {
  const declared = headers.get("x-plenty-platform")?.trim().toLowerCase();
  if (declared === "ios" || declared === "android") return declared;
  const match = /PlentyApp\/\S+\s*\((ios|android)\)/i.exec(headers.get("user-agent") ?? "");
  return match ? (match[1].toLowerCase() as ClientPlatform) : "web";
}

/** The store that sells subscriptions on a platform. */
export function storeFor(platform: ClientPlatform): "apple" | "google" | null {
  return platform === "ios" ? "apple" : platform === "android" ? "google" : null;
}
