"use client";

import { useState, useTransition } from "react";
import { ArrowLeft, Check, ScanLine, X } from "lucide-react";
import { toast } from "sonner";
import { PlentyMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { ChipGroup, Segmented, Stepper } from "@/components/ui/controls";
import { Field, Input } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import {
  ALLERGENS,
  ALLERGEN_LABELS,
  COOKING_FREQUENCIES,
  COOKING_FREQUENCY_LABELS,
  CUISINES,
  CUISINE_LABELS,
  DIETS,
  DIET_LABELS,
  supermarketsFor,
  type Allergen,
  type CookingFrequency,
  type Cuisine,
  type Diet,
} from "@/lib/domain";
import type { PreferencesInput } from "@/validation/household";
import { finishOnboardingAction, saveHouseholdBasicsAction, saveOnboardingPreferencesAction } from "./actions";

export interface OnboardingInitial {
  firstName: string;
  hasHousehold: boolean;
  householdName: string;
  adults: number;
  children: number;
  currency: string;
  prefs: {
    diets: Diet[];
    allergies: Allergen[];
    dislikedIngredients: string[];
    favouriteCuisines: Cuisine[];
    cookingFrequency: CookingFrequency | null;
    weeknightMaxMinutes: number | null;
    weeklyBudget: number | null;
    preferredStores: string[];
    takeawayPerWeek: number | null;
  };
}

const STEPS = ["welcome", "household", "avoid", "dislikes", "cuisines", "cooking", "shopping", "done"] as const;
type Step = (typeof STEPS)[number];

const DISLIKE_SUGGESTIONS = ["mushrooms", "olives", "coriander", "seafood", "eggplant", "blue cheese", "capers", "chilli", "beetroot", "tofu"];


export function OnboardingFlow({ initial }: { initial: OnboardingInitial }) {
  const [step, setStep] = useState<Step>(initial.hasHousehold ? "avoid" : "welcome");
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(initial.householdName);
  const [adults, setAdults] = useState(initial.adults);
  const [children, setChildren] = useState(initial.children);
  const [diets, setDiets] = useState<Diet[]>(initial.prefs.diets);
  const [allergies, setAllergies] = useState<Allergen[]>(initial.prefs.allergies);
  const [dislikes, setDislikes] = useState<string[]>(initial.prefs.dislikedIngredients);
  const [cuisines, setCuisines] = useState<Cuisine[]>(initial.prefs.favouriteCuisines);
  const [frequency, setFrequency] = useState<CookingFrequency | null>(initial.prefs.cookingFrequency);
  const [weeknight, setWeeknight] = useState<string>(initial.prefs.weeknightMaxMinutes ? String(initial.prefs.weeknightMaxMinutes) : "");
  const [stores, setStores] = useState<string[]>(initial.prefs.preferredStores);
  const [budget, setBudget] = useState<string>(initial.prefs.weeklyBudget ? String(initial.prefs.weeklyBudget) : "");
  const [takeaway, setTakeaway] = useState<number>(initial.prefs.takeawayPerWeek ?? 1);

  const index = STEPS.indexOf(step);
  const progress = Math.round((index / (STEPS.length - 1)) * 100);
  const goNext = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]);
  const goBack = () => setStep(STEPS[Math.max(index - 1, initial.hasHousehold ? 2 : 0)]);

  const savePrefs = (patch: PreferencesInput, advance = true) => {
    startTransition(async () => {
      const res = await saveOnboardingPreferencesAction(patch);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (advance) goNext();
    });
  };

  const saveHousehold = () => {
    startTransition(async () => {
      const res = await saveHouseholdBasicsAction({
        name: name.trim() || `${initial.firstName}'s household`,
        adults,
        children,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      goNext();
    });
  };

  const finish = (destination: "home" | "scan") => {
    startTransition(async () => {
      const res = await finishOnboardingAction(destination);
      if (res && !res.ok) toast.error(res.error);
    });
  };

  const storeOptions = Array.from(new Set([...supermarketsFor(initial.currency), ...stores])).map((s) => ({
    value: s,
    label: s,
  }));

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-5 pb-[max(2rem,calc(env(safe-area-inset-bottom)+1rem))] pt-[max(1.25rem,calc(env(safe-area-inset-top)+0.5rem))]">
      <div className="flex h-10 items-center gap-3">
        {index > (initial.hasHousehold ? 2 : 0) && step !== "done" ? (
          <button
            type="button"
            onClick={goBack}
            className="flex size-9 items-center justify-center rounded-full text-ink-2 hover:bg-subtle"
            aria-label="Back"
          >
            <ArrowLeft className="size-5" />
          </button>
        ) : (
          <PlentyMark className="h-7" />
        )}
        <div
          className="h-1 flex-1 overflow-hidden rounded-full bg-sunken"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Setup progress"
        >
          <div className="h-full rounded-full bg-brand transition-[width] duration-500 ease-out" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div key={step} className="flex flex-1 animate-rise flex-col pt-10 sm:pt-16">
        {step === "welcome" && (
          <Screen
            title={`Hi ${initial.firstName}. Let's get your household figured out.`}
            body="Plenty learns what you buy, what you use and what you like — so it can tell you what's running low and what to cook. We'll only ask what's genuinely useful, and you can skip anything."
          >
            <Actions>
              <Button size="lg" block onClick={goNext}>
                Get started
              </Button>
            </Actions>
          </Screen>
        )}

        {step === "household" && (
          <Screen title="Who's in your household?" body="This helps Plenty guess how fast things get used, before it has learned your habits.">
            <div className="space-y-6">
              <Field label="Household name" htmlFor="household-name">
                <Input
                  id="household-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={`${initial.firstName}'s household`}
                  maxLength={80}
                />
              </Field>
              <CountRow label="Adults" hint="13 and over" value={adults} onChange={setAdults} min={children > 0 ? 0 : 1} />
              <CountRow label="Children" hint="Under 13" value={children} onChange={setChildren} min={adults > 0 ? 0 : 1} />
            </div>
            <Actions>
              <Button size="lg" block onClick={saveHousehold} loading={pending}>
                Continue
              </Button>
            </Actions>
          </Screen>
        )}

        {step === "avoid" && (
          <Screen title="Anything Plenty should always avoid?" body="Plenty leaves meals containing these out of its suggestions. It's a helpful filter, not a guarantee, so always check labels and ingredients yourself.">
            <div className="space-y-7">
              <div>
                <p className="mb-3 text-[13px] font-semibold text-ink-2">Allergies</p>
                <ChipGroup
                  ariaLabel="Allergies"
                  value={allergies}
                  onChange={setAllergies}
                  options={ALLERGENS.map((a) => ({ value: a, label: ALLERGEN_LABELS[a] }))}
                />
              </div>
              <div>
                <p className="mb-3 text-[13px] font-semibold text-ink-2">Dietary requirements</p>
                <ChipGroup ariaLabel="Diets" value={diets} onChange={setDiets} options={DIETS.map((d) => ({ value: d, label: DIET_LABELS[d] }))} />
              </div>
            </div>
            <Actions onSkip={goNext}>
              <Button size="lg" block loading={pending} onClick={() => savePrefs({ allergies, diets })}>
                {allergies.length + diets.length > 0 ? "Continue" : "None of these"}
              </Button>
            </Actions>
          </Screen>
        )}

        {step === "dislikes" && (
          <Screen title="Any foods you'd rather not see?" body="Plenty will steer clear of meals built around these.">
            <DislikeInput value={dislikes} onChange={setDislikes} />
            <Actions onSkip={goNext}>
              <Button size="lg" block loading={pending} onClick={() => savePrefs({ dislikedIngredients: dislikes })}>
                {dislikes.length > 0 ? "Continue" : "I'll eat anything"}
              </Button>
            </Actions>
          </Screen>
        )}

        {step === "cuisines" && (
          <Screen title="What do you love to eat?" body="Pick a few favourites. Plenty will lean towards them and learn more from what you cook.">
            <ChipGroup
              ariaLabel="Favourite cuisines"
              value={cuisines}
              onChange={setCuisines}
              options={CUISINES.filter((c) => c !== "other").map((c) => ({ value: c, label: CUISINE_LABELS[c] }))}
            />
            <Actions onSkip={goNext}>
              <Button size="lg" block loading={pending} onClick={() => savePrefs({ favouriteCuisines: cuisines })}>
                Continue
              </Button>
            </Actions>
          </Screen>
        )}

        {step === "cooking" && (
          <Screen title="How often do you cook at home?" body="So Plenty plans the right number of meals.">
            <div className="space-y-2">
              {COOKING_FREQUENCIES.map((f) => (
                <OptionRow key={f} selected={frequency === f} onClick={() => setFrequency(f)}>
                  {COOKING_FREQUENCY_LABELS[f]}
                </OptionRow>
              ))}
            </div>
            <div className="mt-8">
              <p className="mb-3 text-[13px] font-semibold text-ink-2">On a weeknight, dinner should take at most…</p>
              <Segmented
                ariaLabel="Weeknight cooking time"
                className="w-full"
                value={weeknight || "none"}
                onChange={(v) => setWeeknight(v === "none" ? "" : v)}
                options={[
                  { value: "20", label: "20 min" },
                  { value: "30", label: "30 min" },
                  { value: "45", label: "45 min" },
                  { value: "none", label: "No limit" },
                ]}
              />
            </div>
            <Actions onSkip={goNext}>
              <Button
                size="lg"
                block
                loading={pending}
                onClick={() =>
                  savePrefs({ cookingFrequency: frequency, weeknightMaxMinutes: weeknight ? Number(weeknight) : null })
                }
              >
                Continue
              </Button>
            </Actions>
          </Screen>
        )}

        {step === "shopping" && (
          <Screen title="A little about your shopping" body="All optional. Plenty will work out your rhythm from your receipts.">
            <div className="space-y-7">
              <div>
                <p className="mb-3 text-[13px] font-semibold text-ink-2">Where do you usually shop?</p>
                <ChipGroup ariaLabel="Supermarkets" value={stores} onChange={setStores} options={storeOptions} />
              </div>
              <Field label={`Rough weekly grocery budget (${initial.currency})`} htmlFor="budget" optional>
                <Input
                  id="budget"
                  inputMode="decimal"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ""))}
                  placeholder="e.g. 200"
                />
              </Field>
              <CountRow label="Takeaway nights" hint="In a typical week" value={takeaway} onChange={setTakeaway} min={0} max={14} />
            </div>
            <Actions onSkip={goNext}>
              <Button
                size="lg"
                block
                loading={pending}
                onClick={() =>
                  savePrefs({
                    preferredStores: stores.filter((s) => s.trim().length > 0),
                    weeklyBudget: budget ? Number(budget) : null,
                    takeawayPerWeek: takeaway,
                  })
                }
              >
                Continue
              </Button>
            </Actions>
          </Screen>
        )}

        {step === "done" && (
          <Screen title="You're all set." body="Here's how Plenty gets to know your household — no pantry spreadsheets required.">
            <ol className="space-y-4">
              <DoneStep n={1} title="Scan your next receipt">
                Plenty reads it and fills your kitchen. You just confirm.
              </DoneStep>
              <DoneStep n={2} title="Tell it when something's finished">
                One tap. Plenty learns how fast your household gets through things.
              </DoneStep>
              <DoneStep n={3} title="Let it do the thinking">
                It predicts what&apos;s running low, plans meals around what you have and builds your list.
              </DoneStep>
            </ol>
            <Actions>
              <Button variant="brand" size="lg" block loading={pending} onClick={() => finish("scan")}>
                <ScanLine /> Scan a receipt
              </Button>
              <Button variant="ghost" size="lg" block disabled={pending} onClick={() => finish("home")}>
                I&apos;ll do it later
              </Button>
            </Actions>
          </Screen>
        )}
      </div>
    </div>
  );
}

function Screen({ title, body, children }: { title: string; body?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <h1 className="text-balance text-[28px] font-semibold leading-[1.15] tracking-[-0.03em] sm:text-[32px]">{title}</h1>
      {body && <p className="mt-3 text-pretty text-[15px] leading-relaxed text-ink-3">{body}</p>}
      <div className="mt-8 flex flex-1 flex-col">{children}</div>
    </div>
  );
}

function Actions({ children, onSkip }: { children: React.ReactNode; onSkip?: () => void }) {
  return (
    <div className="mt-auto space-y-2 pt-10">
      {children}
      {onSkip && (
        <button type="button" onClick={onSkip} className="block w-full py-2 text-center text-sm font-medium text-ink-3 hover:text-ink">
          Skip for now
        </button>
      )}
    </div>
  );
}

function CountRow({
  label,
  hint,
  value,
  onChange,
  min = 0,
  max = 12,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-[15px] font-semibold">{label}</p>
        <p className="text-[13px] text-ink-3">{hint}</p>
      </div>
      <Stepper label={label} value={value} onChange={onChange} min={min} max={max} />
    </div>
  );
}

function OptionRow({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "flex h-14 w-full items-center justify-between rounded-xl border px-4 text-left text-[15px] font-medium transition",
        selected ? "border-primary bg-surface shadow-raised" : "border-line bg-surface hover:border-line-strong",
      )}
    >
      {children}
      <span
        className={cn(
          "flex size-5 items-center justify-center rounded-full border-[1.5px]",
          selected ? "border-primary bg-primary text-on-primary" : "border-line-strong",
        )}
      >
        {selected && <Check className="size-3" strokeWidth={3} />}
      </span>
    </button>
  );
}

function DislikeInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const item = raw.trim().toLowerCase();
    if (!item || value.includes(item) || value.length >= 40) return;
    onChange([...value, item]);
    setDraft("");
  };
  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add(draft);
        }}
        className="flex gap-2"
      >
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a food and press enter" maxLength={40} aria-label="Food to avoid" />
        <Button type="submit" variant="secondary" disabled={!draft.trim()}>
          Add
        </Button>
      </form>
      {value.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Foods you'd rather not see">
          {value.map((item) => (
            <li key={item}>
              <button
                type="button"
                onClick={() => onChange(value.filter((v) => v !== item))}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary pl-3.5 pr-2.5 text-[13px] font-medium capitalize text-on-primary"
                aria-label={`Remove ${item}`}
              >
                {item}
                <X className="size-3.5 opacity-70" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mb-3 mt-6 text-[13px] font-semibold text-ink-2">Common ones</p>
      <div className="flex flex-wrap gap-2">
        {DISLIKE_SUGGESTIONS.filter((s) => !value.includes(s)).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => add(s)}
            className="h-9 rounded-full border border-dashed border-line-strong px-3.5 text-[13px] font-medium capitalize text-ink-2 hover:border-ink-4 hover:text-ink"
          >
            + {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function DoneStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand-ink">{n}</span>
      <div>
        <p className="font-semibold">{title}</p>
        <p className="mt-0.5 text-sm leading-relaxed text-ink-3">{children}</p>
      </div>
    </li>
  );
}
