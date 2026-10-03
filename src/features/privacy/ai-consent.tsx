"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Sheet } from "@/components/ui/sheet";
import { useAction } from "@/components/hooks/use-action";
import { AI_DISCLOSURE, AI_NEVER_SENT, AI_PURPOSES } from "@/lib/ai/consent";
import { setAiConsentAction } from "@/features/settings/actions";
import type { AiConsentView } from "@/server/services/privacy";

/** Plain-language date, e.g. "3 Oct 2026". */
function when(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Asks for permission before anything is sent to an outside AI service, in
 * plain words: what is sent, to whom, what isn't, and how to stop. Nothing is
 * pre-selected; saying yes is a deliberate press of "Allow".
 */
export function AiConsentDialog({ open, onOpenChange, view }: { open: boolean; onOpenChange: (open: boolean) => void; view: AiConsentView }) {
  const { pending, run } = useAction();
  const provider = view.providerName;
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Let Plenty use ${provider}'s AI?`}
      description={`Plenty works well without this. If you say yes, some features send a small amount of your household's information to ${provider}, an outside company, so they can do a better job.`}
      footer={
        <>
          <Button
            variant="brand"
            loading={pending}
            onClick={() => run(() => setAiConsentAction(true), { onSuccess: () => onOpenChange(false) })}
          >
            Allow
          </Button>
          <Button variant="secondary" disabled={pending} onClick={() => onOpenChange(false)}>
            No thanks
          </Button>
        </>
      }
    >
      <div className="space-y-5 text-[14px] leading-relaxed text-ink-2">
        <section aria-labelledby="ai-sent">
          <h3 id="ai-sent" className="text-[14px] font-semibold text-ink">
            What is sent to {provider}
          </h3>
          <p className="mt-1 text-ink-3">Only when you use the feature, and only this:</p>
          <ul className="mt-2 space-y-3">
            {AI_PURPOSES.map((purpose) => (
              <li key={purpose}>
                <p className="font-medium capitalize text-ink">{AI_DISCLOSURE[purpose].feature}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-3">
                  {AI_DISCLOSURE[purpose].sent.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="ai-never">
          <h3 id="ai-never" className="text-[14px] font-semibold text-ink">
            What is never sent
          </h3>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-ink-3">
            {AI_NEVER_SENT.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="ai-how">
          <h3 id="ai-how" className="text-[14px] font-semibold text-ink">
            How it works
          </h3>
          <p className="mt-1 text-ink-3">
            It travels over an encrypted connection. Nothing the AI suggests changes your kitchen until you&apos;ve checked it: you review every receipt first, and recipes are checked against your
            allergies and diets by Plenty, not by the AI. What {provider} does with what it receives is covered by {provider}&apos;s own terms and privacy policy, which Plenty doesn&apos;t control:{" "}
            <a href={view.termsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-ink underline underline-offset-2">
              read {provider}&apos;s terms <ExternalLink className="size-3" aria-hidden />
            </a>
            .
          </p>
        </section>
        <section aria-labelledby="ai-control">
          <h3 id="ai-control" className="text-[14px] font-semibold text-ink">
            You&apos;re in control
          </h3>
          <p className="mt-1 text-ink-3">
            Any owner or member of your household can turn this off at any time in Settings → Privacy &amp; data, and it stops straight away: Plenty goes back to reading receipts on its own
            server. Turning it on is recorded (who, and when) so everyone in the household can see it.
          </p>
        </section>
      </div>
    </Sheet>
  );
}

/** The control on the Privacy & data page. */
export function AiConsentControl({ view }: { view: AiConsentView }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useAction();
  const provider = view.providerName;

  if (!view.configured) {
    return (
      <p className="text-[14px] leading-relaxed text-ink-3">
        No outside AI service is set up on this server, so Plenty reads receipts on its own server and uses its built-in recipe collection. Nothing about your household leaves Plenty for AI.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl ${view.consented ? "bg-fresh-soft text-fresh" : "bg-subtle text-ink-3"}`}>
          {view.consented ? <ShieldCheck className="size-[18px]" aria-hidden /> : <Sparkles className="size-[18px]" aria-hidden />}
        </span>
        <div className="min-w-0 text-[14px] leading-relaxed">
          <p className="font-medium text-ink" aria-live="polite">
            {view.consented
              ? view.active
                ? `AI-assisted features are on`
                : `You've said yes, but it's not in use right now`
              : `AI-assisted features are off`}
          </p>
          <p className="mt-0.5 text-ink-3">
            {view.consented
              ? `${view.consentByName ? `${view.consentByName} allowed` : "Allowed"} on ${view.consentAt ? when(view.consentAt) : "an earlier date"}. When you use them, receipt photos and the other things listed here are sent to ${provider}.${
                  view.entitled ? "" : ` That only happens on ${view.upgradePlan?.name ?? "a paid plan"}, which this household isn't on, so nothing is being sent.`
                }`
              : `Plenty reads receipts on its own server and uses its built-in recipes. Nothing is sent to ${provider}.`}
          </p>
        </div>
      </div>
      {!view.canChange ? (
        <p className="text-[13px] text-ink-3">An owner or member of the household can change this.</p>
      ) : view.consented ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" loading={pending} onClick={() => run(() => setAiConsentAction(false))}>
            Turn off
          </Button>
          <Button variant="ghost" onClick={() => setOpen(true)}>
            What&apos;s sent?
          </Button>
        </div>
      ) : view.entitled ? (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          See what&apos;s sent, and turn on…
        </Button>
      ) : (
        <p className="text-[13px] text-ink-3">AI-assisted features are included with {view.upgradePlan?.name ?? "a paid plan"}.</p>
      )}
      <AiConsentDialog open={open} onOpenChange={setOpen} view={view} />
    </div>
  );
}

/**
 * Shown where a receipt is about to be uploaded: either the offer (when the AI
 * reader is available but hasn't been agreed to), or a plain statement of what
 * will happen to the photo.
 */
export function AiConsentPrompt({ view }: { view: AiConsentView }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  if (!view.configured) return null;

  if (view.active) {
    return (
      <p className="flex items-start gap-2 rounded-2xl bg-subtle px-4 py-3 text-[13px] leading-relaxed text-ink-2">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-fresh" aria-hidden />
        <span>
          AI-assisted reading is on: the photo you upload is sent to {view.providerName} to be read.{" "}
          <Link href="/settings/privacy" className="font-medium text-ink underline underline-offset-2">
            Change this
          </Link>
        </span>
      </p>
    );
  }
  if (!view.entitled || !view.canChange || view.consented) {
    return (
      <p className="rounded-2xl bg-subtle px-4 py-3 text-[13px] leading-relaxed text-ink-3">
        Your photo is read on Plenty&apos;s own server. It isn&apos;t sent to anyone else.
      </p>
    );
  }
  if (dismissed) {
    return (
      <p className="rounded-2xl bg-subtle px-4 py-3 text-[13px] leading-relaxed text-ink-3">
        Your photo will be read on Plenty&apos;s own server. It isn&apos;t sent to anyone else.
      </p>
    );
  }
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-ink">
          <Sparkles className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Want sharper receipt reading?</h2>
          <p className="mt-1 text-[14px] leading-relaxed text-ink-3">
            Plenty can send your receipt photo to {view.providerName}&apos;s AI, which reads messy receipts more accurately. That&apos;s your call: nothing is sent unless you say yes, and you can
            turn it off any time.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              See what&apos;s sent
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
              Not now, use on-device reading
            </Button>
          </div>
        </div>
      </div>
      <AiConsentDialog open={open} onOpenChange={setOpen} view={view} />
    </Card>
  );
}
