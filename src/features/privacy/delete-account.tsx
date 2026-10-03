"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { useAction } from "@/components/hooks/use-action";
import { APPLE_MANAGE_URL, BILLING_PATH, googleManageUrl } from "@/lib/billing/management";
import { DELETE_CONFIRMATION } from "@/lib/privacy";
import { deleteAccountAction } from "@/features/settings/actions";
import type { AccountDeletionPlan, SubscriptionNotice } from "@/server/services/account-deletion";

/** Where to cancel, by who bills for it. Never says Plenty cancelled anything: it can't. */
export function SubscriptionCancelNotice({ subscription, what }: { subscription: SubscriptionNotice; what: "account" | "household" }) {
  const where =
    subscription.provider === "apple" ? (
      <>
        Cancel it in your Apple ID subscription settings:{" "}
        <a className="inline-flex items-center gap-1 font-medium underline underline-offset-2" href={APPLE_MANAGE_URL} target="_blank" rel="noopener noreferrer">
          open subscriptions <ExternalLink className="size-3" aria-hidden />
        </a>
        . Or on an iPhone: Settings → your name → Subscriptions.
      </>
    ) : subscription.provider === "google" ? (
      <>
        Cancel it in Google Play:{" "}
        <a className="inline-flex items-center gap-1 font-medium underline underline-offset-2" href={googleManageUrl()} target="_blank" rel="noopener noreferrer">
          open subscriptions <ExternalLink className="size-3" aria-hidden />
        </a>
        . Or in the Play Store app: profile picture → Payments &amp; subscriptions → Subscriptions.
      </>
    ) : (
      <>
        Cancel it on the{" "}
        <Link className="font-medium underline underline-offset-2" href={BILLING_PATH}>
          plan page
        </Link>{" "}
        (it opens the billing portal), before deleting.
      </>
    );
  return (
    <div role="note" className="rounded-xl bg-soon-soft px-4 py-3 text-[13px] leading-relaxed text-ink-2">
      <p className="font-semibold text-ink">Deleting your {what} does not cancel your {subscription.planName} subscription.</p>
      <p className="mt-1">
        It&apos;s billed by {subscription.provider === "apple" ? "Apple" : subscription.provider === "google" ? "Google" : "our payment provider"}, and only they can end it
        {subscription.autoRenew ? ", so it keeps renewing until you do" : ""}. Plenty removes its record of the subscription either way. {where}
      </p>
    </div>
  );
}

/** Delete the account, with every consequence spelled out first. Password and a typed word are both required. */
export function DeleteAccountControl({ plan, isDemo }: { plan: AccountDeletionPlan; isDemo: boolean }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { pending, run } = useAction();
  const blocked = plan.blockedBy.length > 0;
  const ready = !blocked && password.length > 0 && confirm.trim().toUpperCase() === DELETE_CONFIRMATION;
  return (
    <>
      <Button variant="danger-subtle" onClick={() => setOpen(true)} disabled={isDemo}>
        <Trash2 /> Delete my account…
      </Button>
      {isDemo && <p className="mt-2 text-[13px] text-ink-3">The shared demo account can&apos;t be deleted.</p>}
      <Sheet
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setPassword("");
            setConfirm("");
          }
        }}
        size="lg"
        title="Delete your account?"
        description="This is permanent. Plenty can't bring anything back afterwards, so read what will happen."
        footer={
          <>
            <Button variant="danger" loading={pending} disabled={!ready} onClick={() => run(() => deleteAccountAction({ password, confirm }))}>
              Delete my account
            </Button>
            <Button variant="secondary" disabled={pending} onClick={() => setOpen(false)}>
              Keep my account
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-[14px] leading-relaxed text-ink-2">
          {blocked && (
            <div role="alert" className="rounded-xl bg-alert-soft px-4 py-3 text-[13px] text-alert">
              <p className="font-semibold">You can&apos;t delete your account yet.</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {plan.blockedBy.map((h) => (
                  <li key={h.id}>
                    You&apos;re the only owner of “{h.name}”, and {h.otherAccountHolders === 1 ? "someone else uses it" : `${h.otherAccountHolders} other people use it`}. Make one of them an owner in{" "}
                    <Link href="/settings/household" className="font-medium underline underline-offset-2">
                      Household &amp; sharing
                    </Link>
                    , or delete the household, then come back. Plenty never hands a household to someone without you choosing.
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="font-semibold text-ink">What will be deleted</p>
            <ul className="mt-1 list-disc space-y-1.5 pl-5 text-ink-3">
              <li>Your account: your email, password, name and every signed-in device.</li>
              {plan.households.map((h) =>
                h.outcome === "delete" ? (
                  <li key={h.id}>
                    <span className="font-medium text-ink-2">The household “{h.name}” and everything in it</span>, because you&apos;re the only person with an account in it
                    {h.profilesWithoutAccount > 0 ? `, including ${h.profilesWithoutAccount === 1 ? "1 profile" : `${h.profilesWithoutAccount} profiles`} of people without accounts` : ""}: its kitchen,
                    shopping lists, recurring items, meal plans and recipes, receipts and their photos, what Plenty has learned, notifications, usage and subscription records.
                  </li>
                ) : h.outcome === "leave" ? (
                  <li key={h.id}>
                    <span className="font-medium text-ink-2">You leave “{h.name}”.</span> It carries on without you. Your private items, your own food rules and your personal patterns are deleted; things you shared stay
                    with the household.
                  </li>
                ) : null,
              )}
              <li>Anything Plenty recorded for analytics about those households.</li>
            </ul>
          </div>
          {plan.households.map((h) => h.subscription && <SubscriptionCancelNotice key={h.id} subscription={h.subscription} what="account" />)}
          <p className="text-[13px] text-ink-3">
            Want a copy first?{" "}
            <a href="/api/export" download className="font-medium text-ink underline underline-offset-2">
              Download your household&apos;s data
            </a>{" "}
            before you delete.
          </p>
          <div className="space-y-3">
            <Field label={`Type ${DELETE_CONFIRMATION} to confirm`} htmlFor="del-confirm">
              <Input id="del-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" autoCapitalize="characters" disabled={blocked} />
            </Field>
            <Field label="Your password" htmlFor="del-pw">
              <Input id="del-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" disabled={blocked} />
            </Field>
          </div>
        </div>
      </Sheet>
    </>
  );
}
