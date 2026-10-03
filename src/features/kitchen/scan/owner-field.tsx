"use client";

import { useState } from "react";
import { HOUSEHOLD_OWNER, OwnerPicker, type OwnerValue } from "@/features/members/owner-picker";
import { usePeople } from "@/features/members/people-context";

export { HOUSEHOLD_OWNER, type OwnerValue };

/** What to send for ownership: nothing for someone who can only add their own things (the server marks them as theirs). */
export function ownershipFor(restricted: boolean, owner: OwnerValue) {
  return restricted ? {} : { ownerMemberId: owner.ownerMemberId, visibility: owner.visibility };
}

/** "Whose is it?" — the same quiet control as the add sheet: a one-line summary that opens the picker. */
export function OwnerField({ value, onChange, id }: { value: OwnerValue; onChange: (value: OwnerValue) => void; id: string }) {
  const people = usePeople();
  const [open, setOpen] = useState(false);
  if (people.restricted) return <p className="text-[13px] text-ink-3">Things you add are marked as yours.</p>;
  if (people.members.length <= 1) return null;
  const name = value.ownerMemberId ? (people.members.find((m) => m.id === value.ownerMemberId)?.name ?? "someone") : "Everyone";
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-3 transition hover:text-ink"
      >
        Whose is it: <span className="text-ink-2">{name}</span>
        {value.visibility === "private" && <span>· private</span>}
        <span className="underline underline-offset-2">{open ? "done" : "change"}</span>
      </button>
      {open && (
        <div className="mt-2.5">
          <OwnerPicker id={id} members={people.members} value={value} onChange={onChange} canPrivate={people.canPrivate} label="Whose is it?" />
        </div>
      )}
    </div>
  );
}
