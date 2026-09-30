import type { Metadata } from "next";
import Link from "next/link";
import { PlentyLogo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { JoinButton } from "@/features/household/join-button";
import { getAuthUser } from "@/server/auth/context";
import { getInvitationPreview } from "@/server/services/household";

export const metadata: Metadata = { title: "Join a household" };

export default async function JoinPage({ params }: PageProps<"/join/[code]">) {
  const { code } = await params;
  const clean = code.replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  const [preview, user] = await Promise.all([getInvitationPreview(clean), getAuthUser()]);
  const next = encodeURIComponent(`/join/${clean}`);
  return (
    <div className="flex min-h-dvh flex-col items-center px-6 py-10">
      <PlentyLogo className="h-7" />
      <main className="flex w-full max-w-sm flex-1 flex-col justify-center text-center">
        {preview ? (
          <>
            <p className="text-[15px] text-ink-3">{preview.invitedBy ? `${preview.invitedBy} invited you to join` : "You're invited to join"}</p>
            <h1 className="mt-2 text-balance text-[30px] font-semibold tracking-[-0.03em]">{preview.householdName}</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-ink-3">
              Share the kitchen, the shopping list and the meal plan. Anything anyone adds or finishes updates for everyone.
            </p>
            <div className="mt-8 space-y-2">
              {user ? (
                <JoinButton code={clean} />
              ) : (
                <>
                  <Button asChild size="lg" block>
                    <Link href={`/signup?next=${next}`}>Create an account to join</Link>
                  </Button>
                  <Button asChild size="lg" variant="secondary" block>
                    <Link href={`/login?next=${next}`}>I already have an account</Link>
                  </Button>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <h1 className="text-[26px] font-semibold tracking-[-0.03em]">This invite isn&apos;t valid</h1>
            <p className="mt-3 text-[15px] text-ink-3">It may have expired or been turned off. Ask for a new link.</p>
            <Button asChild className="mt-8">
              <Link href="/">Go to Plenty</Link>
            </Button>
          </>
        )}
      </main>
    </div>
  );
}
