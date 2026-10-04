/**
 * The plan page's data function against a real database. Run ONLY against the isolated database:
 *   TEST_DATABASE_URL=postgres://plenty:plenty@localhost:5432/plenty_test_billing npx vitest run tests/integration/billing-plan-page.test.ts
 *
 * Stripe is never contacted: the checkout session lookup is replaced at the module boundary and every
 * payload is SYNTHETIC (tests/helpers/billing-fixtures.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { buildHouseholdContext, type HouseholdContext } from "@/server/auth/build-context";
import { grantPlan } from "@/server/billing/providers/manual";
import { loadPlanPage } from "@/server/billing/plan-page";
import { buildComparison, planAction } from "@/lib/billing/plan-view";
import { pool, systemDb } from "@/server/db/client";
import { householdMembers, subscriptions } from "@/server/db/schema";
import { acceptInvitation, createInvitation } from "@/server/services/household";
import { STRIPE_PRICES, stripeSubscription } from "../helpers/billing-fixtures";
import { makeHousehold } from "../helpers/db";

const mocks = vi.hoisted(() => ({ session: null as unknown, retrieved: 0 }));

vi.mock("@/server/billing/providers/stripe", async (importActual) => {
  const actual = await importActual<typeof import("@/server/billing/providers/stripe")>();
  return {
    ...actual,
    retrieveCheckoutSession: async () => {
      mocks.retrieved += 1;
      return mocks.session;
    },
  };
});

process.env.APP_URL = "https://plenty.test";
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic_plan_page";
process.env.STRIPE_PRICES = Object.entries(STRIPE_PRICES)
  .map(([key, id]) => `${key}=${id}`)
  .join(",");
process.env.BILLING_ACCOUNT_SECRET = "p".repeat(48);
process.env.GOOGLE_PLAY_PACKAGE_NAME = "app.plenty.test";
process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "play@plenty-test.iam.gserviceaccount.com",
  private_key: "synthetic-not-a-key",
});
process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT = "pubsub-push@plenty-test.iam.gserviceaccount.com";
delete process.env.PLAN_OVERRIDE;

const DAY = 86_400_000;
const from = (days: number) => new Date(Date.now() + days * DAY);
const fresh = () => makeHousehold({ plan: "free" });
const refresh = async (ctx: HouseholdContext) => (await buildHouseholdContext(ctx.user, ctx.household.id))!;
const web = { provider: "web" as const, providerCustomerId: "cus_plan_page" };

let seq = 0;
async function setSubscription(ctx: HouseholdContext, values: Partial<typeof subscriptions.$inferInsert>) {
  await systemDb.delete(subscriptions).where(eq(subscriptions.householdId, ctx.household.id));
  await systemDb
    .insert(subscriptions)
    .values({
      householdId: ctx.household.id,
      status: "active",
      ...web,
      providerSubscriptionId: `sub_plan_page_${process.pid}_${++seq}`,
      ...values,
    });
  return refresh(ctx);
}

beforeAll(() => {
  if (!/plenty_test/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("Refusing to run: these tests must run on a test database (plenty_test*), never a real one.");
  }
});
beforeEach(() => {
  mocks.session = null;
  mocks.retrieved = 0;
});
afterAll(async () => {
  await pool.end();
});

describe("plan page data", () => {
  it("a free household can subscribe on the web, with the terms for every option and nothing about Pro or a trial", async () => {
    const ctx = await fresh();
    const { overview, checkout, disclosures } = await loadPlanPage(ctx);
    expect(checkout).toBeNull();
    expect(overview).toMatchObject({ plan: "free", summary: "You're on the free plan.", management: null });
    expect(Object.keys(disclosures).sort()).toEqual(["family.annual", "family.monthly", "plus.annual", "plus.monthly"]);
    expect(disclosures["plus.annual"]).toMatch(/\$49\.99 a year.*renews automatically each year until you cancel.*Settings, then Plan/);
    const model = buildComparison(overview, disclosures);
    expect(model.cards[1].actions.monthly).toEqual({ kind: "checkout", plan: "plus", period: "monthly" });
    expect(model.cards[1].disclosure.monthly).toBe(disclosures["plus.monthly"]);
    expect(JSON.stringify([overview, disclosures])).not.toMatch(/free trial|\btrial\b/i);
  });

  it("shows a household over its limits after a downgrade, with the server's words and nothing removed", async () => {
    const ctx = await fresh();
    for (let i = 0; i < 6; i++)
      await systemDb.insert(householdMembers).values({ householdId: ctx.household.id, displayName: `Guest ${i + 1}` });
    const { overview } = await loadPlanPage(await refresh(ctx));
    expect(overview.plan).toBe("free");
    expect(overview.usage.members).toEqual({ used: 7, limit: 2 });
    expect(overview.overLimit.over).toBe(true);
    expect(overview.overLimit.message).toMatch(/Your household has 7 people and this plan covers 2\. Nobody is removed or hidden/);
    const members = await systemDb.select().from(householdMembers).where(eq(householdMembers.householdId, ctx.household.id));
    expect(members).toHaveLength(7);
  });

  it("an active annual Plus subscription renews, and changes go through the billing portal", async () => {
    const ctx = await setSubscription(await fresh(), { plan: "plus", period: "annual", currentPeriodEnd: from(200), autoRenew: true });
    const { overview, disclosures } = await loadPlanPage(ctx);
    expect(overview).toMatchObject({
      plan: "plus",
      reason: "active",
      period: "annual",
      priceText: "$49.99 a year",
      willRenew: true,
      needsPaymentAttention: false,
    });
    expect(overview.summary).toMatch(/^Plenty Plus renews on /);
    expect(overview.management).toMatchObject({ kind: "web_portal", canManage: true, portal: true });
    expect(planAction(overview, "family", "annual")).toMatchObject({ kind: "portal" });
    const model = buildComparison(overview, disclosures);
    expect(model.defaultPeriod).toBe("annual");
    expect(model.notice).toBe(overview.purchase.blockedReason);
    for (const c of model.cards) expect(c.disclosure).toEqual({ monthly: null, annual: null });
  });

  it("a cancelled subscription keeps its plan until the period ends and says so", async () => {
    const ctx = await setSubscription(await fresh(), {
      plan: "plus",
      period: "monthly",
      status: "canceled",
      autoRenew: false,
      currentPeriodEnd: from(12),
    });
    const { overview } = await loadPlanPage(ctx);
    expect(overview).toMatchObject({ plan: "plus", reason: "cancelled_until_period_end", willRenew: false });
    expect(overview.summary).toMatch(/is cancelled\. You keep it until .+, and it won't renew\.$/);
    expect(planAction(overview, "free", "monthly").kind).toBe("pending");
  });

  it("a failed payment in its grace period needs attention but keeps the plan", async () => {
    const ctx = await setSubscription(await fresh(), {
      plan: "plus",
      period: "monthly",
      status: "past_due",
      autoRenew: true,
      currentPeriodEnd: from(-2),
      graceEndsAt: from(5),
    });
    const { overview } = await loadPlanPage(ctx);
    expect(overview).toMatchObject({ plan: "plus", reason: "grace_period", needsPaymentAttention: true });
    expect(overview.summary).toMatch(/couldn't take your latest payment/);
  });

  it("a paused subscription is the free plan until resumed, and is fixed in the portal", async () => {
    const ctx = await setSubscription(await fresh(), { plan: "plus", period: "monthly", status: "paused", currentPeriodEnd: from(10) });
    const { overview } = await loadPlanPage(ctx);
    expect(overview).toMatchObject({ plan: "free", reason: "paused" });
    expect(overview.summary).toMatch(/is paused, so you're on the free plan/);
    expect(overview.management?.portal).toBe(true);
  });

  it("a booked downgrade shows when it starts and what is kept until then", async () => {
    const end = from(60);
    const ctx = await setSubscription(await fresh(), {
      plan: "family",
      period: "annual",
      currentPeriodEnd: end,
      autoRenew: true,
      pendingPlan: "plus",
      pendingPeriod: "annual",
    });
    const { overview } = await loadPlanPage(ctx);
    expect(overview.plan).toBe("family");
    expect(overview.pendingChange).toMatchObject({ plan: "plus", planName: "Plenty Plus" });
    expect(overview.pendingChange?.description).toMatch(/You keep Plenty Family until then\.$/);
    expect(planAction(overview, "plus", "monthly").kind).toBe("pending");
  });

  it("a manual grant is described without a billing portal or a price", async () => {
    const ctx = await fresh();
    await grantPlan({ householdId: ctx.household.id, plan: "plus", until: from(30), reason: "support grant" });
    const { overview } = await loadPlanPage(await refresh(ctx));
    expect(overview).toMatchObject({ plan: "plus", provider: "manual", priceText: null });
    expect(overview.management).toMatchObject({ kind: "operator", portal: false, url: null, label: "Plan details" });
  });

  it("inside an app there is no web checkout, no portal and no web terms, only the store and restore", async () => {
    const free = await fresh();
    const { overview, disclosures } = await loadPlanPage(free, { platform: "android" });
    expect(disclosures).toEqual({});
    expect(overview.purchase).toMatchObject({ platform: "android", canStartCheckout: false });
    expect(overview.purchase.store).toMatchObject({ provider: "google", available: true });
    const model = buildComparison(overview, disclosures);
    expect(model.cards[1].actions.monthly).toMatchObject({ kind: "store", plan: "plus", period: "monthly" });
    expect(model.cards[1].disclosure.monthly).toMatch(/Billed by Google Play/);
    expect(JSON.stringify(model)).not.toMatch(/portal|checkout/i);

    const paying = await setSubscription(await fresh(), { plan: "plus", period: "annual", currentPeriodEnd: from(100), autoRenew: true });
    const native = await loadPlanPage(paying, { platform: "ios" });
    expect(native.overview.management).toMatchObject({ portal: false, url: null, label: "Managed on the web" });
    expect(native.overview.management?.text).not.toMatch(/https?:/);
  });

  it("a store subscription links to the store's settings on the web too", async () => {
    const ctx = await setSubscription(await fresh(), {
      plan: "plus",
      period: "monthly",
      provider: "apple",
      providerCustomerId: null,
      providerProductId: "app.plenty.plus.monthly",
      currentPeriodEnd: from(20),
      autoRenew: true,
    });
    const { overview } = await loadPlanPage(ctx);
    expect(overview.management).toMatchObject({ kind: "app_store", url: "https://apps.apple.com/account/subscriptions", portal: false });
  });

  it("a member sees the plan and why they can't change it; a child is refused", async () => {
    const owner = await fresh();
    const other = await fresh();
    await acceptInvitation(other.user, (await createInvitation(owner)).code);
    const member = (await buildHouseholdContext(other.user, owner.household.id))!;
    const asMember = await loadPlanPage(member);
    expect(asMember.overview.purchase).toMatchObject({
      canStartCheckout: false,
      blockedReason: "Only a household owner can change the plan.",
    });
    expect(buildComparison(asMember.overview, asMember.disclosures).cards[1].actions.monthly).toEqual({
      kind: "text",
      text: "Only a household owner can change the plan.",
    });

    await systemDb.update(householdMembers).set({ role: "child" }).where(eq(householdMembers.userId, other.user.id));
    const child = (await buildHouseholdContext(other.user, owner.household.id))!;
    await expect(loadPlanPage(child)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("returning from checkout", () => {
  it("cancelled says nothing was charged and changes nothing", async () => {
    const { checkout, overview } = await loadPlanPage(await fresh(), { checkout: "cancelled" });
    expect(checkout).toEqual({ status: "cancelled", message: "Checkout was cancelled. Nothing was charged and your plan hasn't changed." });
    expect(overview.plan).toBe("free");
  });

  it("success confirms the purchase first, so the page already shows the new plan", async () => {
    const ctx = await fresh();
    const id = `sub_plan_page_confirm_${process.pid}`;
    mocks.session = {
      id: "cs_test_planpage123",
      mode: "subscription",
      client_reference_id: ctx.household.id,
      subscription: stripeSubscription({
        id,
        customer: "cus_plan_page_confirm",
        metadata: { household_id: ctx.household.id },
        items: {
          data: [
            {
              price: { id: STRIPE_PRICES["plus.monthly"] },
              current_period_start: Math.floor((Date.now() - DAY) / 1000),
              current_period_end: Math.floor(from(20).getTime() / 1000),
            },
          ],
        },
      }),
    };
    const { checkout, overview } = await loadPlanPage(ctx, { checkout: "success", sessionId: "cs_test_planpage123" });
    expect(mocks.retrieved).toBe(1);
    expect(overview.plan).toBe("plus");
    expect(checkout).toEqual({ status: "success", message: "Thank you. You're now on Plenty Plus." });
  });

  it("success that can't be confirmed yet says it's being confirmed, and claims nothing", async () => {
    const ctx = await fresh();
    mocks.session = {
      id: "cs_test_planpage456",
      mode: "subscription",
      client_reference_id: ctx.household.id,
      subscription: stripeSubscription({
        id: `sub_plan_page_incomplete_${process.pid}`,
        status: "incomplete",
        metadata: { household_id: ctx.household.id },
      }),
    };
    const pending = await loadPlanPage(ctx, { checkout: "success", sessionId: "cs_test_planpage456" });
    expect(pending.overview.plan).toBe("free");
    expect(pending.checkout?.status).toBe("pending");
    expect(pending.checkout?.message).toMatch(/being confirmed/);

    mocks.session = { id: "cs_test_planpage789", mode: "subscription", client_reference_id: "someone-else", subscription: null };
    const refused = await loadPlanPage(ctx, { checkout: "success", sessionId: "cs_test_planpage789" });
    expect(refused.checkout?.status).toBe("pending");
    expect(refused.overview.plan).toBe("free");
  });

  it("doesn't look up a session without one, for a member, or inside an app", async () => {
    const owner = await fresh();
    const other = await fresh();
    await acceptInvitation(other.user, (await createInvitation(owner)).code);
    const member = (await buildHouseholdContext(other.user, owner.household.id))!;
    await loadPlanPage(owner, { checkout: "success" });
    await loadPlanPage(member, { checkout: "success", sessionId: "cs_test_planpagexyz" });
    await loadPlanPage(owner, { checkout: "success", sessionId: "cs_test_planpagexyz", platform: "ios" });
    expect(mocks.retrieved).toBe(0);
  });

  it("ignores a return status it doesn't know", async () => {
    expect((await loadPlanPage(await fresh(), { checkout: "bogus" })).checkout).toBeNull();
  });
});
