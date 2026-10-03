import "server-only";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { systemDb, withSystem } from "@/server/db/client";
import { passwordResetTokens, profiles, users } from "@/server/db/schema";
import { emailButton, emailLayout, sendEmail } from "@/server/email/mailer";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { deleteUserAndData } from "@/server/services/account-deletion";
import { generateToken, hashPassword, sha256, verifyPassword } from "./crypto";
import { invalidateAllSessions } from "./session";

const RESET_TOKEN_MINUTES = 60;

/** A dummy hash so failed lookups take as long as real password checks (no user enumeration by timing). */
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword("plenty-timing-equaliser"));

async function findUserByEmail(email: string) {
  const [user] = await systemDb
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email.toLowerCase()}`, isNull(users.deletedAt)))
    .limit(1);
  return user ?? null;
}

export async function signUp(input: { name: string; email: string; password: string }): Promise<{ userId: string }> {
  const existing = await findUserByEmail(input.email);
  if (existing) {
    throw new AppError("conflict", "An account with that email already exists. Try signing in instead.", {
      email: "An account with that email already exists.",
    });
  }
  const passwordHash = await hashPassword(input.password);
  try {
    return await withSystem(async (tx) => {
      const [user] = await tx.insert(users).values({ email: input.email, passwordHash }).returning({ id: users.id });
      await tx.insert(profiles).values({ userId: user.id, displayName: input.name });
      return { userId: user.id };
    });
  } catch (err) {
    const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") {
      throw new AppError("conflict", "An account with that email already exists. Try signing in instead.");
    }
    throw err;
  }
}

export async function signIn(input: { email: string; password: string }): Promise<{ userId: string }> {
  const user = await findUserByEmail(input.email);
  if (!user) {
    await verifyPassword(await getDummyHash(), input.password);
    throw new AppError("unauthenticated", "That email and password don't match. Try again or reset your password.");
  }
  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) {
    throw new AppError("unauthenticated", "That email and password don't match. Try again or reset your password.");
  }
  return { userId: user.id };
}

/**
 * Start a password reset. Always behaves the same whether or not the account
 * exists, so it can't be used to discover registered emails.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await findUserByEmail(email);
  if (!user || user.isDemo) return;
  const token = generateToken();
  await systemDb.insert(passwordResetTokens).values({
    id: sha256(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + RESET_TOKEN_MINUTES * 60_000),
  });
  const link = `${env().APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: user.email,
    subject: "Reset your Plenty password",
    text: `Someone (hopefully you) asked to reset your Plenty password.\n\nChoose a new password here: ${link}\n\nThis link works for ${RESET_TOKEN_MINUTES} minutes. If you didn't ask for this, you can ignore this email.`,
    html: emailLayout(
      "Reset your password",
      `<p>Someone (hopefully you) asked to reset your Plenty password.</p>${emailButton(link, "Choose a new password")}<p>This link works for ${RESET_TOKEN_MINUTES} minutes. If you didn't ask for this, you can safely ignore this email.</p>`,
    ),
  });
}

/** Complete a reset: set the new password, burn the token and sign out everywhere. */
export async function resetPassword(token: string, password: string): Promise<{ userId: string }> {
  const id = sha256(token);
  const [record] = await systemDb
    .select()
    .from(passwordResetTokens)
    .where(and(eq(passwordResetTokens.id, id), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, new Date())))
    .limit(1);
  if (!record) {
    throw new AppError("validation", "This reset link has expired or already been used. Request a new one.");
  }
  const passwordHash = await hashPassword(password);
  await withSystem(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, record.userId));
    await tx.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.userId, record.userId));
  });
  await invalidateAllSessions(record.userId);
  return { userId: record.userId };
}

export async function changePassword(userId: string, current: string, next: string): Promise<void> {
  const [user] = await systemDb.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AppError("unauthenticated", "Your session has expired. Please sign in again.");
  if (user.isDemo) throw new AppError("forbidden", "The demo account's password can't be changed.");
  if (!(await verifyPassword(user.passwordHash, current))) {
    throw new AppError("validation", "Your current password isn't right.", { current: "Your current password isn't right." });
  }
  await systemDb.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, userId));
}

export async function updateEmail(userId: string, email: string, password: string): Promise<void> {
  const [user] = await systemDb.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AppError("unauthenticated", "Your session has expired. Please sign in again.");
  if (user.isDemo) throw new AppError("forbidden", "The demo account's email can't be changed.");
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new AppError("validation", "Your password isn't right.", { password: "Your password isn't right." });
  }
  const existing = await findUserByEmail(email);
  if (existing && existing.id !== userId) {
    throw new AppError("conflict", "Another account already uses that email.", { email: "Another account already uses that email." });
  }
  await systemDb.update(users).set({ email }).where(eq(users.id, userId));
}

/**
 * Permanently delete a user's account after checking their password.
 * Households where they're the only person with an account are deleted with
 * everything in them; in shared ones they leave, and if they're the only owner
 * the deletion is refused until someone else is made an owner (nothing is
 * handed over silently). See `services/account-deletion.ts` for the details.
 */
export async function deleteAccount(userId: string, password: string): ReturnType<typeof deleteUserAndData> {
  const [user] = await systemDb.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { deletedHouseholdIds: [], leftHouseholdIds: [], storeSubscriptions: [] };
  if (user.isDemo) throw new AppError("forbidden", "The demo account can't be deleted.");
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new AppError("validation", "Your password isn't right.", { password: "Your password isn't right." });
  }
  return deleteUserAndData(userId);
}
