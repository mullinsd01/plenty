import Link from "next/link";
import { Bookmark, Check, Clock, Leaf } from "lucide-react";
import { MealArt } from "@/components/food/meal-art";
import { cn } from "@/lib/cn";
import type { MealCardView } from "@/server/services/meals";

/** Availability in plain words: "You already have everything" / "You're missing 2 ingredients". */
export function AvailabilityLine({ meal, className }: { meal: Pick<MealCardView, "missingCount" | "missingNames" | "haveCount">; className?: string }) {
  if (meal.missingCount === 0) {
    return (
      <p className={cn("flex items-center gap-1.5 text-[13px] font-medium text-fresh", className)}>
        <Check className="size-3.5" strokeWidth={2.5} /> You already have everything
      </p>
    );
  }
  const names = meal.missingNames.slice(0, 3).join(", ");
  return (
    <p className={cn("text-[13px] text-ink-3", className)}>
      <span className="font-medium text-ink-2">
        Missing {meal.missingCount} {meal.missingCount === 1 ? "ingredient" : "ingredients"}
      </span>
      {names && <span className="text-ink-3">: {names}{meal.missingNames.length > 3 ? "…" : ""}</span>}
    </p>
  );
}

export function MealCard({ meal, href, children, className }: { meal: MealCardView; href?: string; children?: React.ReactNode; className?: string }) {
  const body = (
    <div className="flex gap-4">
      <MealArt mainIngredient={meal.mainIngredient} name={meal.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <h3 className="flex-1 text-[16px] font-semibold leading-snug tracking-[-0.01em]">{meal.name}</h3>
          {meal.saved && <Bookmark className="mt-0.5 size-4 shrink-0 fill-current text-brand" aria-label="Saved" />}
        </div>
        <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-ink-3">
          <Clock className="size-3.5" /> {meal.timeMinutes} min · {meal.difficultyLabel} · {meal.cuisineLabel}
        </p>
        <AvailabilityLine meal={meal} className="mt-1.5" />
        {meal.useSoonNames.length > 0 && (
          <p className="mt-1 flex items-center gap-1.5 text-[13px] text-soon">
            <Leaf className="size-3.5" /> Uses your {meal.useSoonNames.slice(0, 2).join(" and ").toLowerCase()} before it goes off
          </p>
        )}
        {meal.reason && meal.useSoonNames.length === 0 && <p className="mt-1 text-[13px] text-ink-3">{meal.reason}</p>}
      </div>
    </div>
  );
  return (
    <div className={cn("rounded-2xl border border-line bg-surface p-4 shadow-card", className)}>
      {href ? (
        <Link href={href} className="block rounded-xl focus-visible:outline-2">
          {body}
        </Link>
      ) : (
        body
      )}
      {children && <div className="mt-4 flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}
