"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bookmark, CalendarPlus, ChefHat, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { useAction } from "@/components/hooks/use-action";
import { cn } from "@/lib/cn";
import { addMealToPlanAction, cookMealNowAction, rateMealAction, saveMealAction } from "./actions";

export interface DayOption {
  date: string;
  label: string;
}

/** "Cook now" + "Add to plan" for a meal card or recipe page. */
export function CookActions({ mealId, days, servings, compact = false }: { mealId: string; days: DayOption[]; servings?: number; compact?: boolean }) {
  const cook = useAction();
  const plan = useAction();
  return (
    <>
      <Button size="sm" loading={cook.pending} disabled={plan.pending} onClick={() => cook.run(() => cookMealNowAction(mealId, servings))}>
        <ChefHat /> {compact ? "Cook now" : "We're cooking this now"}
      </Button>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="secondary" loading={plan.pending} disabled={cook.pending}>
            <CalendarPlus /> Add to plan
          </Button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuLabel>Which night?</MenuLabel>
          {days.map((d) => (
            <MenuItem key={d.date} onSelect={() => plan.run(() => addMealToPlanAction(mealId, d.date))}>
              {d.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      {compact && (
        <Button asChild size="sm" variant="ghost">
          <Link href={`/meals/recipes/${mealId}`}>Recipe</Link>
        </Button>
      )}
    </>
  );
}

/** Like / dislike / save — each teaches Plenty what the household enjoys. */
export function RatingActions({ mealId, rating, saved }: { mealId: string; rating: -1 | 0 | 1; saved: boolean }) {
  const [r, setR] = useState(rating);
  const [s, setS] = useState(saved);
  const act = useAction();
  const router = useRouter();
  const rate = (value: -1 | 0 | 1) => {
    const next = r === value ? 0 : value;
    setR(next);
    act.run(() => rateMealAction(mealId, next), {
      success: next === -1 ? "Plenty won't suggest this again" : next === 1 ? "Noted — a household favourite" : undefined,
      onError: () => setR(r),
      onSuccess: () => router.refresh(),
    });
  };
  return (
    <div className="flex gap-1.5">
      <IconToggle active={r === 1} label="Like" onClick={() => rate(1)}>
        <ThumbsUp className={cn(r === 1 && "fill-current")} />
      </IconToggle>
      <IconToggle active={r === -1} label="Dislike" onClick={() => rate(-1)}>
        <ThumbsDown className={cn(r === -1 && "fill-current")} />
      </IconToggle>
      <IconToggle
        active={s}
        label={s ? "Saved" : "Save"}
        onClick={() => {
          const next = !s;
          setS(next);
          act.run(() => saveMealAction(mealId, next), { onError: () => setS(s) });
        }}
      >
        <Bookmark className={cn(s && "fill-current")} />
      </IconToggle>
    </div>
  );
}

function IconToggle({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-10 items-center justify-center rounded-full border transition [&_svg]:size-[18px]",
        active ? "border-brand bg-brand-soft text-brand-ink" : "border-line-strong text-ink-3 hover:bg-subtle hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
