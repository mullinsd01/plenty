"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { fail, type ActionResult } from "@/lib/result";
import { getCurrentSession, createSession, setSessionCookie, clearSessionCookie, invalidateSession } from "@/server/auth/session";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import * as auth from "@/server/auth/service";
import { systemDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { env } from "@/server/env";
import { AppError, parseInput, toUserError } from "@/server/errors";
import { clientIp, safeRedirectPath } from "@/server/http";
import { forgotPasswordSchema, resetPasswordSchema, signInSchema, signUpFormSchema } from "@/validation/auth";

type FormState = ActionResult<undefined> | null;

/**
 * An error for a form, carrying back what was typed (never a password) so the form can put it back:
 * React clears a form's fields after its action runs, which would otherwise wipe a name and email over one typo.
 */
function formError(err: unknown, context: string, formData: FormData, keep: string[]): ReturnType<typeof toUserError> {
  const values: Record<string, string> = {};
  for (const key of keep) {
    const value = formData.get(key);
    if (typeof value === "string") values[key] = value.slice(0, 254);
  }
  return { ...toUserError(err, context), values };
}

const clientKey = clientIp;

/** Only allow same-site relative redirects. */
function safeNext(next: FormDataEntryValue | null, fallback: string): string {
  return safeRedirectPath(next, fallback);
}

async function startSession(userId: string) {
  const h = await headers();
  const { token, expiresAt } = await createSession(userId, h.get("user-agent"));
  await setSessionCookie(token, expiresAt);
}

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let next: string;
  try {
    const { name, email, password } = parseInput(signUpFormSchema, {
      name: formData.get("name"),
      email: formData.get("email"),
      password: formData.get("password"),
      terms: formData.get("terms"),
    });
    await enforceRateLimit(`signup:${await clientKey()}`, 10, 3600, "creating accounts");
    const { userId } = await auth.signUp({ name, email, password });
    await startSession(userId);
    next = safeNext(formData.get("next"), "/onboarding");
  } catch (err) {
    return formError(err, "signUp", formData, ["name", "email", "terms"]);
  }
  redirect(next);
}

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let next: string;
  try {
    const input = parseInput(signInSchema, { email: formData.get("email"), password: formData.get("password") });
    await enforceRateLimit(`signin:${input.email}`, 8, 900, "signing in");
    await enforceRateLimit(`signin-ip:${await clientKey()}`, 40, 900, "signing in");
    const { userId } = await auth.signIn(input);
    await startSession(userId);
    next = safeNext(formData.get("next"), "/home");
  } catch (err) {
    return formError(err, "signIn", formData, ["email"]);
  }
  redirect(next);
}

export async function demoSignInAction(): Promise<FormState> {
  try {
    if (!env().DEMO_MODE) throw new AppError("forbidden", "The demo household isn't available here.");
    const [demo] = await systemDb
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, "demo@plenty.app"), eq(users.isDemo, true)))
      .limit(1);
    if (!demo) {
      throw new AppError("not_found", "The demo household hasn't been created yet. Run `npm run db:seed` and try again.");
    }
    await startSession(demo.id);
  } catch (err) {
    return toUserError(err, "demoSignIn");
  }
  redirect("/home");
}

export async function signOutAction(): Promise<void> {
  const current = await getCurrentSession();
  if (current) await invalidateSession(current.session.id);
  await clearSessionCookie();
  redirect("/login");
}

export async function forgotPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { email } = parseInput(forgotPasswordSchema, { email: formData.get("email") });
    await enforceRateLimit(`reset:${email}`, 3, 3600, "resetting your password");
    await enforceRateLimit(`reset-ip:${await clientKey()}`, 10, 3600, "resetting passwords");
    await auth.requestPasswordReset(email);
    return { ok: true, data: undefined, message: "If an account exists for that email, a reset link is on its way." };
  } catch (err) {
    return formError(err, "forgotPassword", formData, ["email"]);
  }
}

export async function resetPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const input = parseInput(resetPasswordSchema, {
      token: formData.get("token"),
      password: formData.get("password"),
      confirm: formData.get("confirm"),
    });
    await enforceRateLimit(`reset-complete:${await clientKey()}`, 10, 900, "that");
    const { userId } = await auth.resetPassword(input.token, input.password);
    await startSession(userId);
  } catch (err) {
    const res = toUserError(err, "resetPassword");
    return res.code === "internal" ? fail("We couldn't reset your password. Please request a new link.") : res;
  }
  redirect("/home");
}
