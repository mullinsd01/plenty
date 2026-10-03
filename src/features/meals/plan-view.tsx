"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarDays, Check, ChefHat, MoreHorizontal, RefreshCw, Sparkles, ThumbsDown, Trash2, Users } from "lucide-react";
import { MealArt } from "@/components/food/meal-art";
import { Button } from "@/components/ui/button";
import { UpgradeNote } from "@/components/ui/upgrade-note";
import { Stepper } from "@/components/ui/controls";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Sheet } from "@/components/ui/sheet";
import { useAction } from "@/components/hooks/use-action";
import { cn } from "@/lib/cn";
import type { MealPlanView, PlanItemView } from "@/server/services/meals";
import {
  cookPlanItemAction,
  freshIdeasAction,
  generatePlanAction,
  movePlanItemAction,
  planDayAction,
  removePlanItemAction,
  replacePlanItemAction,
  setPlanServingsAction,
} from "./actions";
import { AvailabilityLine } from "./meal-card";

export function PlanView({
  plan,
  aiAvailable,
  canPlan = true,
  canPlanWeek = true,
}: {
  plan: MealPlanView;
  aiAvailable: boolean;
  /** The person may plan meals at all (child accounts only look). */
  canPlan?: boolean;
  /** The plan includes weekly plans, swapping and regenerating. */
  canPlanWeek?: boolean;
}) {
  const generate = useAction();
  const ideas = useAction();
  const planned = plan.days.filter((d) => d.item).length;

  return (
    <div>
      {!canPlanWeek && canPlan && (
        <UpgradeNote plan="plus" className="mb-4">
          Planning the whole week, swapping meals and turning a plan into your shopping list are part of Plenty Plus. You can plan a night at a time, and &ldquo;What can I
          make?&rdquo; always works.
        </UpgradeNote>
      )}
      <div className={canPlan ? "mb-6 flex flex-wrap items-center gap-2" : "hidden"}>
        {!canPlanWeek ? (
          <>
            <Button loading={generate.pending} onClick={() => generate.run(() => generatePlanAction("tonight"))}>
              <CalendarDays /> Plan tonight
            </Button>
            <Button variant="secondary" disabled={generate.pending} onClick={() => generate.run(() => generatePlanAction("tomorrow"))}>
              Plan tomorrow
            </Button>
          </>
        ) : planned === 0 ? (
          <>
            <Button loading={generate.pending} onClick={() => generate.run(() => generatePlanAction("week"))}>
              <CalendarDays /> Plan my week
            </Button>
            <Button variant="secondary" disabled={generate.pending} onClick={() => generate.run(() => generatePlanAction("tonight"))}>
              Just tonight
            </Button>
            <Button variant="secondary" disabled={generate.pending} onClick={() => generate.run(() => generatePlanAction("3days"))}>
              Next 3 days
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" loading={generate.pending} onClick={() => generate.run(() => generatePlanAction("week"))}>
              <CalendarDays /> Fill the gaps
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="ghost" disabled={generate.pending}>
                  <RefreshCw /> Regenerate
                </Button>
              </MenuTrigger>
              <MenuContent align="start">
                <MenuLabel>Swap everything that isn&apos;t cooked yet</MenuLabel>
                <MenuItem onSelect={() => generate.run(() => generatePlanAction("tonight", true))}>Tonight</MenuItem>
                <MenuItem onSelect={() => generate.run(() => generatePlanAction("tomorrow", true))}>Tomorrow</MenuItem>
                <MenuItem onSelect={() => generate.run(() => generatePlanAction("3days", true))}>Next 3 days</MenuItem>
                <MenuItem onSelect={() => generate.run(() => generatePlanAction("week", true))}>The whole week</MenuItem>
              </MenuContent>
            </Menu>
          </>
        )}
        {aiAvailable && (
          <Button variant="ghost" loading={ideas.pending} onClick={() => ideas.run(() => freshIdeasAction())} className="ml-auto">
            <Sparkles /> Fresh ideas
          </Button>
        )}
      </div>

      <ol className="space-y-3">
        {plan.days.map((day) => (
          <li key={day.date}>
            {day.item ? (
              <PlanDay
                item={day.item}
                label={day.label}
                dates={plan.days.map((d) => ({ date: d.date, label: d.label }))}
                canPlan={canPlan}
                canSwap={canPlanWeek}
              />
            ) : (
              <EmptyDay date={day.date} label={day.label} isToday={day.date === plan.today} canPlan={canPlan} />
            )}
          </li>
        ))}
      </ol>
      <p className="mt-6 text-center text-[13px] text-ink-4">
        Plans use what&apos;s in your kitchen first — especially anything that needs using. Missing ingredients go straight onto your list.
      </p>
    </div>
  );
}

function EmptyDay({ date, label, isToday, canPlan }: { date: string; label: string; isToday: boolean; canPlan: boolean }) {
  const { pending, run } = useAction();
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-dashed border-line-strong px-4 py-3.5">
      <DayLabel label={label} />
      <p className="flex-1 text-[14px] text-ink-3">Nothing planned</p>
      {/* Plans exactly this night — even one Plenty usually leaves free for takeaway. */}
      <Button size="sm" variant={isToday ? "secondary" : "ghost"} loading={pending} onClick={() => run(() => planDayAction(date))} aria-label={`Plan ${label}`} className={canPlan ? undefined : "hidden"}>
        Plan it
      </Button>
      <span className="sr-only">{date}</span>
    </div>
  );
}

function DayLabel({ label }: { label: string }) {
  return <span className="w-20 shrink-0 text-[13px] font-semibold uppercase tracking-[0.05em] text-ink-3">{label}</span>;
}

function PlanDay({
  item,
  label,
  dates,
  canPlan,
  canSwap,
}: {
  item: PlanItemView;
  label: string;
  dates: Array<{ date: string; label: string }>;
  canPlan: boolean;
  canSwap: boolean;
}) {
  const act = useAction();
  const [servingsOpen, setServingsOpen] = useState(false);
  const [servings, setServings] = useState(item.servings);
  const cooked = item.status === "cooked";
  return (
    <div className={cn("rounded-2xl border border-line bg-surface p-4 shadow-card transition", act.pending && "opacity-70", cooked && "bg-subtle/50")}>
      <div className="flex items-start gap-4">
        <div className="hidden w-20 shrink-0 pt-1 sm:block">
          <DayLabel label={label} />
        </div>
        <Link href={`/meals/recipes/${item.meal.id}?servings=${item.servings}`} className="flex min-w-0 flex-1 gap-4">
          <MealArt mainIngredient={item.meal.mainIngredient} name={item.meal.name} />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-3 sm:hidden">{label}</p>
            <h3 className="text-[16px] font-semibold leading-snug tracking-[-0.01em]">{item.meal.name}</h3>
            <p className="mt-0.5 text-[13px] text-ink-3">
              {item.meal.timeMinutes} min · {item.meal.difficultyLabel} · serves {item.servings}
            </p>
            {cooked ? (
              <p className="mt-1.5 flex items-center gap-1.5 text-[13px] font-medium text-fresh">
                <Check className="size-3.5" /> Cooked — ingredients taken out of your kitchen
              </p>
            ) : (
              <>
                <AvailabilityLine meal={item.meal} className="mt-1.5" />
                {item.reason && <p className="mt-1 text-[13px] text-ink-3">{item.reason}</p>}
              </>
            )}
          </div>
        </Link>
        {!cooked && canPlan && (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" aria-label={`Options for ${item.meal.name}`} className="flex size-9 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-subtle hover:text-ink">
                <MoreHorizontal className="size-5" />
              </button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => act.run(() => cookPlanItemAction(item.id))}>
                <ChefHat /> We made this
              </MenuItem>
              {canSwap && (
                <MenuItem onSelect={() => act.run(() => replacePlanItemAction(item.id))}>
                  <RefreshCw /> Swap for something else
                </MenuItem>
              )}
              <MenuItem onSelect={() => act.run(() => replacePlanItemAction(item.id, true))}>
                <ThumbsDown /> Don&apos;t suggest this again
              </MenuItem>
              <MenuItem onSelect={() => setServingsOpen(true)}>
                <Users /> Change servings
              </MenuItem>
              <MenuSeparator />
              <MenuLabel>Move to</MenuLabel>
              {dates
                .filter((d) => d.date !== item.date)
                .map((d) => (
                  <MenuItem key={d.date} onSelect={() => act.run(() => movePlanItemAction(item.id, d.date))}>
                    {d.label}
                  </MenuItem>
                ))}
              <MenuSeparator />
              <MenuItem destructive onSelect={() => act.run(() => removePlanItemAction(item.id))}>
                <Trash2 /> Remove from plan
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      <Sheet open={servingsOpen} onOpenChange={setServingsOpen} title="Servings" description={item.meal.name} size="sm">
        <div className="flex items-center justify-between">
          <span className="text-[15px]">How many people?</span>
          <Stepper label="Servings" value={servings} onChange={setServings} min={1} max={24} />
        </div>
        <Button
          block
          className="mt-6"
          loading={act.pending}
          onClick={() => act.run(() => setPlanServingsAction(item.id, servings), { onSuccess: () => setServingsOpen(false) })}
        >
          Save
        </Button>
      </Sheet>
    </div>
  );
}
