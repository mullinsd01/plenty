import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "@/features/auth/forms";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <div>
      <h1 className="text-[28px] font-semibold tracking-[-0.03em]">Forgot your password?</h1>
      <p className="mb-8 mt-1.5 text-[15px] text-ink-3">We&apos;ll email you a link to choose a new one.</p>
      <ForgotPasswordForm />
      <p className="mt-8 text-center text-sm text-ink-3">
        <Link href="/login" className="font-semibold text-ink hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
