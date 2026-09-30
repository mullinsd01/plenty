import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { systemDb } from "@/server/db/client";
import { sessions, users } from "@/server/db/schema";
import { generateToken, sha256 } from "./crypto";

export const SESSION_COOKIE = "plenty_session";
const SESSION_DAYS = 30;
const REFRESH_WHEN_DAYS_LEFT = 15;
const DAY = 86_400_000;

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
}

export interface SessionUser {
  id: string;
  email: string;
  isDemo: boolean;
}

/** Create a session for `userId`; returns the raw token for the cookie. */
export async function createSession(userId: string, userAgent?: string | null): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY);
  await systemDb.insert(sessions).values({
    id: sha256(token),
    userId,
    expiresAt,
    userAgent: userAgent?.slice(0, 300) ?? null,
  });
  return { token, expiresAt };
}

/** Look up a session by raw token; slides the expiry forward when it's getting old. */
export async function validateSessionToken(token: string): Promise<{ session: SessionRecord; user: SessionUser } | null> {
  if (!token || token.length > 200) return null;
  const id = sha256(token);
  const rows = await systemDb
    .select({
      id: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      email: users.email,
      isDemo: users.isDemo,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date()), isNull(users.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  let expiresAt = row.expiresAt;
  if (expiresAt.getTime() - Date.now() < REFRESH_WHEN_DAYS_LEFT * DAY) {
    expiresAt = new Date(Date.now() + SESSION_DAYS * DAY);
    await systemDb.update(sessions).set({ expiresAt, lastSeenAt: new Date() }).where(eq(sessions.id, id));
  }
  return {
    session: { id: row.id, userId: row.userId, expiresAt },
    user: { id: row.userId, email: row.email, isDemo: row.isDemo },
  };
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await systemDb.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function invalidateAllSessions(userId: string): Promise<void> {
  await systemDb.delete(sessions).where(eq(sessions.userId, userId));
}

/** Sign out every other device, keeping the one making the request. */
export async function invalidateOtherSessions(userId: string, keepSessionId: string): Promise<void> {
  await systemDb.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
}

/** Set the session cookie. Only callable from Server Actions / Route Handlers. */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
}

/** The current request's session, validated against the database once per request. */
export const getCurrentSession = cache(async (): Promise<{ session: SessionRecord; user: SessionUser } | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return await validateSessionToken(token);
  } catch (err) {
    console.error("[auth] session validation failed:", err instanceof Error ? err.message : err);
    return null;
  }
});
