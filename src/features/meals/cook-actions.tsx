"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bookmark, CalendarPlus, ChefHat, Flag, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { useAction } from "@/components/hooks/use-action";
import { cn } from "@/lib/cn";
import { addMealToPlanAction, cookMealNowAction, rateMealAction, reportRecipeAction, saveMealAction } from "./actions";

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

const REPORT_REASONS = [
  { value: "unsafe", label: "It isn't safe", hint: "Wrong cooking temperature, an allergen it shouldn't have, or anything that could make someone ill." },
  { value: "inaccurate", label: "It's wrong or doesn't make sense", hint: "Amounts, steps or ingredients that don't add up." },
  { value: "offensive", label: "It's offensive or inappropriate", hint: "" },
  { value: "other", label: "Something else", hint: "" },
] as const;

/** For recipes an AI wrote: tell us it's wrong, unsafe or inappropriate. Nothing about the recipe changes. */
export function ReportRecipe({ mealId }: { mealId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof REPORT_REASONS)[number]["value"] | "">("");
  const [note, setNote] = useState("");
  const act = useAction();
  const send = () => {
    if (!reason) return;
    act.run(() => reportRecipeAction(mealId, { reason, note: note.trim() || undefined }), {
      success: "Thanks — we've got your report.",
      onSuccess: () => {
        setOpen(false);
        setReason("");
        setNote("");
      },
    });
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-3 hover:text-ink"
      >
        <Flag className="size-3.5" aria-hidden /> Report this recipe
      </button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="Report this recipe"
        description="Plenty's AI wrote this recipe, and AI can get things wrong. Tell us what's the matter and we'll take a look. It doesn't change your recipe or your plan."
        footer={
          <>
            <Button variant="secondary" size="lg" onClick={() => setOpen(false)} disabled={act.pending}>
              Cancel
            </Button>
            <Button size="lg" className="flex-1" onClick={send} loading={act.pending} disabled={!reason}>
              Send report
            </Button>
          </>
        }
      >
        <fieldset className="space-y-2">
          <legend className="sr-only">What's the matter?</legend>
          {REPORT_REASONS.map((r) => (
            <label
              key={r.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition focus-within:ring-2 focus-within:ring-brand/40",
                reason === r.value ? "border-ink bg-subtle/60" : "border-line hover:bg-subtle/40",
              )}
            >
              <input type="radio" name="report-reason" value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} className="mt-1 size-4 accent-[var(--brand)]" />
              <span className="min-w-0">
                <span className="block text-[14px] font-medium text-ink">{r.label}</span>
                {r.hint && <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-3">{r.hint}</span>}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="mt-4">
          <Field label="Anything to add?" htmlFor="report-note" optional>
            <Textarea id="report-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="What should we know?" />
          </Field>
        </div>
      </Sheet>
    </>
  );
}
