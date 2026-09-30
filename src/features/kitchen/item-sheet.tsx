"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { LevelPicker } from "@/components/food/level";
import { BasisLabel } from "@/components/food/confidence";
import { Button } from "@/components/ui/button";
import { Stepper } from "@/components/ui/controls";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { useAction } from "@/components/hooks/use-action";
import { STORAGE_LOCATIONS, STORAGE_LOCATION_LABELS, type StorageLocation } from "@/lib/domain";
import type { InventoryItemView } from "@/server/services/inventory";
import { finishItemAction, removeItemAction, restoreItemAction, setLevelAction, updateItemAction } from "./actions";
import { remainingPhrase } from "@/lib/format";

export function useUndoableFinish() {
  const { pending, run } = useAction();
  const undo = useAction();
  const finish = (item: { id: string; name: string }, outcome: "consumed" | "wasted" | "expired", after?: () => void) => {
    run(() => finishItemAction(item.id, outcome), {
      onSuccess: () => {
        after?.();
        const verb = outcome === "consumed" ? "finished" : outcome === "wasted" ? "thrown out" : "gone off";
        toast.success(`${item.name} marked ${verb}`, {
          description: outcome === "consumed" ? "Plenty learned a little more about your pace." : "Plenty will factor this in.",
          action: { label: "Undo", onClick: () => undo.run(() => restoreItemAction(item.id)) },
        });
      },
    });
  };
  return { finish, pending };
}

/**
 * Quick actions for one kitchen item: set how much is left with a tap,
 * finish / waste it, move it, or fix details.
 */
export function ItemSheet({
  item,
  open,
  onOpenChange,
  onLevelChange,
}: {
  item: InventoryItemView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLevelChange?: (id: string, fraction: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const level = useAction();
  const save = useAction();
  const remove = useAction();
  const undo = useAction();
  const { finish, pending: finishing } = useUndoableFinish();

  if (!item) return null;
  const close = () => {
    setEditing(false);
    onOpenChange(false);
  };

  const setFraction = (fraction: number) => {
    level.run(() => setLevelAction(item.id, fraction), {
      optimistic: () => onLevelChange?.(item.id, fraction),
      onSuccess: (r) => {
        if (r.finished) {
          toast.success(`${item.name} marked finished`, {
            action: { label: "Undo", onClick: () => undo.run(() => restoreItemAction(item.id)) },
          });
          close();
        }
      },
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) setEditing(false);
        onOpenChange(o);
      }}
      title={item.name}
      description={`${item.quantityLabel} · ${STORAGE_LOCATION_LABELS[item.location]}`}
    >
      {editing ? (
        <EditForm
          item={item}
          pending={save.pending}
          onCancel={() => setEditing(false)}
          onSave={(patch) => save.run(() => updateItemAction(item.id, patch), { success: "Saved", onSuccess: () => setEditing(false) })}
        />
      ) : (
        <div className="space-y-6">
          {item.prediction && (
            <div className="rounded-xl bg-subtle px-3.5 py-3">
              <p className="text-[14px] font-medium">{remainingPhrase(item.prediction.label)}</p>
              <p className="mt-0.5 text-[13px] text-ink-3">{item.prediction.reason}</p>
              <BasisLabel basis={item.prediction.basis} confidence={item.prediction.confidence} className="mt-1.5" />
            </div>
          )}

          <div>
            <p className="mb-2.5 text-[13px] font-semibold text-ink-2">How much is left?</p>
            {item.countable && item.remainingCount !== null ? (
              <div className="flex items-center justify-between rounded-xl border border-line px-4 py-3">
                <span className="text-[14px] text-ink-2">Left of {item.quantity}</span>
                <Stepper
                  label={`${item.name} left`}
                  value={item.remainingCount}
                  min={0}
                  max={item.quantity}
                  onChange={(count) => setFraction(count / item.quantity)}
                />
              </div>
            ) : (
              <LevelPicker value={item.estimatedFraction} onChange={setFraction} disabled={level.pending} />
            )}
            <p className="mt-2 text-[12px] text-ink-4">Plenty estimates this between updates — you only need to correct it when it&apos;s wrong.</p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Button variant="secondary" disabled={finishing} onClick={() => finish(item, "consumed", close)}>
              <Check /> Finished
            </Button>
            <Button variant="secondary" disabled={finishing} onClick={() => finish(item, "wasted", close)}>
              Threw out
            </Button>
            <Button variant="secondary" disabled={finishing} onClick={() => finish(item, "expired", close)}>
              Went off
            </Button>
          </div>

          <div className="flex flex-col gap-1 border-t border-line pt-4">
            <button type="button" onClick={() => setEditing(true)} className="flex items-center justify-between rounded-lg px-1 py-2 text-left text-[14px] font-medium hover:text-ink">
              Edit details, move or set a use-by date
              <ArrowRight className="size-4 text-ink-4" />
            </button>
            <Link href={`/kitchen/${item.id}`} className="flex items-center justify-between rounded-lg px-1 py-2 text-[14px] font-medium" onClick={close}>
              History and what Plenty has learned
              <ArrowRight className="size-4 text-ink-4" />
            </Link>
            <button
              type="button"
              disabled={remove.pending}
              onClick={() =>
                remove.run(() => removeItemAction(item.id), {
                  onSuccess: () => {
                    toast.success(`${item.name} removed`, { action: { label: "Undo", onClick: () => undo.run(() => restoreItemAction(item.id)) } });
                    close();
                  },
                })
              }
              className="flex items-center gap-2 rounded-lg px-1 py-2 text-left text-[14px] font-medium text-alert"
            >
              <Trash2 className="size-4" /> Remove — added by mistake
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function EditForm({
  item,
  pending,
  onCancel,
  onSave,
}: {
  item: InventoryItemView;
  pending: boolean;
  onCancel: () => void;
  onSave: (patch: { name: string; location: StorageLocation; quantity: number; actualExpiry: string | null; notes: string | null }) => void;
}) {
  const [name, setName] = useState(item.name);
  const [location, setLocation] = useState<StorageLocation>(item.location);
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [expiry, setExpiry] = useState(item.expiryIsActual ? item.expiresOn ?? "" : "");
  const [notes, setNotes] = useState(item.notes ?? "");
  const qty = Number(quantity);
  const invalid = !name.trim() || !(qty > 0);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return;
        onSave({ name: name.trim(), location, quantity: qty, actualExpiry: expiry || null, notes: notes.trim() || null });
      }}
    >
      <Field label="Name" htmlFor="item-name">
        <Input id="item-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={`Amount (${item.unit === "each" ? "items" : item.unit})`} htmlFor="item-qty" error={qty > 0 ? null : "Must be more than zero"}>
          <Input id="item-qty" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^\d.]/g, ""))} />
        </Field>
        <Field label="Kept in" htmlFor="item-location">
          <NativeSelect id="item-location" value={location} onChange={(e) => setLocation(e.target.value as StorageLocation)}>
            {STORAGE_LOCATIONS.map((l) => (
              <option key={l} value={l}>
                {STORAGE_LOCATION_LABELS[l]}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field
        label="Use-by date"
        htmlFor="item-expiry"
        optional
        hint={item.expiresOn && !item.expiryIsActual ? `Plenty estimates ${item.expiresOn}. Set the printed date if you know it.` : undefined}
      >
        <Input id="item-expiry" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
      </Field>
      <Field label="Notes" htmlFor="item-notes" optional>
        <Input id="item-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      </Field>
      <div className="flex gap-2 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="flex-1">
          Cancel
        </Button>
        <Button type="submit" loading={pending} disabled={invalid} className="flex-1">
          Save
        </Button>
      </div>
    </form>
  );
}
