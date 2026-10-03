import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LegalTitle } from "@/features/legal/legal-ui";
import { APPLE_MANAGE_URL, googleManageUrl } from "@/lib/billing/management";

export const metadata: Metadata = { title: "Account deleted", robots: { index: false } };

export default async function AccountDeletedPage({ searchParams }: PageProps<"/account-deleted">) {
  const { cancel } = await searchParams;
  // Only the two known store names are ever read from the address; anything else is ignored.
  const stores = new Set(
    String(Array.isArray(cancel) ? cancel.join(",") : (cancel ?? ""))
      .split(",")
      .filter((s) => s === "apple" || s === "google"),
  );
  return (
    <>
      <LegalTitle title="Your account has been deleted" />
      <div className="flex items-start gap-3 text-[15px] leading-relaxed text-ink-2">
        <CircleCheck className="mt-0.5 size-5 shrink-0 text-fresh" aria-hidden />
        <p>Your account, and any household you were the only person with an account in, have been deleted. Plenty can&apos;t bring them back.</p>
      </div>
      {stores.size > 0 && (
        <div role="note" className="mt-6 rounded-xl bg-soon-soft px-4 py-4 text-[14px] leading-relaxed text-ink-2">
          <p className="font-semibold text-ink">One more step: cancel your subscription in the store.</p>
          <p className="mt-1">Deleting your account doesn&apos;t cancel a subscription bought through the App Store or Google Play. Only the store can, and until you do, it may keep renewing.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {stores.has("apple") && (
              <li>
                <a href={APPLE_MANAGE_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-ink underline underline-offset-2">
                  Cancel in your Apple ID subscriptions
                </a>
              </li>
            )}
            {stores.has("google") && (
              <li>
                <a href={googleManageUrl()} target="_blank" rel="noopener noreferrer" className="font-medium text-ink underline underline-offset-2">
                  Cancel in Google Play subscriptions
                </a>
              </li>
            )}
          </ul>
        </div>
      )}
      <div className="mt-8">
        <Button asChild>
          <Link href="/">Back to Plenty</Link>
        </Button>
      </div>
    </>
  );
}
