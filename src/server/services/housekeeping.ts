import "server-only";
import { and, isNotNull, lt, or } from "drizzle-orm";
import { systemDb } from "@/server/db/client";
import { passwordResetTokens, sessions } from "@/server/db/schema";

/** Used and expired reset tokens, and expired sessions, are kept this long before deletion (a day's grace helps support questions). */
const GRACE_MS = 86_400_000;

/**
 * Scheduled job: delete sign-in records that can no longer be used. Sessions
 * past their expiry and password-reset links that were used or have expired
 * serve no purpose, so they aren't kept. Idempotent.
 */
export async function pruneExpiredAuthRecords(now = new Date()): Promise<{ sessions: number; resetTokens: number }> {
  const cutoff = new Date(now.getTime() - GRACE_MS);
  const expiredSessions = await systemDb.delete(sessions).where(lt(sessions.expiresAt, cutoff)).returning({ id: sessions.id });
  const spentTokens = await systemDb
    .delete(passwordResetTokens)
    .where(or(lt(passwordResetTokens.expiresAt, cutoff), and(isNotNull(passwordResetTokens.usedAt), lt(passwordResetTokens.usedAt, cutoff))))
    .returning({ id: passwordResetTokens.id });
  return { sessions: expiredSessions.length, resetTokens: spentTokens.length };
}
