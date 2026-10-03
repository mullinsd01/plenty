import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// An AI service is "set up" for these tests; the providers themselves are fakes that record whether they were called.
const calls = vi.hoisted(() => {
  process.env.AI_PROVIDER = "auto";
  process.env.ANTHROPIC_API_KEY = "sk-test-not-a-real-key";
  return { external: [] as string[], local: [] as string[] };
});

vi.mock("@/server/ai/anthropic", async () => {
  const { parseReceiptText } = await import("@/lib/receipts/parse");
  const { readFileSync } = await import("node:fs");
  const pathMod = await import("node:path");
  const text = readFileSync(pathMod.resolve(process.cwd(), "tests/fixtures/receipts/woolworths-weekly.txt"), "utf8");
  return {
    AnthropicProvider: class {
      readonly id = "anthropic" as const;
      readonly label = "Claude";
      async extractReceipt(input: { image: Buffer }) {
        calls.external.push(`receipt:${input.image.length > 0 ? "photo" : "empty"}`);
        const parsed = parseReceiptText(text, { today: "2026-09-30" });
        const lines = parsed.lines.map((l, i) => ({
          raw: i === 0 ? `${l.description} jane@example.com` : l.description,
          name: null,
          quantity: l.quantity,
          weightKg: l.weightKg,
          unitPrice: l.unitPrice,
          price: l.price,
          isGrocery: true,
        }));
        return { isReceipt: true, legible: true, store: "Woolworths Metro Town Hall, Shop 3, 480 Kent St", purchasedOn: parsed.purchasedOn, currency: "AUD", subtotal: parsed.subtotal, total: parsed.total, lines, problems: [], rawText: lines.map((l) => l.raw).join("\n"), ocrConfidence: null, provider: "anthropic" as const };
      }
      generateRecipes = async () => {
        calls.external.push("recipes");
        return [];
      };
    },
  };
});

vi.mock("@/server/ai/local", async () => {
  const { parseReceiptText } = await import("@/lib/receipts/parse");
  const { readFileSync } = await import("node:fs");
  const pathMod = await import("node:path");
  const text = readFileSync(pathMod.resolve(process.cwd(), "tests/fixtures/receipts/woolworths-weekly.txt"), "utf8");
  return {
    LocalProvider: class {
      readonly id = "local" as const;
      readonly label = "On-device reading";
      readonly generateRecipes = null;
      async extractReceipt() {
        calls.local.push("receipt");
        const parsed = parseReceiptText(text, { today: "2026-09-30" });
        return {
          isReceipt: true,
          legible: true,
          store: parsed.store,
          purchasedOn: parsed.purchasedOn,
          currency: null,
          subtotal: parsed.subtotal,
          total: parsed.total,
          lines: parsed.lines.map((l) => ({ raw: l.description, name: null, quantity: l.quantity, weightKg: l.weightKg, unitPrice: l.unitPrice, price: l.price, isGrocery: true })),
          problems: parsed.warnings,
          rawText: text,
          ocrConfidence: 92,
          provider: "local" as const,
        };
      }
    },
  };
});

import { pool, systemDb } from "@/server/db/client";
import { preferences, receipts } from "@/server/db/schema";
import { buildHouseholdContext, type HouseholdContext } from "@/server/auth/build-context";
import { AiPermissionError, providerFor, requireExternalProvider, resolveAiAccess } from "@/server/ai";
import { acceptInvitation, createInvitation } from "@/server/services/household";
import { updateMember } from "@/server/services/members";
import { generateFreshIdeas } from "@/server/services/meals";
import { getAiConsentView, setAiConsent } from "@/server/services/privacy";
import { createReceiptFromUpload, processReceipt } from "@/server/services/receipts";
import { makeHousehold, setHouseholdPlan } from "../helpers/db";

async function joinHousehold(owner: HouseholdContext, role: "member" | "child"): Promise<HouseholdContext> {
  const other = await makeHousehold({ name: "Their own place" });
  const invite = await createInvitation(owner);
  await acceptInvitation(other.user, invite.code);
  let ctx = (await buildHouseholdContext(other.user, owner.household.id))!;
  if (role !== "member") {
    await updateMember(owner, ctx.member.id, { role });
    ctx = (await buildHouseholdContext(other.user, owner.household.id))!;
  }
  return ctx;
}

describe("AI consent and plan guard", () => {
  let plus: HouseholdContext;
  let photo: Buffer;

  beforeAll(async () => {
    plus = await makeHousehold({ name: "Plus household", plan: "plus" });
    photo = await readFile(path.resolve(__dirname, "../fixtures/receipts/woolworths-weekly.png"));
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(() => {
    calls.external.length = 0;
    calls.local.length = 0;
  });

  const setConsent = (ctx: HouseholdContext, patch: Partial<typeof preferences.$inferInsert>) =>
    systemDb.update(preferences).set(patch).where(eq(preferences.householdId, ctx.household.id));

  async function readPhoto(ctx: HouseholdContext) {
    const { receiptId } = await createReceiptFromUpload(ctx, { bytes: photo, size: photo.length }, { allowDuplicate: true });
    await processReceipt(ctx.user.id, ctx.household, receiptId);
    const [r] = await systemDb.select().from(receipts).where(eq(receipts.id, receiptId));
    return r;
  }

  it("is off by default for everyone", async () => {
    const [p] = await systemDb.select().from(preferences).where(eq(preferences.householdId, plus.household.id));
    expect(p.allowAiProcessing).toBe(false);
    expect(p.aiConsentAt).toBeNull();
    const access = await resolveAiAccess(plus.household.id);
    expect(access.entitled).toBe(true);
    expect(access.configured).toBe(true);
    expect(access.decision).toEqual({ allowed: false, reason: "no_consent" });
  });

  it("reads a receipt on the device, and sends nothing, without consent", async () => {
    const r = await readPhoto(plus);
    expect(calls.external).toEqual([]);
    expect(calls.local).toEqual(["receipt"]);
    expect(r.provider).toBe("local");
    expect(r.status).toBe("needs_review");
  });

  it("blocks recipes without consent, with a message that says what to do, and sends nothing", async () => {
    await expect(requireExternalProvider(plus.household.id, "recipes")).rejects.toBeInstanceOf(AiPermissionError);
    await expect(generateFreshIdeas(plus)).rejects.toThrow(/Settings → Privacy & data/);
    expect(calls.external).toEqual([]);
  });

  it("an owner or member can say yes: it's recorded, and the outside reader is used", async () => {
    await setAiConsent(plus, true);
    const [p] = await systemDb.select().from(preferences).where(eq(preferences.householdId, plus.household.id));
    expect(p.allowAiProcessing).toBe(true);
    expect(p.aiConsentAt).toBeInstanceOf(Date);
    expect(p.aiConsentBy).toBe(plus.user.id);
    const view = await getAiConsentView(plus);
    expect(view).toMatchObject({ consented: true, active: true, entitled: true, configured: true, providerName: "Anthropic", canChange: true });
    expect(view.consentByName).toBeTruthy();

    const chosen = await providerFor(plus.household.id);
    expect(chosen.external).toBe(true);
    const r = await readPhoto(plus);
    expect(calls.external).toEqual(["receipt:photo"]);
    expect(calls.local).toEqual([]);
    expect(r.provider).toBe("anthropic");
  });

  it("saying yes again keeps the original who and when", async () => {
    const [before] = await systemDb.select().from(preferences).where(eq(preferences.householdId, plus.household.id));
    await setAiConsent(plus, true);
    const [after] = await systemDb.select().from(preferences).where(eq(preferences.householdId, plus.household.id));
    expect(after.aiConsentAt?.getTime()).toBe(before.aiConsentAt?.getTime());
  });

  it("stores no card, loyalty, phone, email or address details from what the AI read", async () => {
    const r = await readPhoto(plus);
    expect(r.rawText).not.toMatch(/jane@example\.com/);
    expect(r.storeName).toBe("Woolworths Metro Town Hall");
    const items = await systemDb.query.receiptItems.findMany({ where: (t, { eq: e }) => e(t.receiptId, r.id) });
    expect(items.map((i) => i.rawText).join("\n")).not.toContain("jane@example.com");
  });

  it("stores no card, loyalty, phone or address details from what the on-device reader read", async () => {
    await setAiConsent(plus, false);
    const r = await readPhoto(plus);
    expect(r.provider).toBe("local");
    const text = r.rawText ?? "";
    for (const secret of ["4821", "9000 1234", "480 Kent", "345 678 901"]) expect(text).not.toContain(secret);
    expect(text).toContain("W/M FULL CREAM 2L");
    expect(text).toContain("26/09/2026 17:42");
  });

  it("withdrawing takes effect on the very next request and clears the record", async () => {
    await setAiConsent(plus, true);
    await setAiConsent(plus, false);
    const [p] = await systemDb.select().from(preferences).where(eq(preferences.householdId, plus.household.id));
    expect(p).toMatchObject({ allowAiProcessing: false, aiConsentAt: null, aiConsentBy: null });
    expect((await providerFor(plus.household.id)).external).toBe(false);
    await readPhoto(plus);
    expect(calls.external).toEqual([]);
  });

  it("a yes with no recorded time doesn't count", async () => {
    await setConsent(plus, { allowAiProcessing: true, aiConsentAt: null });
    expect((await resolveAiAccess(plus.household.id)).decision).toEqual({ allowed: false, reason: "no_consent" });
    await readPhoto(plus);
    expect(calls.external).toEqual([]);
    await setConsent(plus, { allowAiProcessing: false });
  });

  it("no preferences row at all is a no", async () => {
    const lone = await makeHousehold({ plan: "plus" });
    await systemDb.delete(preferences).where(eq(preferences.householdId, lone.household.id));
    expect((await resolveAiAccess(lone.household.id)).decision).toEqual({ allowed: false, reason: "no_consent" });
    expect((await providerFor(lone.household.id)).external).toBe(false);
  });

  it("the free plan stays on-device even with a recorded yes", async () => {
    const free = await makeHousehold({ name: "Free household", plan: "free" });
    await setConsent(free, { allowAiProcessing: true, aiConsentAt: new Date(), aiConsentBy: free.user.id });
    const access = await resolveAiAccess(free.household.id);
    expect(access.entitled).toBe(false);
    expect(access.decision).toEqual({ allowed: false, reason: "plan" });
    await readPhoto(free);
    expect(calls.external).toEqual([]);
    expect(calls.local).toEqual(["receipt"]);
    await expect(requireExternalProvider(free.household.id, "recipes")).rejects.toMatchObject({ reason: "plan" });
  });

  it("refuses to record a yes where there's nothing to say yes to", async () => {
    const free = await makeHousehold({ name: "Free again", plan: "free" });
    await expect(setAiConsent(free, true)).rejects.toThrow(/Plenty Plus/);
    const [p] = await systemDb.select().from(preferences).where(eq(preferences.householdId, free.household.id));
    expect(p.allowAiProcessing).toBe(false);
    // Saying no is always allowed.
    await setAiConsent(free, false);
  });

  it("a downgrade stops sending straight away, and an upgrade doesn't start it again without the record", async () => {
    const h = await makeHousehold({ plan: "plus" });
    await setAiConsent(h, true);
    expect((await providerFor(h.household.id)).external).toBe(true);
    const down = await setHouseholdPlan(h, "free");
    expect((await providerFor(down.household.id)).external).toBe(false);
    await setHouseholdPlan(down, "plus");
    expect((await providerFor(h.household.id)).external).toBe(true);
  });

  it("a child account can't answer for the household", async () => {
    const owner = await makeHousehold({ name: "Family", plan: "family" });
    const child = await joinHousehold(owner, "child");
    await expect(setAiConsent(child, true)).rejects.toThrow(/owner or a member/i);
    const [p] = await systemDb.select().from(preferences).where(eq(preferences.householdId, owner.household.id));
    expect(p.allowAiProcessing).toBe(false);
    expect((await getAiConsentView(child)).canChange).toBe(false);
  });

  it("a member can answer", async () => {
    const owner = await makeHousehold({ name: "Family 2", plan: "family" });
    const member = await joinHousehold(owner, "member");
    await setAiConsent(member, true);
    const [p] = await systemDb.select().from(preferences).where(eq(preferences.householdId, owner.household.id));
    expect(p.aiConsentBy).toBe(member.user.id);
  });

  it("the demo household can't send anything", async () => {
    const demo = await makeHousehold({ plan: "plus" });
    await systemDb.update((await import("@/server/db/schema")).households).set({ isDemo: true }).where(eq((await import("@/server/db/schema")).households.id, demo.household.id));
    const ctx = (await buildHouseholdContext(demo.user, demo.household.id))!;
    await expect(setAiConsent(ctx, true)).rejects.toThrow(/demo/i);
  });
});
