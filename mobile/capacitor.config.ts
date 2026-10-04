/**
 * Capacitor configuration for the Plenty iOS shell.
 *
 * The shell is a thin native wrapper: a WKWebView that loads the hosted Plenty
 * site (PLENTY_URL). Everything that decides what the app is called, which
 * bundle id it has and which version it is comes from app.config.json, the one
 * place to change them (see scripts/apply-app-config.mjs for how the Xcode
 * project is kept in step).
 *
 * Nothing in this file is a secret. PLENTY_URL is read when `cap sync` runs and
 * is written into ios/App/App/capacitor.config.json (which is git-ignored).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
// The website's own `tsc` / `next build` also compiles this file (the root tsconfig includes **/*.ts) in
// checkouts where mobile/node_modules does not exist, so the missing package must not be an error there.
// Inside mobile/ (where `npm ci` has run) the import resolves and the config is fully type-checked.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TS2307 only when mobile/node_modules is absent
import type { CapacitorConfig } from "@capacitor/cli";

interface AppConfig {
  appName: string;
  bundleId: string;
  teamId: string;
  version: string;
  buildNumber: number;
}

/**
 * The token the server looks for (src/lib/billing/platform.ts, detectPlatform:
 * /PlentyApp\/\S+\s*\((ios|android)\)/i). It makes the server hide web
 * checkout inside the app. The number is the shell's protocol version, not the
 * marketing version: bump it only if the web side needs to tell shells apart.
 */
export const SHELL_USER_AGENT = "PlentyApp/1.0 (ios)";

const here = typeof __dirname === "string" ? __dirname : process.cwd();
const app = JSON.parse(readFileSync(join(here, "app.config.json"), "utf8")) as AppConfig;

function hostedSite(): URL {
  const raw = (process.env.PLENTY_URL ?? "").trim();
  if (!raw) {
    throw new Error(
      "PLENTY_URL is not set. Set it to the address of the hosted Plenty site, for example " +
        "PLENTY_URL=https://plenty.example.com (https only), then run the command again.",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PLENTY_URL is not a valid address: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`PLENTY_URL must start with https:// (the app only talks to the site over HTTPS). Got: ${raw}`);
  }
  if (url.username || url.password) {
    throw new Error("PLENTY_URL must not contain a user name or password.");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`PLENTY_URL must be the site's root address with no path, for example https://plenty.example.com. Got: ${raw}`);
  }
  return url;
}

const site = hostedSite();

const config: CapacitorConfig = {
  appId: app.bundleId,
  appName: app.appName,

  // Shown only when the hosted site cannot be reached (see www/index.html).
  webDir: "www",

  server: {
    // The hosted site. Capacitor injects its native bridge into this page, so
    // window.Capacitor.Plugins.PlentyPurchases exists for the website.
    url: site.origin,
    // The app's own host and nothing else. Every other host opens in the
    // system browser (WebViewDelegationHandler.decidePolicyFor), and
    // PlentyWebViewGuard additionally blocks other hosts from loading as
    // frames and from using the camera.
    allowNavigation: [site.hostname],
    // The local page to show when a load fails (relative to webDir).
    errorPath: "index.html",
  },

  ios: {
    // Every request and navigator.userAgent carry this token. Verified in
    // @capacitor/ios: CAPInstanceDescriptor reads `ios.appendUserAgent` and
    // CAPBridgeViewController.webViewConfiguration appends it to
    // WKWebViewConfiguration.applicationNameForUserAgent.
    appendUserAgent: SHELL_USER_AGENT,
    // The web app handles the notch and home indicator itself
    // (viewport-fit=cover and env(safe-area-inset-*)), so the scroll view must
    // not add its own insets as well.
    contentInset: "never",
    // Always phone layout, also when an iPhone app runs on an iPad.
    preferredContentMode: "mobile",
    // No peek-and-pop preview of links (a preview would load pages outside the
    // navigation rules). Text selection is not affected.
    allowsLinkPreview: false,
    // Release builds keep Safari web inspection off; debug builds turn it on.
    webContentsDebuggingEnabled: false,
    // No notification plugins: leave UNUserNotificationCenter alone.
    handleApplicationNotifications: false,
  },
};

export default config;
