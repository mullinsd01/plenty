"use client";

import { startTransition, useMemo, useOptimistic, useState } from "react";
import { ArrowDown, ArrowUp, MoreHorizontal, Pencil, Plus, ShoppingBasket, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/controls";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Sheet } from "@/components/ui/sheet";
import { useAction } from "@/components/hooks/use-action";
import { cn } from "@/lib/cn";
import { AISLE_LABELS, AISLE_ORDER, AISLES, type Aisle } from "@/lib/domain";
import { parseQuickAdd } from "@/lib/quick-add";
import { UNITS, type Unit } from "@/lib/units";
import type { ShoppingItemView } from "@/server/services/shopping";
import {
  addListItemAction,
  completeShopAction,
  removeListItemAction,
  reorderListAction,
  setListItemCheckedAction,
  updateListItemAction,
} from "./actions";

type Update = { type: "check"; id: string; checked: boolean } | { type: "remove"; id: string } | { type: "add"; item: ShoppingItemView };

export function ListView({ items }: { items: ShoppingItemView[] }) {
  const [optimistic, apply] = useOptimistic(items, (state, u: Update) => {
    if (u.type === "check") return state.map((i) => (i.id === u.id ? { ...i, checked: u.checked } : i));
    if (u.type === "remove") return state.filter((i) => i.id !== u.id);
    return [...state, u.item];
  });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<ShoppingItemView | null>(null);
  const [finishing, setFinishing] = useState(false);
  const add = useAction();
  const check = useAction();
  const remove = useAction();
  const reorder = useAction();
  const complete = useAction();

  const open = optimistic.filter((i) => !i.checked);
  const inTrolley = optimistic.filter((i) => i.checked);
  const groups = useMemo(
    () =>
      AISLE_ORDER.map((aisle) => ({ aisle, items: open.filter((i) => i.aisle === aisle).sort((a, b) => a.position - b.position) })).filter(
        (g) => g.items.length > 0,
      ),
    [open],
  );

  const submitAdd = () => {
    const parsed = parseQuickAdd(draft);
    if (parsed.length === 0) return;
    setDraft("");
    for (const p of parsed) {
      startTransition(() =>
        apply({
          type: "add",
          item: {
            id: `tmp-${p.name}-${Math.random()}`,
            name: p.name,
            aisle: "other",
            productId: null,
            quantity: p.quantity ?? (p.packCount > 1 ? p.packCount : null),
            unit: p.unit,
            quantityLabel: p.quantity && p.unit ? "" : p.packCount > 1 ? `×${p.packCount}` : "",
            source: "manual",
            reason: null,
            advice: null,
            checked: false,
            position: 9999,
            sources: [],
          },
        }),
      );
      add.run(() => addListItemAction({ name: p.name, quantity: p.quantity ?? (p.packCount > 1 ? p.packCount : null), unit: p.unit }));
    }
  };

  const toggle = (item: ShoppingItemView, checked: boolean) => {
    startTransition(() => apply({ type: "check", id: item.id, checked }));
    check.run(() => setListItemCheckedAction(item.id, checked));
  };

  const del = (item: ShoppingItemView) => {
    startTransition(() => apply({ type: "remove", id: item.id }));
    remove.run(() => removeListItemAction(item.id), {
      onSuccess: () =>
        toast.success(item.source === "manual" ? `Removed ${item.name}` : `Removed ${item.name}`, {
          description: item.source === "manual" ? undefined : "Plenty won't add it again before your next shop.",
        }),
    });
  };

  const move = (group: ShoppingItemView[], index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= group.length) return;
    const ids = group.map((g) => g.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.run(() => reorderListAction(ids));
  };

  return (
    <div className="pb-24">
      <form
        className="mb-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submitAdd();
        }}
      >
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add something — “2 lemons, coffee”" aria-label="Add to list" className="flex-1" />
        <Button type="submit" disabled={!draft.trim()} aria-label="Add">
          <Plus /> <span className="hidden sm:inline">Add</span>
        </Button>
      </form>

      {optimistic.length === 0 ? (
        <Card>
          <EmptyState icon={<ShoppingBasket />} title="Nothing to buy right now">
            Plenty adds things as they&apos;re about to run out and whatever your meal plan needs — so this fills itself in. Add anything
            else above.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.aisle} aria-label={AISLE_LABELS[g.aisle]}>
              <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">{AISLE_LABELS[g.aisle]}</h2>
              <Card className="divide-y divide-line">
                {g.items.map((item, i) => (
                  <Row
                    key={item.id}
                    item={item}
                    onToggle={(v) => toggle(item, v)}
                    onEdit={() => setEditing(item)}
                    onRemove={() => del(item)}
                    onUp={i > 0 ? () => move(g.items, i, -1) : undefined}
                    onDown={i < g.items.length - 1 ? () => move(g.items, i, 1) : undefined}
                  />
                ))}
              </Card>
            </section>
          ))}

          {inTrolley.length > 0 && (
            <section aria-label="In your trolley">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">In your trolley · {inTrolley.length}</h2>
              </div>
              <Card className="divide-y divide-line">
                {inTrolley.map((item) => (
                  <Row key={item.id} item={item} onToggle={(v) => toggle(item, v)} onEdit={() => setEditing(item)} onRemove={() => del(item)} />
                ))}
              </Card>
            </section>
          )}
        </div>
      )}

      {inTrolley.length > 0 && (
        <div className="pb-safe fixed inset-x-0 bottom-16 z-30 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur-md lg:bottom-0 lg:left-[252px]">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <p className="flex-1 text-[14px] text-ink-2">
              {inTrolley.length} of {optimistic.length} in the trolley
            </p>
            <Button onClick={() => setFinishing(true)}>Finish shop</Button>
          </div>
        </div>
      )}

      <Sheet
        open={finishing}
        onOpenChange={setFinishing}
        title="Finish your shop"
        description={`What should Plenty do with the ${inTrolley.length} things you ticked off?`}
        size="sm"
      >
        <div className="space-y-2">
          <button
            type="button"
            disabled={complete.pending}
            onClick={() => complete.run(() => completeShopAction(false), { onSuccess: () => setFinishing(false) })}
            className="w-full rounded-xl border border-line p-4 text-left transition hover:border-line-strong"
          >
            <p className="text-[15px] font-semibold">I&apos;ll scan the receipt</p>
            <p className="mt-0.5 text-[13px] text-ink-3">Clears them from the list. Your receipt will fill in the kitchen with exact sizes and prices.</p>
          </button>
          <button
            type="button"
            disabled={complete.pending}
            onClick={() => complete.run(() => completeShopAction(true), { onSuccess: () => setFinishing(false) })}
            className="w-full rounded-xl border border-line p-4 text-left transition hover:border-line-strong"
          >
            <p className="text-[15px] font-semibold">Add them to my kitchen now</p>
            <p className="mt-0.5 text-[13px] text-ink-3">Uses the usual pack sizes. If you scan the receipt later, Plenty won&apos;t double up.</p>
          </button>
        </div>
      </Sheet>

      <EditSheet item={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function Row({
  item,
  onToggle,
  onEdit,
  onRemove,
  onUp,
  onDown,
}: {
  item: ShoppingItemView;
  onToggle: (checked: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const pendingAdd = item.id.startsWith("tmp-");
  return (
    <div className={cn("flex items-center gap-3 px-4 py-3", pendingAdd && "opacity-60")}>
      <Checkbox checked={item.checked} disabled={pendingAdd} onCheckedChange={(v) => onToggle(v === true)} aria-label={`${item.checked ? "Untick" : "Tick"} ${item.name}`} className="size-6" />
      <button type="button" onClick={onEdit} disabled={pendingAdd} className="min-w-0 flex-1 text-left">
        <p className={cn("truncate text-[15px] font-medium", item.checked && "text-ink-3 line-through decoration-ink-4")}>
          {item.name}
          {item.quantityLabel && <span className="ml-2 font-normal text-ink-3">{item.quantityLabel}</span>}
        </p>
        {!item.checked && item.reason && <p className="truncate text-[12px] text-ink-3">{item.reason}</p>}
        {!item.checked && item.advice && <p className="truncate text-[12px] text-soon">{item.advice}</p>}
      </button>
      {!pendingAdd && (
        <Menu>
          <MenuTrigger asChild>
            <button type="button" aria-label={`Options for ${item.name}`} className="flex size-8 items-center justify-center rounded-full text-ink-4 hover:bg-subtle hover:text-ink">
              <MoreHorizontal className="size-4" />
            </button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={onEdit}>
              <Pencil /> Edit or move
            </MenuItem>
            {onUp && (
              <MenuItem onSelect={onUp}>
                <ArrowUp /> Move up
              </MenuItem>
            )}
            {onDown && (
              <MenuItem onSelect={onDown}>
                <ArrowDown /> Move down
              </MenuItem>
            )}
            <MenuItem destructive onSelect={onRemove}>
              <Trash2 /> Remove
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

const LIST_UNITS: Unit[] = ["each", "g", "kg", "ml", "l", "pack", "bunch", "can", "bottle", "jar", "loaf", "dozen"];

function EditSheet({ item, onClose }: { item: ShoppingItemView | null; onClose: () => void }) {
  return (
    <Sheet open={item !== null} onOpenChange={(o) => !o && onClose()} title="Edit item" description={item?.reason ?? undefined} size="sm">
      {item && <EditForm key={item.id} item={item} onDone={onClose} />}
    </Sheet>
  );
}

function EditForm({ item, onDone }: { item: ShoppingItemView; onDone: () => void }) {
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(item.quantity ? String(item.quantity) : "");
  const [unit, setUnit] = useState<Unit>(item.unit ?? "each");
  const [aisle, setAisle] = useState<Aisle>(item.aisle);
  const save = useAction();
  const qty = quantity ? Number(quantity) : null;
  const valid = name.trim().length > 0 && (qty === null || qty > 0);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        save.run(() => updateListItemAction(item.id, { name: name.trim(), quantity: qty, unit: qty ? unit : null, aisle }), { onSuccess: onDone });
      }}
    >
      <Field label="Name" htmlFor="li-name">
        <Input id="li-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="How much" htmlFor="li-qty" optional error={qty !== null && !(qty > 0) ? "More than 0" : null}>
          <Input id="li-qty" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^\d.]/g, ""))} placeholder="Any" />
        </Field>
        <Field label="Unit" htmlFor="li-unit">
          <NativeSelect id="li-unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} disabled={!quantity}>
            {(LIST_UNITS.includes(unit) ? LIST_UNITS : [unit, ...LIST_UNITS]).filter((u) => (UNITS as readonly string[]).includes(u)).map((u) => (
              <option key={u} value={u}>
                {u === "each" ? "items" : u === "l" ? "L" : u}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field label="Aisle" htmlFor="li-aisle" hint="Moves it to a different part of the list.">
        <NativeSelect id="li-aisle" value={aisle} onChange={(e) => setAisle(e.target.value as Aisle)}>
          {AISLES.map((a) => (
            <option key={a} value={a}>
              {AISLE_LABELS[a]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {item.sources.length > 0 && (
        <div className="rounded-xl bg-subtle px-3.5 py-3 text-[13px] text-ink-2">
          <p className="mb-1 font-semibold">Why it&apos;s on your list</p>
          <ul className="space-y-0.5">
            {item.sources.map((s, i) => (
              <li key={i}>{s.note}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <Button type="button" variant="secondary" className="flex-1" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" className="flex-1" loading={save.pending} disabled={!valid}>
          Save
        </Button>
      </div>
    </form>
  );
}
