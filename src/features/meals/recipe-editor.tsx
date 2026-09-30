"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GripVertical, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/field";
import { useAction } from "@/components/hooks/use-action";
import { UNITS, type Unit } from "@/lib/units";
import { deleteMealAction, editMealAction } from "./actions";

interface IngredientDraft {
  key: number;
  name: string;
  quantity: string;
  unit: Unit | "";
  optional: boolean;
}

export interface RecipeEditorInitial {
  name: string;
  description: string;
  timeMinutes: number;
  servings: number;
  ingredients: Array<{ name: string; quantity: number | null; unit: Unit | null; optional: boolean }>;
  steps: string[];
}

let keySeq = 0;
const nextKey = () => ++keySeq;

export function RecipeEditor({ mealId, initial, canDelete }: { mealId: string; initial: RecipeEditorInitial; canDelete: boolean }) {
  const router = useRouter();
  const save = useAction();
  const del = useAction();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [time, setTime] = useState(String(initial.timeMinutes));
  const [servings, setServings] = useState(String(initial.servings));
  const [ingredients, setIngredients] = useState<IngredientDraft[]>(() =>
    initial.ingredients.map((i) => ({ key: nextKey(), name: i.name, quantity: i.quantity !== null ? String(Math.round(i.quantity * 100) / 100) : "", unit: i.unit ?? "", optional: i.optional })),
  );
  const [steps, setSteps] = useState<Array<{ key: number; text: string }>>(() => initial.steps.map((text) => ({ key: nextKey(), text })));

  const timeN = Number(time);
  const servingsN = Number(servings);
  const errors: string[] = [];
  if (!name.trim()) errors.push("Give the recipe a name.");
  if (!(timeN >= 1 && timeN <= 600)) errors.push("Time should be 1–600 minutes.");
  if (!(servingsN >= 1 && servingsN <= 24)) errors.push("Servings should be 1–24.");
  if (ingredients.filter((i) => i.name.trim()).length === 0) errors.push("Add at least one ingredient.");
  if (steps.filter((s) => s.text.trim()).length === 0) errors.push("Add at least one step.");

  const submit = () => {
    if (errors.length) return;
    save.run(
      () =>
        editMealAction(mealId, {
          name: name.trim(),
          description: description.trim(),
          timeMinutes: Math.round(timeN),
          servings: Math.round(servingsN),
          ingredients: ingredients
            .filter((i) => i.name.trim())
            .map((i) => ({
              name: i.name.trim(),
              quantity: i.quantity && Number(i.quantity) > 0 ? Number(i.quantity) : null,
              unit: i.quantity && i.unit ? i.unit : null,
              optional: i.optional,
            })),
          steps: steps.map((s) => s.text.trim()).filter(Boolean),
        }),
      { onSuccess: (newId) => router.push(`/meals/recipes/${newId}`) },
    );
  };

  return (
    <div className="space-y-8 pb-10">
      <Card className="space-y-4 p-5">
        <Field label="Name" htmlFor="r-name">
          <Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </Field>
        <Field label="Description" htmlFor="r-desc" optional>
          <Textarea id="r-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} className="min-h-16" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Time (minutes)" htmlFor="r-time">
            <Input id="r-time" inputMode="numeric" value={time} onChange={(e) => setTime(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field label="Serves" htmlFor="r-serves">
            <Input id="r-serves" inputMode="numeric" value={servings} onChange={(e) => setServings(e.target.value.replace(/\D/g, ""))} />
          </Field>
        </div>
      </Card>

      <section>
        <h2 className="mb-3 text-[15px] font-semibold">Ingredients</h2>
        <Card className="divide-y divide-line">
          {ingredients.map((ing, idx) => (
            <div key={ing.key} className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:flex-nowrap">
              <GripVertical className="hidden size-4 shrink-0 text-ink-4 sm:block" aria-hidden />
              <Input
                aria-label={`Ingredient ${idx + 1}`}
                value={ing.name}
                placeholder="Ingredient"
                onChange={(e) => setIngredients((list) => list.map((x) => (x.key === ing.key ? { ...x, name: e.target.value } : x)))}
                className="h-10 min-w-0 flex-1 basis-full sm:basis-auto"
              />
              <Input
                aria-label="Amount"
                inputMode="decimal"
                value={ing.quantity}
                placeholder="Qty"
                onChange={(e) => setIngredients((list) => list.map((x) => (x.key === ing.key ? { ...x, quantity: e.target.value.replace(/[^\d.]/g, "") } : x)))}
                className="h-10 w-20"
              />
              <NativeSelect
                aria-label="Unit"
                value={ing.unit}
                onChange={(e) => setIngredients((list) => list.map((x) => (x.key === ing.key ? { ...x, unit: e.target.value as Unit | "" } : x)))}
                className="h-10 w-24"
              >
                <option value="">—</option>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u === "each" ? "whole" : u === "l" ? "L" : u}
                  </option>
                ))}
              </NativeSelect>
              <label className="flex items-center gap-1.5 text-[12px] text-ink-3">
                <input
                  type="checkbox"
                  checked={ing.optional}
                  onChange={(e) => setIngredients((list) => list.map((x) => (x.key === ing.key ? { ...x, optional: e.target.checked } : x)))}
                />
                Optional
              </label>
              <button
                type="button"
                aria-label={`Remove ${ing.name || "ingredient"}`}
                onClick={() => setIngredients((list) => list.filter((x) => x.key !== ing.key))}
                className="flex size-8 items-center justify-center rounded-full text-ink-4 hover:bg-subtle hover:text-alert"
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
        </Card>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => setIngredients((list) => [...list, { key: nextKey(), name: "", quantity: "", unit: "", optional: false }])}
        >
          <Plus /> Add ingredient
        </Button>
      </section>

      <section>
        <h2 className="mb-3 text-[15px] font-semibold">Method</h2>
        <div className="space-y-2">
          {steps.map((step, idx) => (
            <div key={step.key} className="flex gap-2">
              <span className="mt-2.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-subtle text-[12px] font-semibold text-ink-2">{idx + 1}</span>
              <Textarea
                aria-label={`Step ${idx + 1}`}
                value={step.text}
                onChange={(e) => setSteps((list) => list.map((s) => (s.key === step.key ? { ...s, text: e.target.value } : s)))}
                className="min-h-16 flex-1"
                maxLength={600}
              />
              <button
                type="button"
                aria-label={`Remove step ${idx + 1}`}
                onClick={() => setSteps((list) => list.filter((s) => s.key !== step.key))}
                className="mt-1.5 flex size-8 items-center justify-center rounded-full text-ink-4 hover:bg-subtle hover:text-alert"
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setSteps((list) => [...list, { key: nextKey(), text: "" }])}>
          <Plus /> Add step
        </Button>
      </section>

      {errors.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-soon-soft px-4 py-3 text-[13px] text-soon">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        {canDelete && (
          <Button variant="danger-subtle" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> Delete
          </Button>
        )}
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button onClick={submit} loading={save.pending} disabled={errors.length > 0}>
          Save recipe
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this recipe?"
        description="It'll be removed from your recipes. Planned meals using it stay on your plan."
        confirmLabel="Delete"
        destructive
        loading={del.pending}
        onConfirm={() => del.run(() => deleteMealAction(mealId), { onSuccess: () => router.push("/meals/recipes") })}
      />
    </div>
  );
}
