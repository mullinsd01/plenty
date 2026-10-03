import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { Pool } from "pg";

/**
 * The whole Plenty loop, end to end, as a real person would do it:
 * sign up → household → scan receipt → confirm → finish an item → learning
 * → meal plan → shopping list → tick off → scan the next receipt.
 */

const DB = process.env.E2E_DATABASE_URL ?? "postgres://plenty:plenty@localhost:5432/plenty_e2e";
const RECEIPTS = path.join(process.cwd(), "public/demo/receipts");
const email = `e2e-${Date.now()}@example.com`;
const password = "correct-horse-battery";

async function uploadReceipt(page: Page, file: string) {
  await page.goto("/receipts/new");
  await expect(page.getByRole("heading", { name: "Snap your receipt" })).toBeVisible();
  await page.locator('input[type="file"]:not([capture])').setInputFiles(path.join(RECEIPTS, file));
  await page.waitForURL(/\/receipts\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  // Local OCR runs in the background; the page polls and flips to the review screen.
  await expect(page.getByRole("heading", { name: "Check your receipt" })).toBeVisible({ timeout: 150_000 });
}

async function confirmReceipt(page: Page) {
  const confirm = page.getByRole("button", { name: /Add \d+ things? to kitchen/ });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await page.waitForURL(/\/kitchen$/, { timeout: 60_000 });
}

test.describe.configure({ mode: "serial" });

test("the full Plenty loop works for a brand-new household", async ({ page }) => {
  // 1. Sign up
  await page.goto("/signup");
  await page.fill("#name", "Robin");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByLabel(/I'm 18 or over/).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/onboarding$/);

  // 2. Create the household (skipping optional questions)
  await page.getByRole("button", { name: "Get started" }).click();
  await page.fill("#household-name", "Robin's place");
  await page.getByRole("button", { name: "Increase Children" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Anything Plenty should always avoid?")).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByText("You're all set.")).toBeVisible();
  await page.getByRole("button", { name: "Scan a receipt" }).click();
  await page.waitForURL(/\/receipts\/new$/);

  // 3–5. Upload a receipt, let it process, confirm the groceries
  await uploadReceipt(page, "woolworths-weekly.png");
  await expect(page.getByText(/milk/i).first()).toBeVisible();
  await confirmReceipt(page);

  // 6. The kitchen is populated
  await expect(page.getByRole("heading", { name: "Kitchen" })).toBeVisible();
  const milkRow = page.getByRole("button", { name: /milk/i }).first();
  await expect(milkRow).toBeVisible();

  // 7. Mark an item finished
  await milkRow.click();
  await page.getByRole("button", { name: "Finished" }).click();
  await expect(page.getByText(/marked finished/i)).toBeVisible();

  // 8–9. The consumption event is recorded and Plenty's learning reflects it
  await page.goto("/insights");
  await expect(page.getByRole("heading", { name: "What Plenty knows" })).toBeVisible();
  await expect(page.getByText("times you've finished something").locator("..")).toContainText("1");
  await expect(page.getByText(/milk/i).first()).toBeVisible();

  // 10. Generate a meal plan
  await page.goto("/meals");
  await page.getByRole("button", { name: "Plan my week" }).click();
  await expect(page.locator('a[href^="/meals/recipes/"]').first()).toBeVisible({ timeout: 30_000 });

  // 11. Missing ingredients land on the shopping list, with reasons
  await page.goto("/list");
  await expect(page.getByRole("heading", { name: "Shopping list" })).toBeVisible();
  await expect(page.getByText(/For \w+'s /).first()).toBeVisible();
  const checkboxes = page.getByRole("checkbox");
  expect(await checkboxes.count()).toBeGreaterThan(1);

  // 12. Tick things off in the shop
  await checkboxes.nth(0).click();
  await checkboxes.nth(1).click();
  await expect(page.getByText(/In your trolley · 2/)).toBeVisible();

  // 13. The next receipt updates the kitchen and the list
  await uploadReceipt(page, "coles-topup.png");
  await confirmReceipt(page);
  await page.goto("/receipts");
  await expect(page.getByText("In your kitchen")).toHaveCount(2);

  // The home dashboard pulls it together.
  await page.goto("/home");
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), Robin/ })).toBeVisible();
  await expect(page.getByText("Running low")).toBeVisible();
  await expect(page.getByText("Next shop")).toBeVisible();
});

test("password reset works end to end", async ({ page }) => {
  await page.goto("/forgot-password");
  await page.fill("#email", email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("Check your inbox")).toBeVisible();

  const pool = new Pool({ connectionString: DB, max: 1 });
  const { rows } = await pool.query("select text from email_outbox where \"to\" = $1 order by created_at desc limit 1", [email]);
  await pool.end();
  const link = String(rows[0]?.text ?? "").match(/https?:\/\/\S+reset-password\?token=\S+/)?.[0];
  expect(link).toBeTruthy();

  const url = new URL(link!);
  await page.goto(`${url.pathname}${url.search}`);
  await page.fill("#password", "a-brand-new-password");
  await page.fill("#confirm", "a-brand-new-password");
  await page.getByRole("button", { name: "Save new password" }).click();
  await page.waitForURL(/\/home$/);

  // Old sessions are gone; the new password works.
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", "a-brand-new-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/home$/);
});

test("protected pages redirect to sign-in", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/kitchen");
  await page.waitForURL(/\/login\?next=%2Fkitchen/);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});
