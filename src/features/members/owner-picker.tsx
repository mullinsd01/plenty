"use client";

import { Lock } from "lucide-react";
import { NativeSelect, Field } from "@/components/ui/field";
import { Switch } from "@/components/ui/controls";
import type { MemberOption } from "@/lib/members/types";

export interface OwnerValue {
  /** A member id, or null for the household. */
  ownerMemberId: string | null;
  visibility: "household" | "private";
}

export const HOUSEHOLD_OWNER: OwnerValue = { ownerMemberId: null, visibility: "household" };

/**
 * "Whose is it?" — the household's, or one person's — plus, on plans with individual
 * ownership, a switch that keeps it private to its owner. People who can only act for themselves
 * (children) are shown just themselves.
 */
export function OwnerPicker({
  members,
  value,
  onChange,
  canPrivate,
  restrictedToSelf,
  id = "owner",
  label = "Whose is it?",
  hint,
}: {
  members: MemberOption[];
  value: OwnerValue;
  onChange: (value: OwnerValue) => void;
  /** The plan includes private items (Family). */
  canPrivate: boolean;
  /** The signed-in person may only choose themselves. */
  restrictedToSelf?: boolean;
  id?: string;
  label?: string;
  hint?: string;
}) {
  const me = members.find((m) => m.isYou) ?? null;
  const options = restrictedToSelf ? members.filter((m) => m.isYou) : members;
  const mine = value.ownerMemberId !== null && value.ownerMemberId === me?.id;
  return (
    <div className="space-y-2.5">
      <Field label={label} htmlFor={id} hint={hint}>
        <NativeSelect
          id={id}
          value={value.ownerMemberId ?? ""}
          onChange={(e) => {
            const owner = e.target.value || null;
            // Private only makes sense for your own things.
            onChange({ ownerMemberId: owner, visibility: owner !== null && owner === me?.id ? value.visibility : "household" });
          }}
        >
          {!restrictedToSelf && <option value="">Everyone — the household</option>}
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.isYou ? `${m.name} (you)` : m.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {mine && canPrivate && (
        <label className="flex items-start justify-between gap-4 rounded-xl border border-line px-3.5 py-3">
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-[14px] font-semibold">
              <Lock className="size-3.5 text-ink-3" aria-hidden /> Keep it private
            </span>
            <span className="mt-0.5 block text-[13px] text-ink-3">
              Only you can see it, and nothing Plenty learns from it is shown to anyone else.
            </span>
          </span>
          <Switch
            checked={value.visibility === "private"}
            onCheckedChange={(on) => onChange({ ...value, visibility: on ? "private" : "household" })}
            aria-label="Keep it private"
          />
        </label>
      )}
    </div>
  );
}
