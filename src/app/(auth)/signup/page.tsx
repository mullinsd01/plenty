import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SignUpForm } from "@/features/auth/forms";
import { getAuthUser } from "@/server/auth/context";

export const metadata: Metadata = { title: "Create your account" };

export default async function SignUpPage({ searchParams }: PageProps<"/signup">) {
  const { next } = await searchParams;
  if (await getAuthUser()) redirect("/home");
  return (
    <div>
      <h1 className="text-[28px] font-semibold tracking-[-0.03em]">Let&apos;s get your household sorted</h1>
      <p className="mb-8 mt-1.5 text-[15px] text-ink-3">It takes about a minute. Plenty does the rest.</p>
      <SignUpForm next={typeof next === "string" ? next : undefined} />
      <p className="mt-8 text-center text-sm text-ink-3">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-ink hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
