import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { pool, systemDb } from "@/server/db/client";
import { passwordResetTokens, sessions } from "@/server/db/schema";
import { createSession } from "@/server/auth/session";
import { pruneExpiredAuthRecords } from "@/server/services/housekeeping";
import { makeHousehold } from "../helpers/db";

const DAY = 86_400_000;

describe("sign-in housekeeping", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("deletes expired sessions and spent reset links, and only those", async () => {
    const ctx = await makeHousehold({ plan: "plus" });
    const now = new Date();
    const live = await createSession(ctx.user.id);
    const old = await createSession(ctx.user.id);
    const { sha256 } = await import("@/server/auth/crypto");
    await systemDb.update(sessions).set({ expiresAt: new Date(now.getTime() - 3 * DAY) }).where(eq(sessions.id, sha256(old.token)));
    await systemDb.insert(passwordResetTokens).values([
      { id: "expired-token", userId: ctx.user.id, expiresAt: new Date(now.getTime() - 3 * DAY) },
      { id: "used-token", userId: ctx.user.id, expiresAt: new Date(now.getTime() + DAY), usedAt: new Date(now.getTime() - 2 * DAY) },
      { id: "fresh-token", userId: ctx.user.id, expiresAt: new Date(now.getTime() + 3_600_000) },
    ]);
    const result = await pruneExpiredAuthRecords(now);
    expect(result.sessions).toBeGreaterThanOrEqual(1);
    expect(result.resetTokens).toBe(2);
    const left = await systemDb.select().from(sessions).where(eq(sessions.userId, ctx.user.id));
    expect(left.some((s) => s.id === sha256(live.token))).toBe(true);
    expect(left.some((s) => s.id === sha256(old.token))).toBe(false);
    const tokens = await systemDb.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, ctx.user.id));
    expect(tokens.map((t) => t.id)).toEqual(["fresh-token"]);
    expect(await pruneExpiredAuthRecords(now)).toEqual({ sessions: 0, resetTokens: 0 });
  });
});
