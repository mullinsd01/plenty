"use client";

import * as React from "react";
import { Checkbox as RCheckbox, Switch as RSwitch, ToggleGroup } from "radix-ui";
import { Check, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/cn";

export function Switch({ className, ...props }: React.ComponentProps<typeof RSwitch.Root>) {
  return (
    <RSwitch.Root
      className={cn(
        "relative inline-flex h-[26px] w-[44px] shrink-0 items-center rounded-full bg-line-strong transition-colors data-[state=checked]:bg-fresh disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RSwitch.Thumb className="block size-[22px] translate-x-[2px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.2)] transition-transform duration-200 data-[state=checked]:translate-x-[20px]" />
    </RSwitch.Root>
  );
}

export function Checkbox({ className, ...props }: React.ComponentProps<typeof RCheckbox.Root>) {
  return (
    <RCheckbox.Root
      className={cn(
        "peer flex size-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-line-strong bg-surface transition-colors data-[state=checked]:border-fresh data-[state=checked]:bg-fresh",
        className,
      )}
      {...props}
    >
      <RCheckbox.Indicator className="text-white data-[state=checked]:animate-fade-in">
        <Check className="size-3.5" strokeWidth={3} />
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

/** Single-choice segmented control. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = "md",
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  className?: string;
  size?: "sm" | "md";
  ariaLabel: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      aria-label={ariaLabel}
      className={cn("inline-flex rounded-[12px] bg-subtle p-1", className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className={cn(
            "flex-1 whitespace-nowrap rounded-[9px] font-medium text-ink-3 transition-all data-[state=on]:bg-surface data-[state=on]:text-ink data-[state=on]:shadow-[0_1px_3px_rgb(0_0_0/0.08)]",
            size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
          )}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

/** Multi-select chips — used for diets, cuisines, stores. */
export function ChipGroup<T extends string>({
  value,
  onChange,
  options,
  className,
  ariaLabel,
}: {
  value: T[];
  onChange: (value: T[]) => void;
  options: Array<{ value: T; label: string }>;
  className?: string;
  ariaLabel: string;
}) {
  return (
    <ToggleGroup.Root
      type="multiple"
      value={value}
      onValueChange={(v) => onChange(v as T[])}
      aria-label={ariaLabel}
      className={cn("flex flex-wrap gap-2", className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className="h-9 rounded-full border border-line-strong bg-surface px-3.5 text-[13px] font-medium text-ink-2 transition-all hover:border-ink-4 data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-on-primary"
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

/** − value + stepper for small counts. */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = 99,
  step = 1,
  label,
  format,
  className,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  format?: (value: number) => React.ReactNode;
  className?: string;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v * 1000) / 1000));
  return (
    <div className={cn("inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface p-1", className)}>
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - step))}
        className="flex size-8 items-center justify-center rounded-full text-ink-2 transition hover:bg-subtle disabled:opacity-30"
      >
        <Minus className="size-4" />
      </button>
      <span className="tabular min-w-10 text-center text-[15px] font-semibold" aria-live="polite" aria-label={label}>
        {format ? format(value) : value}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + step))}
        className="flex size-8 items-center justify-center rounded-full text-ink-2 transition hover:bg-subtle disabled:opacity-30"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}
