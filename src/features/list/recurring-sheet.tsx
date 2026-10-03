"use client";

import { useState } from "react";
import { Pause, Play, Repeat, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { PersonChip } from "@/components/ui/person-chip";
import { Sheet } from "@/components/ui/sheet";
import { UpgradeNote } from "@/components/ui/upgrade-note";
import { useAction } from "@/components/hooks/use-action";
import type { MemberOption } from "@/lib/members/types";
import type { RecurringView } from "@/server/services/recurring";
import { HOUSEHOLD_OWNER, OwnerPicker, type OwnerValue } from "@/features/members/owner-picker";
import { createRecurringAction, deleteRecurringAction, updateRecurringAction } from "./actions";

export const REPEAT_CHOICES: Array<{ days: number; label: string }> = [
  { days: 1, label: "Every day" },
  { days: 3, label: "Every 3 days" },
  { days: 7, label: "Every week" },
  { days: 14, label: "Every 2 weeks" },
  { days: 28, label: "Every 4 weeks" },
  { days: 30, label: "Every month" },
  { days: 60, label: "Every 2 months" },
];

/** The things set to repeat, with a quick way to add one. */
export function RecurringButton({
  recurring,
  members,
  canUse,
  canPrivate,
  restricted,
}: {
  recurring: RecurringView[];
  members: MemberOption[];
  /** The plan includes regular purchases. */
  canUse: boolean;
  canPrivate: boolean;
  restricted: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (restricted) return null;
  const active = recurring.filter((r) => r.active).length;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label="Regular purchases">
        <Repeat /> <span className="hidden sm:inline">Regular{active > 0 ? ` · ${active}` : ""}</span>
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="Regular purchases"
        description="Things you buy on a schedule. Plenty puts them on the list when they're due — you can still remove one any time."
        size="md"
      >
        <RecurringPanel recurring={recurring} members={members} canUse={canUse} canPrivate={canPrivate} />
      </Sheet>
    </>
  );
}

function RecurringPanel({
  recurring,
  members,
  canUse,
  canPrivate,
}: {
  recurring: RecurringView[];
  members: MemberOption[];
  canUse: boolean;
  canPrivate: boolean;
}) {
  return (
    <div className="space-y-5">
      {!canUse && (
        <UpgradeNote plan="plus">
          Repeating purchases are part of Plenty Plus.{" "}
          {recurring.length > 0
            ? "Yours are paused while you're on the free plan and nothing was deleted."
            : "Your list works as usual without them."}
        </UpgradeNote>
      )}
      {recurring.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {recurring.map((r) => (
            <RecurringRow key={r.id} item={r} canUse={canUse} />
          ))}
        </ul>
      )}
      {canUse && <AddRecurring members={members} canPrivate={canPrivate} />}
    </div>
  );
}

function RecurringRow({ item, canUse }: { item: RecurringView; canUse: boolean }) {
  const toggle = useAction();
  const remove = useAction();
  const change = useAction();
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">
            {item.name}
            {item.quantityLabel && <span className="ml-2 font-normal text-ink-3">{item.quantityLabel}</span>}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
            <span>{item.repeatLabel}</span>
            <span aria-hidden>·</span>
            <span>{item.active ? `next ${item.nextDueLabel.toLowerCase()}` : "paused"}</span>
            {item.ownerName && <PersonChip name={item.ownerName} isPrivate={item.visibility === "private"} />}
          </p>
        </div>
        {!item.active && (
          <Pill tone="neutral" size="sm">
            Paused
          </Pill>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={toggle.pending || (!item.active && !canUse)}
          onClick={() => toggle.run(() => updateRecurringAction(item.id, { active: !item.active }))}
          aria-label={item.active ? `Pause ${item.name}` : `Resume ${item.name}`}
        >
          {item.active ? <Pause /> : <Play />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={remove.pending}
          onClick={() => remove.run(() => deleteRecurringAction(item.id))}
          aria-label={`Stop repeating ${item.name}`}
        >
          <Trash2 />
        </Button>
      </div>
      {canUse && item.active && (
        <NativeSelect
          aria-label={`How often for ${item.name}`}
          value={String(item.intervalDays)}
          disabled={change.pending}
          className="h-9 text-[13px]"
          onChange={(e) => change.run(() => updateRecurringAction(item.id, { intervalDays: Number(e.target.value) }))}
        >
          {(REPEAT_CHOICES.some((c) => c.days === item.intervalDays)
            ? REPEAT_CHOICES
            : [{ days: item.intervalDays, label: item.repeatLabel }, ...REPEAT_CHOICES]
          ).map((c) => (
            <option key={c.days} value={c.days}>
              {c.label}
            </option>
          ))}
        </NativeSelect>
      )}
    </li>
  );
}

function AddRecurring({ members, canPrivate }: { members: MemberOption[]; canPrivate: boolean }) {
  const [name, setName] = useState("");
  const [days, setDays] = useState(7);
  const [owner, setOwner] = useState<OwnerValue>(HOUSEHOLD_OWNER);
  const create = useAction();
  return (
    <form
      className="space-y-3 rounded-xl bg-subtle px-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        create.run(() => createRecurringAction({ name, intervalDays: days, ...owner }), { onSuccess: () => setName("") });
      }}
    >
      <p className="text-[14px] font-semibold">Repeat something new</p>
      <Field label="What" htmlFor="rec-name">
        <Input id="rec-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Milk, nappies, coffee…" maxLength={120} />
      </Field>
      <Field label="How often" htmlFor="rec-days">
        <NativeSelect id="rec-days" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
          {REPEAT_CHOICES.map((c) => (
            <option key={c.days} value={c.days}>
              {c.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {members.length > 1 && (
        <OwnerPicker id="rec-owner" members={members} value={owner} onChange={setOwner} canPrivate={canPrivate} label="Whose is it?" />
      )}
      <Button type="submit" loading={create.pending} disabled={!name.trim()} className="w-full">
        Add regular purchase
      </Button>
    </form>
  );
}
