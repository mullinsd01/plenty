"use client";

import { useId, useState } from "react";
import { Switch } from "@/components/ui/controls";
import { useAction } from "@/components/hooks/use-action";
import { cn } from "@/lib/cn";
import { setAnalyticsOptOutAction, setReceiptRetentionAction } from "@/features/settings/actions";

interface RetentionOption {
  value: "after_review" | "days_30" | "keep";
  label: string;
  description: string;
}

/** How long receipt photos are kept: one choice, each said in plain words. */
export function ReceiptRetentionControl({ initial, options, canChange }: { initial: RetentionOption["value"]; options: RetentionOption[]; canChange: boolean }) {
  const [value, setValue] = useState(initial);
  const { pending, run } = useAction();
  const name = useId();
  return (
    <fieldset disabled={!canChange || pending} className="space-y-2">
      <legend className="sr-only">How long to keep receipt photos</legend>
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition focus-within:ring-2 focus-within:ring-brand/40",
            value === o.value ? "border-ink bg-subtle/60" : "border-line hover:bg-subtle/40",
            (!canChange || pending) && "cursor-not-allowed opacity-70",
          )}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            className="mt-1 size-4 accent-[var(--color-ink)]"
            onChange={() => {
              const previous = value;
              setValue(o.value);
              run(() => setReceiptRetentionAction(o.value), { onError: () => setValue(previous) });
            }}
          />
          <span className="min-w-0">
            <span className="block text-[14px] font-medium text-ink">{o.label}</span>
            <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-3">{o.description}</span>
          </span>
        </label>
      ))}
      {!canChange && <p className="text-[13px] text-ink-3">An owner or member of the household can change this.</p>}
    </fieldset>
  );
}

/** Analytics on or off, for this person. Off means nothing about their use is recorded. */
export function AnalyticsToggle({ optedOut }: { optedOut: boolean }) {
  const [on, setOn] = useState(!optedOut);
  const { pending, run } = useAction();
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="min-w-0">
        <span className="block text-[15px] font-medium">Help improve Plenty with anonymous usage counts</span>
        <span className="mt-1 block text-[13px] leading-relaxed text-ink-3">
          Plenty counts things like &ldquo;a receipt was confirmed&rdquo; or &ldquo;a plan page was viewed&rdquo;, kept on Plenty&apos;s own server, never shared. No names, items or receipt contents are
          included. This setting is just for you, and turning it off stops recording anything about what you do.
        </span>
      </label>
      <Switch
        id={id}
        checked={on}
        disabled={pending}
        onCheckedChange={(v) => {
          setOn(v);
          run(() => setAnalyticsOptOutAction(!v), { onError: () => setOn(!v) });
        }}
      />
    </div>
  );
}
