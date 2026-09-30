"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, ChefHat, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/hooks/use-action";
import { answerCheckInAction } from "@/features/kitchen/actions";
import { addListItemAction } from "@/features/list/actions";
import { cookPlanItemAction, generatePlanAction, replacePlanItemAction } from "@/features/meals/actions";
import { cn } from "@/lib/cn";

/** "Did you finish the milk?" — a one-tap confirmation instead of asking for quantities. */
export function CheckInCard({ productId, name }: { productId: string; name: string }) {
  const { pending, run } = useAction();
  const [answered, setAnswered] = useState<null | "yes" | "no">(null);
  if (answered) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5 text-sm text-ink-2 shadow-card animate-fade-in">
        <Check className="size-4 text-fresh" />
        {answered === "yes" ? `Thanks — Plenty has learned a little more about your ${name.toLowerCase()}.` : `Got it. Plenty will check again in a couple of days.`}
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-card sm:flex sm:items-center sm:justify-between sm:gap-4">
      <div>
        <p className="text-[15px] font-semibold">Did you finish the {name.toLowerCase()}?</p>
        <p className="mt-0.5 text-[13px] text-ink-3">By Plenty&apos;s estimate it should be about gone.</p>
      </div>
      <div className="mt-3 flex gap-2 sm:mt-0">
        <Button
          size="sm"
          loading={pending}
          onClick={() => run(() => answerCheckInAction(productId, true), { onSuccess: () => setAnswered("yes") })}
        >
          Yes, it&apos;s finished
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => run(() => answerCheckInAction(productId, false), { onSuccess: () => setAnswered("no") })}
        >
          Still some left
        </Button>
      </div>
    </div>
  );
}

export function AddToListButton({ name, onList }: { name: string; onList: boolean }) {
  const { pending, run } = useAction();
  const [added, setAdded] = useState(onList);
  if (added) {
    return (
      <span className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-fresh">
        <Check className="size-3.5" /> On list
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => run(() => addListItemAction({ name }), { onSuccess: () => setAdded(true) })}
      className="inline-flex h-8 items-center gap-1 rounded-full border border-line-strong px-2.5 text-[12px] font-medium text-ink-2 transition hover:bg-subtle hover:text-ink disabled:opacity-50"
      aria-label={`Add ${name} to your shopping list`}
    >
      <Plus className="size-3.5" /> List
    </button>
  );
}

export function TonightActions({ planItemId, mealId }: { planItemId: string; mealId: string }) {
  const cook = useAction();
  const swap = useAction();
  return (
    <div className="flex flex-wrap gap-2">
      <Button asChild size="sm">
        <Link href={`/meals/recipes/${mealId}`}>
          <ChefHat /> View recipe
        </Link>
      </Button>
      <Button size="sm" variant="secondary" loading={cook.pending} disabled={swap.pending} onClick={() => cook.run(() => cookPlanItemAction(planItemId))}>
        <Check /> We made it
      </Button>
      <Button size="sm" variant="ghost" loading={swap.pending} disabled={cook.pending} onClick={() => swap.run(() => replacePlanItemAction(planItemId))}>
        <RefreshCw /> Swap
      </Button>
    </div>
  );
}

export function PlanTonightButton({ className, variant = "primary" }: { className?: string; variant?: "primary" | "secondary" }) {
  const { pending, run } = useAction();
  return (
    <Button size="sm" variant={variant} className={cn(className)} loading={pending} onClick={() => run(() => generatePlanAction("tonight"))}>
      Plan tonight&apos;s dinner
    </Button>
  );
}
