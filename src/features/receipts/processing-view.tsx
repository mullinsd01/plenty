"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";

const STEPS = ["Reading the receipt", "Tidying up product names", "Matching things to your kitchen", "Almost there"];

/** Live progress while the receipt is read in the background. Polls, then refreshes into the review screen. */
export function ProcessingView({ receiptId }: { receiptId: string }) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);
  const [offline, setOffline] = useState(false);
  const kicked = useRef(0);

  useEffect(() => {
    const started = Date.now();
    const tick = setInterval(() => setElapsed((Date.now() - started) / 1000), 500);
    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const res = await fetch(`/api/receipts/${receiptId}/status`, { cache: "no-store" });
          if (res.status === 401) {
            router.push("/login");
            return;
          }
          const body = (await res.json()) as { status?: string };
          setOffline(false);
          if (body.status && body.status !== "processing" && body.status !== "uploaded") {
            router.refresh();
            return;
          }
        } catch {
          setOffline(true);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearInterval(tick);
    };
  }, [receiptId, router]);

  // If processing seems stuck (e.g. the server restarted), nudge it now and then.
  // The server only restarts work once the previous attempt has lapsed.
  useEffect(() => {
    const due = elapsed > 45 ? Math.floor((elapsed - 45) / 60) + 1 : 0;
    if (due > kicked.current) {
      kicked.current = due;
      void fetch(`/api/receipts/${receiptId}/status`, { method: "POST" }).catch(() => undefined);
    }
  }, [elapsed, receiptId]);

  const step = Math.min(STEPS.length - 1, Math.floor(elapsed / 3));
  return (
    <Card className="mx-auto max-w-lg p-6 sm:p-8" aria-live="polite">
      <div className="flex items-center gap-3">
        <Spinner className="size-5 text-brand" />
        <p className="text-[17px] font-semibold tracking-[-0.01em]">Reading your receipt</p>
      </div>
      <ol className="mt-6 space-y-3">
        {STEPS.map((label, i) => (
          <li key={label} className={cn("flex items-center gap-3 text-[15px] transition-colors", i <= step ? "text-ink" : "text-ink-4")}>
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full border text-[11px]",
                i < step ? "border-fresh bg-fresh text-white" : i === step ? "border-brand text-brand" : "border-line-strong",
              )}
            >
              {i < step ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
      <p className="mt-6 text-[13px] text-ink-3">
        {offline
          ? "Connection lost — we'll keep checking."
          : elapsed > 40
            ? "This one's taking a little longer than usual. You can leave this page — Plenty will let you know when it's ready."
            : "Usually takes a few seconds. You can leave this page; we'll notify you."}
      </p>
      {elapsed > 90 && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={() => router.refresh()}>
          Check again
        </Button>
      )}
    </Card>
  );
}
