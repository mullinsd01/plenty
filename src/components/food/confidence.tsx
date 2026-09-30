import type { Confidence, PredictionBasis } from "@/lib/domain";
import { cn } from "@/lib/cn";

/**
 * Honest labelling of where a prediction comes from. "Plenty estimate" means
 * catalog priors; "From your history" means learned from this household.
 */
export function BasisLabel({
  basis,
  confidence,
  className,
}: {
  basis: PredictionBasis;
  confidence: Confidence;
  className?: string;
}) {
  const dots = confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
  const text = basis === "history" ? "From your history" : "Plenty estimate";
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-[12px] text-ink-3", className)}
      title={`${text} · ${confidence} confidence`}
    >
      <span className="inline-flex gap-[2px]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className={cn("size-[5px] rounded-full", i < dots ? (basis === "history" ? "bg-fresh" : "bg-ink-3") : "bg-line-strong")} />
        ))}
      </span>
      {text}
      <span className="sr-only">, {confidence} confidence</span>
    </span>
  );
}
