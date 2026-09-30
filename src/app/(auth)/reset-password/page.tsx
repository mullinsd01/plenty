import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/features/auth/forms";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { token } = await searchParams;
  if (typeof token !== "string" || token.length < 20) {
    return (
      <div>
        <h1 className="text-[28px] font-semibold tracking-[-0.03em]">This link isn&apos;t valid</h1>
        <p className="mb-8 mt-1.5 text-[15px] text-ink-3">It may have expired or already been used.</p>
        <Link href="/forgot-password" className="font-semibold text-ink hover:underline">
          Request a new reset link
        </Link>
      </div>
    );
  }
  return (
    <div>
      <h1 className="text-[28px] font-semibold tracking-[-0.03em]">Choose a new password</h1>
      <p className="mb-8 mt-1.5 text-[15px] text-ink-3">You&apos;ll be signed in straight away.</p>
      <ResetPasswordForm token={token} />
    </div>
  );
}
