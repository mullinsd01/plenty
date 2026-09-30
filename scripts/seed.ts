/**
 * Demo household seed.
 *
 *   npm run db:seed
 *
 * Rather than inserting finished-looking rows, this simulates ~9 weeks of a
 * real household through Plenty's actual logic:
 *   receipt text → parser → normaliser → inventory
 *   → day-by-day consumption (with noise, waste and forgotten check-ins)
 *   → consumption events → learned stats → run-out predictions
 *   → meal preferences → a live meal plan → an inventory-aware shopping list.
 * The most recent receipt is left "ready to check" after going through the
 * real OCR pipeline, so you can try the confirm flow.
 *
 * Sign in with demo@plenty.app / plenty-demo (or "Explore the demo household").
 */
import { loadEnvConfig } from "@next/env";
import { readFile } from "node:fs/promises";
import path from "node:path";

loadEnvConfig(process.cwd());

const DEMO_EMAIL = "demo@plenty.app";
const DEMO_PASSWORD = "plenty-demo";
const TZ = "Australia/Sydney";
const WEEKS = 9;
const DAY = 86_400_000;

/** Deterministic PRNG so the demo is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const rand = rng(20260930);
const jitter = (spread: number) => 1 + (rand() * 2 - 1) * spread;

interface Purchase {
  /** Catalog slug the simulation expects the receipt line to resolve to. */
  slug: string;
  /** How it's printed on the receipt. */
  text: string;
  price: number;
  /** Printed count (repeated lines are how most receipts show multiples). */
  count?: number;
}

/** How the household actually behaves with each product (the "truth" Plenty must learn). */
interface Behaviour {
  /** Base units per day for the whole household (AE ≈ 2.6). */
  rate?: number;
  /** Fraction actually used before it's thrown out (for waste-prone items). */
  useFraction?: number;
  /** Used up for meals within this many days of purchase. */
  mealWithinDays?: number;
}

const BEHAVIOUR: Record<string, Behaviour> = {
  "full-cream-milk": { rate: 900 }, // ml/day
  "white-bread": { rate: 0.38 }, // loaves/day
  eggs: { rate: 1.3 },
  banana: { rate: 1.1 },
  apple: { rate: 0.8 },
  "greek-yoghurt": { rate: 120 },
  "cheddar-cheese": { rate: 38 },
  butter: { rate: 16 },
  "ground-coffee": { rate: 22 },
  "orange-juice": { rate: 280 },
  "baby-spinach": { useFraction: 0.5 },
  "cos-lettuce": { useFraction: 0.6 },
  "chicken-breast": { mealWithinDays: 2 },
  "beef-mince": { mealWithinDays: 2 },
  "salmon-fillets": { mealWithinDays: 1 },
  "red-capsicum": { mealWithinDays: 4 },
  broccoli: { mealWithinDays: 4 },
  "brown-onion": { mealWithinDays: 9 },
  carrot: { mealWithinDays: 8 },
  "cherry-tomatoes": { mealWithinDays: 4 },
  "toilet-paper": { rate: 0.45 },
};

function weeklyShop(week: number): Purchase[] {
  const base: Purchase[] = [
    { slug: "full-cream-milk", text: "WW FULL CREAM MILK 2L", price: 3.1, count: 2 },
    { slug: "white-bread", text: "WW WHITE SANDWICH BREAD 700G", price: 2.7, count: 2 },
    { slug: "eggs", text: "WW FREE RANGE EGGS 12PK 700G", price: 5.8 },
    { slug: "banana", text: "BANANAS CAVENDISH EA", price: 0.62, count: 7 },
    { slug: "greek-yoghurt", text: "CHOBANI GREEK YOGHURT 907G", price: 7.5 },
    { slug: "baby-spinach", text: "WW BABY SPINACH 120G", price: 3.5 },
    { slug: "chicken-breast", text: "WW RSPCA CHICKEN BREAST FILLET 500G", price: 8.0 },
    { slug: "red-capsicum", text: "CAPSICUM RED EA", price: 1.9 },
    { slug: "broccoli", text: "BROCCOLI EA", price: 2.4 },
    { slug: "cherry-tomatoes", text: "WW CHERRY TOMATOES 250G PUNNET", price: 3.5 },
  ];
  if (week % 2 === 0) {
    base.push(
      { slug: "apple", text: "APPLES PINK LADY EA", price: 0.9, count: 6 },
      { slug: "beef-mince", text: "WW 3 STAR BEEF MINCE 500G", price: 7.0 },
      { slug: "cheddar-cheese", text: "WW TASTY CHEESE BLOCK 500G", price: 7.0 },
      { slug: "brown-onion", text: "ONIONS BROWN EA", price: 0.6, count: 3 },
    );
  } else {
    base.push(
      { slug: "salmon-fillets", text: "WW TAS SALMON FILLETS 2PK 240G", price: 11.0 },
      { slug: "carrot", text: "CARROTS EA", price: 0.5, count: 4 },
      { slug: "cos-lettuce", text: "LETTUCE COS EA", price: 2.9 },
      { slug: "orange-juice", text: "WW ORANGE JUICE NO ADDED SUGAR 2L", price: 4.5 },
    );
  }
  if (week % 3 === 0) base.push({ slug: "butter", text: "WW BUTTER SALTED 250G", price: 4.2 });
  if (week % 3 === 1) base.push({ slug: "ground-coffee", text: "VITTORIA ESPRESSO GROUND COFFEE 200G", price: 9.0 });
  if (week % 4 === 0) base.push({ slug: "toilet-paper", text: "QUILTON TOILET TISSUE 3PLY 12PK", price: 9.5 });
  if (week % 4 === 2) base.push({ slug: "spaghetti", text: "BARILLA SPAGHETTI NO5 500G", price: 2.9 }, { slug: "passata", text: "MUTTI PASSATA 700G", price: 3.3 });
  if (week % 5 === 1) base.push({ slug: "basmati-rice", text: "SUNRICE BASMATI RICE 1KG", price: 5.0 }, { slug: "soy-sauce", text: "KIKKOMAN SOY SAUCE 250ML", price: 4.2 });
  return base;
}

function midweekTopUp(week: number): Purchase[] {
  const top: Purchase[] = [{ slug: "full-cream-milk", text: "CC FULL CREAM MILK 2L", price: 3.1 }];
  if (week % 2 === 1) top.push({ slug: "white-bread", text: "CC WHITE BREAD 650G", price: 2.6 });
  if (week % 3 === 2) top.push({ slug: "banana", text: "BANANAS PER KG", price: 3.9 });
  return top;
}

function money(n: number): string {
  return n.toFixed(2).padStart(8);
}

function receiptText(store: "woolworths" | "coles", date: string, purchases: Purchase[]): { text: string; total: number } {
  const [y, m, d] = date.split("-");
  const lines: string[] = [];
  if (store === "woolworths") lines.push("WOOLWORTHS", "Woolworths Surry Hills", "ABN 88 000 014 675", "TAX INVOICE");
  else lines.push("COLES", "Coles Redfern", "ABN 45 004 189 708", "TAX INVOICE");
  lines.push(`${d}/${m}/${y} 10:3${Math.floor(rand() * 9)}`, "");
  let total = 0;
  for (const p of purchases) {
    for (let i = 0; i < (p.count ?? 1); i++) {
      lines.push(`${p.text.padEnd(32).slice(0, 32)}${money(p.price)}`);
      total += p.price;
    }
  }
  total = Math.round(total * 100) / 100;
  lines.push("", `SUBTOTAL${money(total).padStart(32)}`, `TOTAL${money(total).padStart(35)}`, `EFTPOS${money(total).padStart(34)}`, "", "THANK YOU FOR SHOPPING WITH US");
  return { text: lines.join("\n"), total };
}

async function main() {
  const started = Date.now();
  const now = new Date();
  const { sql, eq, and } = await import("drizzle-orm");
  const { systemDb, withSystem, pool } = await import("../src/server/db/client");
  const schema = await import("../src/server/db/schema");
  const { syncCatalog } = await import("../src/server/services/products");
  const { syncRecipeLibrary } = await import("../src/server/services/meals");
  const { signUp } = await import("../src/server/auth/service");
  const { createHousehold, updatePreferences, completeOnboarding } = await import("../src/server/services/household");
  const { loadProductIndex } = await import("../src/server/services/products");
  const { normalizeExtraction } = await import("../src/server/services/receipts");
  const { parseReceiptText } = await import("../src/lib/receipts/parse");
  const { addItemsTx, finishItemTx } = await import("../src/server/services/inventory");
  const { refreshLearning, computeLiveState } = await import("../src/server/services/learning");
  const { toDateString, addDays, zonedDateTimeToInstant, weekdayOf } = await import("../src/lib/dates");
  const { toBaseUnit } = await import("../src/lib/units");
  const { productBase } = await import("../src/server/services/learning");
  const { getCatalogProduct } = await import("../src/lib/catalog");
  const isPerishable = (slug: string) => getCatalogProduct(slug)?.perishable ?? false;

  // ── Reset any previous demo ──────────────────────────────────────────────
  const existing = await systemDb.select().from(schema.users).where(eq(schema.users.email, DEMO_EMAIL));
  for (const u of existing) {
    const memberships = await systemDb.select().from(schema.householdMembers).where(eq(schema.householdMembers.userId, u.id));
    for (const m of memberships) await systemDb.delete(schema.households).where(eq(schema.households.id, m.householdId));
    await systemDb.delete(schema.users).where(eq(schema.users.id, u.id));
  }
  await syncCatalog();
  await syncRecipeLibrary();
  console.log("✓ Catalog and recipes up to date");

  // ── The household ────────────────────────────────────────────────────────
  const { userId } = await signUp({ name: "Alex", email: DEMO_EMAIL, password: DEMO_PASSWORD });
  await systemDb.update(schema.users).set({ isDemo: true }).where(eq(schema.users.id, userId));
  const authUser = { id: userId, email: DEMO_EMAIL, displayName: "Alex", isDemo: true, activeHouseholdId: null };
  const { householdId } = await createHousehold(authUser, { name: "The Harper household", adults: 2, children: 1, timezone: TZ, currency: "AUD" });
  await systemDb.update(schema.households).set({ isDemo: true }).where(eq(schema.households.id, householdId));
  const household = { id: householdId, name: "The Harper household", adults: 2, children: 1, currency: "AUD", timezone: TZ, onboardedAt: null, isDemo: true };
  const ctx = { user: { ...authUser, activeHouseholdId: householdId }, household, role: "owner" as const };
  await updatePreferences(ctx, {
    diets: [],
    allergies: ["peanuts"],
    dislikedIngredients: ["mushrooms"],
    favouriteCuisines: ["italian", "thai", "mexican"],
    cookingFrequency: "most_nights",
    weeknightMaxMinutes: 45,
    weeklyBudget: 230,
    preferredStores: ["Woolworths", "Coles"],
    takeawayPerWeek: 1,
  });
  await completeOnboarding(ctx);
  console.log("✓ Household created");

  // ── Simulate the last 9 weeks ────────────────────────────────────────────
  const today = toDateString(now, TZ);
  // Start on the Saturday 9 weeks back.
  let start = addDays(today, -WEEKS * 7);
  while (weekdayOf(start) !== 6) start = addDays(start, 1);

  interface Batch {
    itemId: string;
    slug: string;
    baseTotal: number;
    remaining: number;
    purchasedAt: Date;
    expiresOn: string | null;
    useLimit: number; // base units that will actually get used (waste-prone items)
    mealDay: string | null;
    reportFinish: boolean;
  }
  const batches: Batch[] = [];
  let parsedLines = 0;
  let matchedLines = 0;

  const shopDays: Array<{ date: string; store: "woolworths" | "coles"; purchases: Purchase[] }> = [];
  for (let date = start, week = 0; date < today; date = addDays(date, 1)) {
    const wd = weekdayOf(date);
    if (wd === 6) shopDays.push({ date, store: "woolworths", purchases: weeklyShop(week++) });
    else if (wd === 3 && week > 0 && rand() < 0.75) shopDays.push({ date, store: "coles", purchases: midweekTopUp(week) });
  }

  for (let day = start; day <= today; day = addDays(day, 1)) {
    const dayStart = zonedDateTimeToInstant(day, 8, TZ);
    const shop = shopDays.find((s) => s.date === day);

    // 1) Shop: build a receipt, run it through the parser + normaliser, add to the kitchen.
    if (shop) {
      const shopTime = zonedDateTimeToInstant(day, 10 + Math.floor(rand() * 4), TZ);
      const { text, total } = receiptText(shop.store, day, shop.purchases);
      const parsed = parseReceiptText(text, { today });
      await withSystem(async (tx) => {
        const index = await loadProductIndex(tx, householdId);
        const lines = normalizeExtraction(
          {
            isReceipt: true,
            legible: true,
            store: parsed.store,
            purchasedOn: parsed.purchasedOn,
            currency: "AUD",
            subtotal: parsed.subtotal,
            total: parsed.total ?? total,
            lines: parsed.lines.map((l) => ({ raw: l.description, name: null, quantity: l.quantity, weightKg: l.weightKg, unitPrice: l.unitPrice, price: l.price, isGrocery: true })),
            problems: parsed.warnings,
            rawText: text,
            ocrConfidence: null,
            provider: "local",
          },
          index,
        );
        parsedLines += lines.length;
        const [receipt] = await tx
          .insert(schema.receipts)
          .values({
            householdId,
            uploadedBy: userId,
            status: "confirmed",
            storeName: parsed.store ?? (shop.store === "woolworths" ? "Woolworths" : "Coles"),
            purchasedAt: shopTime,
            total: parsed.total ?? total,
            currency: "AUD",
            rawText: text,
            provider: "local",
            processedAt: shopTime,
            confirmedAt: shopTime,
            confirmedBy: userId,
          })
          .returning();
        for (const line of lines) {
          const [ri] = await tx
            .insert(schema.receiptItems)
            .values({
              receiptId: receipt.id,
              householdId,
              lineIndex: line.lineIndex,
              rawText: line.rawText,
              name: line.name,
              productId: line.product?.id ?? null,
              aisle: line.product?.aisle ?? "other",
              location: line.product?.location ?? "pantry",
              quantity: line.quantity,
              unit: line.unit,
              packCount: line.packCount,
              unitPrice: line.unitPrice,
              totalPrice: line.totalPrice,
              matchConfidence: Math.min(1, line.matchConfidence),
              isFood: line.isFood,
              status: line.ignoredByDefault ? "ignored" : "accepted",
            })
            .returning();
          if (line.ignoredByDefault) continue;
          const [item] = await addItemsTx(
            tx,
            household,
            userId,
            [
              {
                name: line.name,
                productId: line.product?.id ?? null,
                quantity: line.quantity,
                unit: line.unit,
                packCount: line.packCount,
                purchasedAt: shopTime,
                price: line.totalPrice,
                receiptItemId: ri.id,
              },
            ],
            "receipt",
            shopTime,
          );
          await tx.update(schema.receiptItems).set({ inventoryItemId: item.id }).where(eq(schema.receiptItems.id, ri.id));
          const product = item.productId ? index.byId.get(item.productId) : undefined;
          const slug = product?.slug ?? "";
          if (product) matchedLines += 1;
          const behaviour = BEHAVIOUR[slug] ?? {};
          const baseTotal = product ? (toBaseUnit(item.quantity, item.unit as never, productBase(product), product) ?? item.quantity) : item.quantity;
          batches.push({
            itemId: item.id,
            slug,
            baseTotal,
            remaining: baseTotal,
            purchasedAt: shopTime,
            expiresOn: item.estimatedExpiry,
            useLimit: baseTotal * (behaviour.useFraction ?? 1),
            mealDay: behaviour.mealWithinDays !== undefined ? addDays(day, Math.max(0, Math.round(behaviour.mealWithinDays * rand()))) : null,
            // The household forgets to tell Plenty about the last orange juice — Plenty should ask.
            reportFinish: !(slug === "orange-juice" && addDays(day, 10) > today),
          });
        }
      });
    }

    // 2) Consume: continuous-use products draw FIFO at the household's true (noisy) pace.
    if (day >= today) break;
    await withSystem(async (tx) => {
      const bySlug = new Map<string, Batch[]>();
      for (const b of batches) if (b.remaining > 0) bySlug.set(b.slug, [...(bySlug.get(b.slug) ?? []), b]);
      for (const [slug, list] of bySlug) {
        const behaviour = BEHAVIOUR[slug];
        if (!behaviour) {
          // Everything else perishable gets used up in meals around its date; nothing lingers for weeks.
          for (const b of list) {
            if (!b.expiresOn || day < addDays(b.expiresOn, 2)) continue;
            b.remaining = 0;
            const [row] = await tx.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, b.itemId));
            await finishItemTx(tx, household, userId, row, "consumed", {
              endedAt: zonedDateTimeToInstant(addDays(b.expiresOn, 1), 19, TZ),
              estimatedFraction: 0,
              actor: "user",
            });
          }
          continue;
        }
        if (behaviour.rate) {
          let need = behaviour.rate * jitter(0.25);
          for (const b of list.sort((a, c) => a.purchasedAt.getTime() - c.purchasedAt.getTime())) {
            if (need <= 0) break;
            if (b.purchasedAt > dayStart) continue;
            const take = Math.min(need, b.remaining);
            b.remaining -= take;
            need -= take;
            if (b.remaining <= 1e-6 && b.reportFinish) {
              const [row] = await tx.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, b.itemId));
              await finishItemTx(tx, household, userId, row, "consumed", {
                endedAt: zonedDateTimeToInstant(day, 18 + Math.floor(rand() * 4), TZ),
                estimatedFraction: 0,
                actor: "user",
              });
            }
          }
        }
        for (const b of list) {
          if (b.remaining <= 0) continue;
          // Meal ingredients get cooked within a few days of the shop.
          if (b.mealDay && b.mealDay === day) {
            b.remaining = 0;
            const [row] = await tx.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, b.itemId));
            await finishItemTx(tx, household, userId, row, "consumed", { endedAt: zonedDateTimeToInstant(day, 19, TZ), estimatedFraction: 0, actor: "meal" });
            continue;
          }
          // Continuous-use food that outlasts its date (a few too many bananas) is thrown out.
          if (behaviour.rate && b.expiresOn && day >= addDays(b.expiresOn, 2) && b.remaining > 0 && isPerishable(slug)) {
            const wasted = b.remaining / b.baseTotal;
            b.remaining = 0;
            const [row] = await tx.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, b.itemId));
            await finishItemTx(tx, household, userId, row, wasted > 0.05 ? "wasted" : "consumed", {
              endedAt: zonedDateTimeToInstant(addDays(b.expiresOn, 1), 20, TZ),
              estimatedFraction: wasted,
              actor: "user",
            });
            continue;
          }
          // Waste-prone greens: some used, the rest goes off at expiry.
          if (behaviour.useFraction !== undefined && b.expiresOn && day >= addDays(b.expiresOn, 1)) {
            const wasted = Math.max(0, b.baseTotal - b.useLimit) / b.baseTotal;
            b.remaining = 0;
            const [row] = await tx.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, b.itemId));
            await finishItemTx(tx, household, userId, row, wasted > 0.05 ? "wasted" : "consumed", {
              endedAt: zonedDateTimeToInstant(day, 20, TZ),
              estimatedFraction: wasted,
              actor: "user",
            });
          }
        }
      }
    });
  }
  console.log(`✓ Simulated ${WEEKS} weeks: ${shopDays.length} shops, ${matchedLines}/${parsedLines} receipt lines matched to products`);

  // A couple of level corrections the household made along the way.
  await withSystem(async (tx) => {
    const active = await tx
      .select()
      .from(schema.inventoryItems)
      .where(and(eq(schema.inventoryItems.householdId, householdId), eq(schema.inventoryItems.status, "active")));
    const cheese = active.find((i) => i.name.toLowerCase().includes("cheese"));
    if (cheese) {
      await tx
        .update(schema.inventoryItems)
        .set({ remainingFraction: 0.5, levelUpdatedAt: new Date(now.getTime() - 2 * DAY) })
        .where(eq(schema.inventoryItems.id, cheese.id));
    }
    // Pantry basics that are already in the cupboard.
    await addItemsTx(
      tx,
      household,
      userId,
      [
        { name: "Olive oil", quantity: 750, unit: "ml", remainingFraction: 0.6, purchasedAt: new Date(now.getTime() - 30 * DAY) },
        { name: "Jasmine rice", quantity: 2, unit: "kg", remainingFraction: 0.7, purchasedAt: new Date(now.getTime() - 25 * DAY) },
        { name: "Garlic", quantity: 3, unit: "each", purchasedAt: new Date(now.getTime() - 4 * DAY) },
        { name: "Frozen peas", quantity: 1, unit: "kg", remainingFraction: 0.5, purchasedAt: new Date(now.getTime() - 40 * DAY) },
        { name: "Coconut milk", quantity: 2, unit: "can", purchasedAt: new Date(now.getTime() - 20 * DAY) },
        { name: "Red curry paste", quantity: 1, unit: "jar", purchasedAt: new Date(now.getTime() - 20 * DAY) },
        { name: "Penne", quantity: 500, unit: "g", purchasedAt: new Date(now.getTime() - 15 * DAY) },
        { name: "Diced tomatoes", quantity: 2, unit: "can", purchasedAt: new Date(now.getTime() - 15 * DAY) },
        { name: "Chicken stock", quantity: 1, unit: "l", purchasedAt: new Date(now.getTime() - 15 * DAY) },
        { name: "Parmesan", quantity: 200, unit: "g", remainingFraction: 0.5, purchasedAt: new Date(now.getTime() - 18 * DAY) },
        { name: "Dishwashing liquid", quantity: 1, unit: "bottle", remainingFraction: 0.4, purchasedAt: new Date(now.getTime() - 35 * DAY) },
      ],
      "manual",
      now,
    );
    const productIds = (await tx.select({ id: schema.inventoryItems.productId }).from(schema.inventoryItems).where(eq(schema.inventoryItems.householdId, householdId)))
      .map((r) => r.id)
      .filter((id): id is string => Boolean(id));
    await refreshLearning(tx, household, Array.from(new Set(productIds)), now);
  });
  console.log("✓ Learned consumption patterns");

  // ── Meal history: favourites, a dislike and repeated rejections ──────────
  await withSystem(async (tx) => {
    const library = await tx.select().from(schema.meals).where(sql`${schema.meals.householdId} is null`);
    const pick = (re: RegExp) => library.find((m) => re.test(m.name.toLowerCase()));
    const prefs: Array<{ re: RegExp; rating: number; saved?: boolean; cooked?: number; rejected?: number }> = [
      { re: /bolognese/, rating: 1, saved: true, cooked: 4 },
      { re: /stir[- ]?fry/, rating: 1, cooked: 3 },
      { re: /taco/, rating: 1, saved: true, cooked: 3 },
      { re: /green curry|red curry|thai/, rating: 1, cooked: 2 },
      { re: /risotto/, rating: -1, rejected: 2 },
      { re: /fish|barramundi|snapper/, rating: 0, rejected: 3 },
    ];
    for (const p of prefs) {
      const meal = pick(p.re);
      if (!meal) continue;
      await tx
        .insert(schema.mealPreferences)
        .values({
          householdId,
          mealId: meal.id,
          rating: p.rating,
          saved: p.saved ?? false,
          timesCooked: p.cooked ?? 0,
          timesPlanned: (p.cooked ?? 0) + (p.rejected ?? 0),
          timesRejected: p.rejected ?? 0,
          lastCookedAt: p.cooked ? new Date(now.getTime() - (5 + Math.floor(rand() * 20)) * DAY) : null,
          lastRejectedAt: p.rejected ? new Date(now.getTime() - 10 * DAY) : null,
        })
        .onConflictDoNothing();
    }
  });

  // ── This week's plan and list, computed live ─────────────────────────────
  const { generateMealPlan } = await import("../src/server/services/meals");
  const { addManualItem, syncShoppingList } = await import("../src/server/services/shopping");
  const { generateNotificationsForHousehold } = await import("../src/server/services/notification-jobs");
  const { withUser } = await import("../src/server/db/client");
  try {
    const r = await generateMealPlan(ctx, "week");
    console.log(`✓ Planned ${r.planned} dinners`);
  } catch (err) {
    console.warn("! Meal plan skipped:", err instanceof Error ? err.message : err);
  }
  await addManualItem(ctx, { name: "Birthday candles" });
  await addManualItem(ctx, { name: "Lemons", quantity: 3 });
  await withUser(userId, (tx) => syncShoppingList(tx, household, now));
  await withSystem((tx) => generateNotificationsForHousehold(tx, household, now));

  // ── One receipt waiting for review, read by the real OCR pipeline ────────
  const sample = path.join(process.cwd(), "public/demo/receipts/coles-topup.png");
  try {
    const bytes = await readFile(sample);
    const { createReceiptFromUpload, processReceipt } = await import("../src/server/services/receipts");
    const up = await createReceiptFromUpload(ctx, { bytes, size: bytes.length }, { allowDuplicate: true });
    await processReceipt(userId, household, up.receiptId);
    const [r] = await systemDb.select({ status: schema.receipts.status }).from(schema.receipts).where(eq(schema.receipts.id, up.receiptId));
    console.log(`✓ Sample receipt read on-device → ${r?.status}`);
  } catch (err) {
    console.warn("! Sample receipt skipped:", err instanceof Error ? err.message : err);
  }

  const live = await withSystem((tx) => computeLiveState(tx, household, now));
  const soon = [...live.predictions.values()].sort((a, b) => a.prediction.daysRemaining - b.prediction.daysRemaining).slice(0, 5);
  console.log("  Running low:", soon.map((p) => `${p.product.name} (${p.prediction.label}, ${p.prediction.basis})`).join(" · "));
  console.log(`\n✓ Demo ready in ${Math.round((Date.now() - started) / 1000)}s — sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  const { terminateOcrWorker } = await import("../src/server/receipts/ocr");
  await terminateOcrWorker();
  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ Seed failed:", err);
    process.exit(1);
  });
