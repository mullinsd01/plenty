"use client";

import { LEVEL_PRESETS } from "@/lib/domain";
import { cn } from "@/lib/cn";

/** A slim meter for how much is left. Colour shifts as it runs low. */
export function LevelMeter({ fraction, className }: { fraction: number; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  const tone = fraction <= 0.2 ? "bg-alert" : fraction <= 0.45 ? "bg-soon" : "bg-fresh";
  return (
    <div
      className={cn("h-1.5 w-14 overflow-hidden rounded-full bg-sunken", className)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={`About ${pct}% left`}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500", tone)} style={{ width: `${Math.max(pct, 4)}%` }} />
    </div>
  );
}

/**
 * Tap-to-set level: Full / Mostly / Half / Low / Empty. No typing numbers.
 * The closest preset to the current estimate is highlighted.
 */
export function LevelPicker({
  value,
  onChange,
  disabled,
  className,
}: {
  value: number;
  onChange: (fraction: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const closest = LEVEL_PRESETS.reduce((best, p) => (Math.abs(p.fraction - value) < Math.abs(best.fraction - value) ? p : best));
  return (
    <div role="radiogroup" aria-label="How much is left" className={cn("grid grid-cols-5 gap-1.5", className)}>
      {LEVEL_PRESETS.map((p) => {
        const active = p.key === closest.key;
        return (
          <button
            key={p.key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(p.fraction)}
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-xl border px-1 py-2.5 text-[12px] font-medium transition active:scale-[0.97] disabled:opacity-50",
              active ? "border-primary bg-primary text-on-primary" : "border-line bg-surface text-ink-2 hover:border-line-strong",
            )}
          >
            <span className={cn("relative h-6 w-3.5 overflow-hidden rounded-[4px] border", active ? "border-on-primary/60" : "border-ink-4")}>
              <span
                className={cn("absolute inset-x-0 bottom-0", active ? "bg-on-primary/80" : "bg-ink-4")}
                style={{ height: `${p.fraction * 100}%` }}
              />
            </span>
            {p.label === "Mostly full" ? "Mostly" : p.label}
          </button>
        );
      })}
    </div>
  );
}
