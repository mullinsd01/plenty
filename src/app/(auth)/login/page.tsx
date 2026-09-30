import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SignInForm } from "@/features/auth/forms";
import { getAuthUser } from "@/server/auth/context";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  if (await getAuthUser()) redirect("/home");
  return (
    <div>
      <h1 className="text-[28px] font-semibold tracking-[-0.03em]">Welcome back</h1>
      <p className="mb-8 mt-1.5 text-[15px] text-ink-3">Sign in to your household.</p>
      <SignInForm next={typeof next === "string" ? next : undefined} demo={env().DEMO_MODE} />
      <p className="mt-8 text-center text-sm text-ink-3">
        New to Plenty?{" "}
        <Link href="/signup" className="font-semibold text-ink hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}
