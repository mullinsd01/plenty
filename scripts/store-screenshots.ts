/**
 * App Store screenshots from the running app: real screens of the demo household (`npm run db:seed`, DEMO_MODE=true),
 * at the iPhone 6.9-inch size Apple asks for (1290 x 2796). Nothing is mocked up.
 *
 *   npm run dev            # in another terminal (or `npm start` after a build)
 *   npx tsx scripts/store-screenshots.ts [outDir] [baseUrl]
 *
 * Check the sizes against what App Store Connect currently asks for before uploading.
 * Set CHROMIUM_PATH to use a specific browser binary.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

const outDir = path.resolve(process.argv[2] ?? "store-screenshots");
const base = (process.argv[3] ?? "http://localhost:3000").replace(/\/$/, "");
mkdirSync(outDir, { recursive: true });

const VIEWPORT = { width: 430, height: 932 }; // x3 = 1290 x 2796
const RECEIPT = path.resolve("public/demo/receipts/woolworths-weekly.png");

async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(900);
}

async function main() {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "light" });
  const page = await context.newPage();
  let n = 0;
  const shot = async (name: string) => {
    await settle(page);
    n += 1;
    const file = path.join(outDir, `${String(n).padStart(2, "0")}-${name}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  };

  // The demo household is on the top plan, so every feature shows.
  await page.goto(`${base}/login`, { waitUntil: "load" });
  await page.getByRole("button", { name: /explore the demo household/i }).click();
  await page.waitForURL(/\/home/, { timeout: 60_000 });
  await shot("home");
  await page.goto(`${base}/kitchen`, { waitUntil: "load" });
  await shot("kitchen");
  await page.goto(`${base}/list`, { waitUntil: "load" });
  await shot("shopping-list");
  await page.goto(`${base}/meals`, { waitUntil: "load" });
  await shot("meals");
  await page.goto(`${base}/insights`, { waitUntil: "load" });
  await shot("what-plenty-knows");
  await page.goto(`${base}/settings/privacy`, { waitUntil: "load" });
  await shot("privacy");
  await context.clearCookies();

  // A receipt waiting to be checked needs a fresh household, so it never leaves anything in the shared demo one.
  await page.goto(`${base}/signup`, { waitUntil: "load" });
  await page.fill("#name", "Robin");
  await page.fill("#email", `screenshots-${Date.now()}@example.com`);
  await page.fill("#password", "correct-horse-battery");
  await page.getByLabel(/I'm 18 or over/).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/onboarding$/);
  await page.getByRole("button", { name: "Get started" }).click();
  await page.fill("#household-name", "Robin's place");
  await page.getByRole("button", { name: "Continue" }).click();
  for (let i = 0; i < 5; i += 1) await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Scan a receipt" }).click();
  await page.waitForURL(/\/receipts\/new$/);
  await shot("scan-a-receipt");
  await page.locator('input[type="file"]:not([capture])').setInputFiles(RECEIPT);
  await page.waitForURL(/\/receipts\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  await page.getByRole("heading", { name: "Check your receipt" }).waitFor({ timeout: 150_000 });
  await shot("check-your-receipt");

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
