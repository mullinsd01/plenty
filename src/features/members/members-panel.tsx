"use client";

import { useState } from "react";
import Link from "next/link";
import { MoreHorizontal, Pencil, Plus, Trash2, UtensilsCrossed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChipGroup, Segmented } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Field, Input } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Pill } from "@/components/ui/pill";
import { initialsOf } from "@/components/ui/person-chip";
import { Sheet } from "@/components/ui/sheet";
import { UpgradeNote } from "@/components/ui/upgrade-note";
import { useAction } from "@/components/hooks/use-action";
import type { PlanId } from "@/lib/billing/plans";
import { ALLERGENS, ALLERGEN_LABELS, DIETS, DIET_LABELS, type Allergen, type Diet } from "@/lib/domain";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from "@/lib/members/permissions";
import { removeMemberAction } from "@/features/settings/actions";
import { addPersonAction, setFoodRulesAction, updatePersonAction } from "./actions";

export interface PersonRow {
  id: string;
  name: string;
  role: Role;
  color: string;
  hasAccount: boolean;
  isYou: boolean;
  email: string | null;
  /** The signed-in person may open this person's food rules. */
  canEditRules: boolean;
}

export const PERSON_COLORS = ["#E0654B", "#3B6FA5", "#4F8A5B", "#B07A2A", "#7A5AA6", "#2F8F8B", "#B5527A", "#6B7280"];

function Dot({ name, color }: { name: string; color: string }) {
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white"
      style={{ backgroundColor: color }}
    >
      {initialsOf(name)}
    </span>
  );
}

/** Everyone in the household, with what an owner can do about each of them. */
export function PeopleList({ people, isOwner }: { people: PersonRow[]; isOwner: boolean }) {
  const [editing, setEditing] = useState<PersonRow | null>(null);
  const [removing, setRemoving] = useState<PersonRow | null>(null);
  const remove = useAction();
  return (
    <>
      <ul className="divide-y divide-line">
        {people.map((p) => (
          <li key={p.id} className="flex items-center gap-3 py-3">
            <Dot name={p.name} color={p.color} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-medium">
                <span className="truncate">{p.name}</span>
                {p.isYou && <span className="text-[13px] font-normal text-ink-3">(you)</span>}
                {!p.hasAccount && (
                  <Pill tone="neutral" size="sm">
                    No account
                  </Pill>
                )}
              </p>
              <p className="truncate text-[13px] text-ink-3">
                {ROLE_LABELS[p.role]}
                {p.email ? ` · ${p.email}` : ""}
              </p>
            </div>
            {(p.canEditRules || isOwner || p.isYou) && (
              <Menu>
                <MenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Options for ${p.name}`}
                    className="flex size-8 items-center justify-center rounded-full text-ink-4 hover:bg-subtle hover:text-ink"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                </MenuTrigger>
                <MenuContent>
                  {(isOwner || p.isYou) && (
                    <MenuItem onSelect={() => setEditing(p)}>
                      <Pencil /> {p.isYou && !isOwner ? "Edit my name and colour" : "Edit"}
                    </MenuItem>
                  )}
                  {p.canEditRules && (
                    <MenuItem asChild>
                      <Link href={`/settings/people/${p.id}`}>
                        <UtensilsCrossed /> Food rules
                      </Link>
                    </MenuItem>
                  )}
                  {isOwner && !p.isYou && (
                    <MenuItem destructive onSelect={() => setRemoving(p)}>
                      <Trash2 /> Remove
                    </MenuItem>
                  )}
                </MenuContent>
              </Menu>
            )}
          </li>
        ))}
      </ul>

      <Sheet open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title="Edit person" size="sm">
        {editing && <EditPerson key={editing.id} person={editing} isOwner={isOwner} onDone={() => setEditing(null)} />}
      </Sheet>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? `Remove ${removing.name}?` : "Remove"}
        description={
          removing
            ? `${removing.name} will no longer see this household. Anything they marked private is deleted with them; what they shared stays with the household. This can't be undone.`
            : ""
        }
        confirmLabel="Remove"
        destructive
        loading={remove.pending}
        onConfirm={() => removing && remove.run(() => removeMemberAction(removing.id), { onSuccess: () => setRemoving(null) })}
      />
    </>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-2">
      {PERSON_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c.toLowerCase()}
          aria-label={c}
          onClick={() => onChange(c)}
          className="size-8 rounded-full ring-offset-2 ring-offset-surface transition aria-checked:ring-2 aria-checked:ring-ink"
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}

function EditPerson({ person, isOwner, onDone }: { person: PersonRow; isOwner: boolean; onDone: () => void }) {
  const [name, setName] = useState(person.name);
  const [color, setColor] = useState(person.color);
  const [role, setRole] = useState<Role>(person.role);
  const save = useAction();
  const patch = {
    ...(name.trim() !== person.name ? { name: name.trim() } : {}),
    ...(color !== person.color ? { color } : {}),
    ...(role !== person.role ? { role } : {}),
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        if (Object.keys(patch).length === 0) return onDone();
        save.run(() => updatePersonAction(person.id, patch), { onSuccess: onDone });
      }}
    >
      <Field label="Name" htmlFor="person-name" hint="This is how they appear on the list and on items.">
        <Input id="person-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </Field>
      <Field label="Colour">
        <ColorPicker value={color} onChange={setColor} />
      </Field>
      {isOwner && (
        <Field label="Role" hint={ROLE_DESCRIPTIONS[role]}>
          <Segmented
            ariaLabel="Role"
            className="w-full"
            value={role}
            onChange={setRole}
            // Somebody who can't sign in can't run the household, so only account holders can be owners.
            options={(["owner", "member", "child"] as const)
              .filter((r) => r !== "owner" || person.hasAccount)
              .map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
          />
        </Field>
      )}
      <div className="flex gap-2 pt-1">
        <Button type="button" variant="secondary" className="flex-1" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" className="flex-1" loading={save.pending} disabled={!name.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** Add someone who doesn't have an account — a child, or a person who doesn't use the app. */
export function AddPersonButton({
  allowed,
  limitNote,
  upgradePlan,
  nextColor,
}: {
  /** Owners only. */
  allowed: boolean;
  /** Set when the plan's people limit has been reached. */
  limitNote: string | null;
  /** The plan that would lift the limit. */
  upgradePlan: PlanId;
  nextColor: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"child" | "member">("child");
  const [color, setColor] = useState(nextColor);
  const add = useAction();
  if (!allowed) return null;
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Plus /> Add a person
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="Add a person"
        description="For someone who doesn't need their own account: a child, or a housemate who won't use the app. Food can be assigned to them and they can have requests made for them."
        size="sm"
      >
        {limitNote ? (
          <UpgradeNote plan={upgradePlan} feature="members">{limitNote}</UpgradeNote>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              add.run(() => addPersonAction({ name, role, color }), {
                onSuccess: () => {
                  setName("");
                  setOpen(false);
                },
              });
            }}
          >
            <Field label="Name" htmlFor="new-person-name">
              <Input
                id="new-person-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                placeholder="e.g. Ollie"
                autoFocus
              />
            </Field>
            <Field label="Colour">
              <ColorPicker value={color} onChange={setColor} />
            </Field>
            <Field label="They are" hint={ROLE_DESCRIPTIONS[role]}>
              <Segmented
                ariaLabel="Role"
                className="w-full"
                value={role}
                onChange={setRole}
                options={[
                  { value: "child", label: "A child" },
                  { value: "member", label: "An adult" },
                ]}
              />
            </Field>
            <Button type="submit" className="w-full" loading={add.pending} disabled={!name.trim()}>
              Add to household
            </Button>
          </form>
        )}
      </Sheet>
    </>
  );
}

/** One person's own diets, allergies and dislikes. */
export function FoodRulesForm({
  memberId,
  name,
  initial,
}: {
  memberId: string;
  name: string;
  initial: { diets: string[]; allergies: string[]; dislikedIngredients: string[] };
}) {
  const [diets, setDiets] = useState(initial.diets as Diet[]);
  const [allergies, setAllergies] = useState(initial.allergies as Allergen[]);
  const [dislikes, setDislikes] = useState(initial.dislikedIngredients);
  const [draft, setDraft] = useState("");
  const save = useAction();
  const addDislike = () => {
    const v = draft.trim().toLowerCase();
    if (v && !dislikes.includes(v)) setDislikes([...dislikes, v]);
    setDraft("");
  };
  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-[14px] font-semibold">Allergies</h3>
        <p className="mb-3 mt-0.5 text-[13px] text-ink-3">
          Plenty leaves meals with these out of its suggestions. It&apos;s a filter to help, not a guarantee — always check labels and
          ingredients yourself.
        </p>
        <ChipGroup
          ariaLabel={`${name}'s allergies`}
          value={allergies}
          onChange={setAllergies}
          options={ALLERGENS.map((a) => ({ value: a, label: ALLERGEN_LABELS[a] }))}
        />
      </section>
      <section>
        <h3 className="mb-3 text-[14px] font-semibold">Diets</h3>
        <ChipGroup
          ariaLabel={`${name}'s diets`}
          value={diets}
          onChange={setDiets}
          options={DIETS.map((d) => ({ value: d, label: DIET_LABELS[d] }))}
        />
      </section>
      <section>
        <h3 className="mb-3 text-[14px] font-semibold">Foods they&apos;d rather not see</h3>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addDislike();
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. mushrooms"
            aria-label="Add a food to avoid"
            maxLength={40}
          />
          <Button type="submit" variant="secondary" disabled={!draft.trim()}>
            Add
          </Button>
        </form>
        {dislikes.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {dislikes.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDislikes(dislikes.filter((x) => x !== d))}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3 text-[13px] font-medium capitalize text-on-primary"
                aria-label={`Remove ${d}`}
              >
                {d} <span aria-hidden>×</span>
              </button>
            ))}
          </div>
        )}
      </section>
      <div className="flex justify-end">
        <Button
          loading={save.pending}
          onClick={() => save.run(() => setFoodRulesAction(memberId, { diets, allergies, dislikedIngredients: dislikes }))}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
