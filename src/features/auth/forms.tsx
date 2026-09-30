"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Eye, EyeOff, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { ActionResult } from "@/lib/result";
import {
  demoSignInAction,
  forgotPasswordAction,
  resetPasswordAction,
  signInAction,
  signUpAction,
} from "./actions";

type State = ActionResult<undefined> | null;

function FormError({ state }: { state: State }) {
  if (!state || state.ok || state.fieldErrors) return null;
  return (
    <div role="alert" className="rounded-xl bg-alert-soft px-3.5 py-3 text-sm text-alert">
      {state.error}
    </div>
  );
}

function fieldError(state: State, name: string): string | null {
  if (!state || state.ok) return null;
  return state.fieldErrors?.[name] ?? null;
}

function PasswordInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={visible ? "text" : "password"} className="pr-11" />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-ink-3 hover:bg-subtle hover:text-ink"
        aria-label={visible ? "Hide password" : "Show password"}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export function SignInForm({ next, demo }: { next?: string; demo: boolean }) {
  const [state, action, pending] = useActionState<State, FormData>(signInAction, null);
  const [demoState, demoAction, demoPending] = useActionState<State, FormData>(() => demoSignInAction(), null);
  return (
    <div className="space-y-6">
      <form action={action} className="space-y-4" noValidate>
        <input type="hidden" name="next" value={next ?? ""} />
        <FormError state={state} />
        <Field label="Email" htmlFor="email" error={fieldError(state, "email")}>
          <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" required autoFocus />
        </Field>
        <Field
          label="Password"
          action={
            <Link href="/forgot-password" className="text-[13px] font-medium text-ink-3 hover:text-ink">
              Forgot your password?
            </Link>
          }
          htmlFor="password"
          error={fieldError(state, "password")}
        >
          <PasswordInput id="password" name="password" autoComplete="current-password" required />
        </Field>
        <Button type="submit" size="lg" block loading={pending}>
          Sign in
        </Button>
      </form>
      {demo && (
        <form action={demoAction} className="space-y-3">
          <div className="flex items-center gap-3 text-xs text-ink-4">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          <FormError state={demoState} />
          <Button type="submit" variant="secondary" size="lg" block loading={demoPending}>
            Explore the demo household
          </Button>
        </form>
      )}
    </div>
  );
}

export function SignUpForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<State, FormData>(signUpAction, null);
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="next" value={next ?? ""} />
      <FormError state={state} />
      <Field label="Your first name" htmlFor="name" error={fieldError(state, "name")}>
        <Input id="name" name="name" autoComplete="given-name" required autoFocus />
      </Field>
      <Field label="Email" htmlFor="email" error={fieldError(state, "email")}>
        <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" required />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 8 characters." error={fieldError(state, "password")}>
        <PasswordInput id="password" name="password" autoComplete="new-password" required minLength={8} />
      </Field>
      <Button type="submit" size="lg" block loading={pending}>
        Create account
      </Button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState<State, FormData>(forgotPasswordAction, null);
  if (state?.ok) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-5 text-center shadow-card">
        <MailCheck className="mx-auto mb-3 size-7 text-fresh" />
        <p className="font-semibold">Check your inbox</p>
        <p className="mt-1 text-sm text-ink-3">{state.message}</p>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormError state={state} />
      <Field label="Email" htmlFor="email" error={fieldError(state, "email")}>
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
      </Field>
      <Button type="submit" size="lg" block loading={pending}>
        Send reset link
      </Button>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<State, FormData>(resetPasswordAction, null);
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="token" value={token} />
      <FormError state={state} />
      <Field label="New password" htmlFor="password" hint="At least 8 characters." error={fieldError(state, "password")}>
        <PasswordInput id="password" name="password" autoComplete="new-password" required autoFocus />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm" error={fieldError(state, "confirm")}>
        <PasswordInput id="confirm" name="confirm" autoComplete="new-password" required />
      </Field>
      <Button type="submit" size="lg" block loading={pending}>
        Save new password
      </Button>
    </form>
  );
}
