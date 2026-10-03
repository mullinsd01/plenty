"use client";

import { useMemo, useOptimistic, useState } from "react";
import { ArrowDown, ArrowUp, HandHeart, MoreHorizontal, Pencil, Plus, Repeat, ShoppingBasket, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox, Segmented } from "@/components/ui/controls";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { PersonChip } from "@/components/ui/person-chip";
import { Pill } from "@/components/ui/pill";
import { Sheet } from "@/components/ui/sheet";
import { UpgradeNote } from "@/components/ui/upgrade-note";
import { useAction } from "@/components/hooks/use-action";
import { cn } from "@/lib/cn";
import { AISLE_LABELS, AISLE_ORDER, AISLES, CHECK_CUPBOARD_ADVICE, type Aisle } from "@/lib/domain";
import type { MemberOption } from "@/lib/members/types";
import { parseQuickAdd } from "@/lib/quick-add";
import { UNITS, type Unit } from "@/lib/units";
import { HOUSEHOLD_OWNER, OwnerPicker, type OwnerValue } from "@/features/members/owner-picker";
import type { ShoppingItemView } from "@/server/services/shopping";
import {
  addListItemAction,
  addRequestAction,
  completeShopAction,
  createRecurringAction,
  keepSuggestionAction,
  removeListItemAction,
  reorderListAction,
  setListItemCheckedAction,
  updateListItemAction,
} from "./actions";
import { REPEAT_CHOICES } from "./recurring-sheet";

type Update = { type: "check"; id: string; checked: boolean } | { type: "remove"; id: string } | { type: "add"; item: ShoppingItemView };

/** What the signed-in person may do here, worked out on the server from their role and plan. */
export interface ListAccess {
  /** May tick, edit, reorder and remove anything (members and owners). */
  canEdit: boolean;
  canComplete: boolean;
  /** The plan includes private items. */
  canPrivate: boolean;
  /** The plan includes repeating purchases. */
  canRepeat: boolean;
}

export function ListView({ items, members, access }: { items: ShoppingItemView[]; members: MemberOption[]; access: ListAccess }) {
  const [optimistic, apply] = useOptimistic(items, (state, u: Update) => {
    if (u.type === "check") return state.map((i) => (i.id === u.id ? { ...i, checked: u.checked } : i));
    if (u.type === "remove") return state.filter((i) => i.id !== u.id);
    return [...state, u.item];
  });
  const me = members.find((m) => m.isYou) ?? null;
  const colorOf = useMemo(() => new Map(members.map((m) => [m.id, m.color])), [members]);
  const [draft, setDraft] = useState("");
  // Adults can add to the list or ask for something; children can only ask.
  const [mode, setMode] = useState<"add" | "request">(access.canEdit ? "add" : "request");
  const [owner, setOwner] = useState<OwnerValue>(HOUSEHOLD_OWNER);
  const [showOwner, setShowOwner] = useState(false);
  const [editing, setEditing] = useState<ShoppingItemView | null>(null);
  const [finishing, setFinishing] = useState(false);
  const add = useAction();
  const check = useAction();
  const remove = useAction();
  const keep = useAction();
  const reorder = useAction();
  const complete = useAction();

  const requesting = mode === "request";
  const requests = optimistic.filter((i) => !i.checked && i.requestedByMemberId !== null);
  const open = optimistic.filter((i) => !i.checked && i.requestedByMemberId === null && i.advice !== CHECK_CUPBOARD_ADVICE);
  const maybeAtHome = optimistic.filter((i) => !i.checked && i.requestedByMemberId === null && i.advice === CHECK_CUPBOARD_ADVICE);
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
      const quantity = p.quantity ?? (p.packCount > 1 ? p.packCount : null);
      const ownerId = requesting ? (owner.ownerMemberId === null ? null : (me?.id ?? null)) : owner.ownerMemberId;
      const optimisticItem: ShoppingItemView = {
        id: `tmp-${p.name}-${Math.random()}`,
        name: p.name,
        aisle: "other",
        productId: null,
        quantity,
        unit: p.unit,
        quantityLabel: p.quantity && p.unit ? "" : p.packCount > 1 ? `×${p.packCount}` : "",
        source: requesting ? "request" : "manual",
        reason: null,
        advice: null,
        note: null,
        ownerMemberId: requesting ? (me?.id ?? null) : ownerId,
        ownerName: requesting ? (me?.name ?? null) : (members.find((m) => m.id === ownerId)?.name ?? null),
        requestedByMemberId: requesting ? (me?.id ?? null) : null,
        requestedByName: requesting ? (me?.name ?? null) : null,
        visibility: requesting ? "household" : owner.visibility,
        recurring: false,
        suggested: false,
        isMine: true,
        canChange: true,
        checked: false,
        position: 9999,
        sources: [],
      };
      const optimistic = { optimistic: () => apply({ type: "add", item: optimisticItem }) };
      if (requesting) add.run(() => addRequestAction({ name: p.name, quantity, unit: p.unit }), optimistic);
      else
        add.run(
          () =>
            addListItemAction({ name: p.name, quantity, unit: p.unit, ownerMemberId: owner.ownerMemberId, visibility: owner.visibility }),
          optimistic,
        );
    }
  };

  const toggle = (item: ShoppingItemView, checked: boolean) => {
    check.run(() => setListItemCheckedAction(item.id, checked), { optimistic: () => apply({ type: "check", id: item.id, checked }) });
  };

  const del = (item: ShoppingItemView) => {
    remove.run(() => removeListItemAction(item.id), {
      optimistic: () => apply({ type: "remove", id: item.id }),
      onSuccess: () =>
        toast.success(`Removed ${item.name}`, {
          description:
            item.source === "manual" && item.sources.length === 0
              ? undefined
              : item.suggested
                ? "Plenty won't suggest it again before your next shop."
                : undefined,
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

  const rowProps = (item: ShoppingItemView) => ({
    item,
    colorOf,
    canTick: access.canEdit && item.canChange,
    onToggle: (v: boolean) => toggle(item, v),
    onEdit: () => setEditing(item),
    onRemove: () => del(item),
    onKeep: () => keep.run(() => keepSuggestionAction(item.id)),
  });

  return (
    <div className="pb-24">
      <form
        className="mb-6 space-y-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          submitAdd();
        }}
      >
        {access.canEdit && (
          <Segmented
            ariaLabel="What are you doing?"
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: "add", label: "Add to the list" },
              { value: "request", label: "Ask for something" },
            ]}
          />
        )}
        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={requesting ? "Ask for something — “Pepsi Max”" : "Add something — “2 lemons, coffee”"}
            aria-label={requesting ? "Ask for something" : "Add to list"}
            className="flex-1"
          />
          <Button type="submit" disabled={!draft.trim()} aria-label={requesting ? "Ask" : "Add"}>
            {requesting ? <HandHeart /> : <Plus />} <span className="hidden sm:inline">{requesting ? "Ask" : "Add"}</span>
          </Button>
        </div>
        {requesting ? (
          <p className="text-[13px] text-ink-3">
            {access.canEdit
              ? "It goes on the shared list under Requests with your name, and the others are told."
              : "It goes on the shared list with your name, and the adults are told."}
          </p>
        ) : (
          members.length > 1 && (
            <div>
              <button
                type="button"
                onClick={() => setShowOwner((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-full text-[13px] font-medium text-ink-3 transition hover:text-ink"
                aria-expanded={showOwner}
              >
                For:{" "}
                <span className="text-ink-2">
                  {owner.ownerMemberId ? (members.find((m) => m.id === owner.ownerMemberId)?.name ?? "someone") : "Everyone"}
                </span>
                {owner.visibility === "private" && <span className="text-ink-3">· private</span>}
                <span className="underline underline-offset-2">{showOwner ? "done" : "change"}</span>
              </button>
              {showOwner && (
                <div className="mt-2.5 max-w-sm">
                  <OwnerPicker
                    id="list-owner"
                    members={members}
                    value={owner}
                    onChange={setOwner}
                    canPrivate={access.canPrivate}
                    label="Who is it for?"
                  />
                </div>
              )}
            </div>
          )
        )}
      </form>

      {optimistic.length === 0 ? (
        <Card>
          <EmptyState icon={<ShoppingBasket />} title="Nothing to buy right now">
            {access.canEdit
              ? "Add what you need above, or ask for something. As Plenty learns what runs out and what your meals need, it suggests those here too."
              : "Ask for something above and it'll appear here for the others to see."}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          {requests.length > 0 && (
            <section aria-labelledby="requests-heading">
              <h2 id="requests-heading" className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                Requests · {requests.length}
              </h2>
              <Card className="divide-y divide-line">
                {requests.map((item) => (
                  <Row key={item.id} {...rowProps(item)} />
                ))}
              </Card>
            </section>
          )}

          {groups.map((g) => (
            <section key={g.aisle} aria-label={AISLE_LABELS[g.aisle]}>
              <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">{AISLE_LABELS[g.aisle]}</h2>
              <Card className="divide-y divide-line">
                {g.items.map((item, i) => (
                  <Row
                    key={item.id}
                    {...rowProps(item)}
                    onUp={access.canEdit && i > 0 ? () => move(g.items, i, -1) : undefined}
                    onDown={access.canEdit && i < g.items.length - 1 ? () => move(g.items, i, 1) : undefined}
                  />
                ))}
              </Card>
            </section>
          ))}

          {maybeAtHome.length > 0 && (
            <section aria-labelledby="check-cupboard">
              <h2 id="check-cupboard" className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                Check the cupboard first
              </h2>
              <p className="mb-2 mt-1 text-[13px] text-ink-3">
                Your meal plan uses these. Plenty hasn&apos;t seen you buy them, so you may already have them — remove any you do.
              </p>
              <Card className="divide-y divide-line">
                {maybeAtHome.map((item) => (
                  <Row key={item.id} {...rowProps({ ...item, advice: null })} />
                ))}
              </Card>
            </section>
          )}

          {inTrolley.length > 0 && (
            <section aria-label="In your trolley">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">In your trolley · {inTrolley.length}</h2>
              </div>
              <Card className="divide-y divide-line">
                {inTrolley.map((item) => (
                  <Row key={item.id} {...rowProps(item)} />
                ))}
              </Card>
            </section>
          )}
        </div>
      )}

      {access.canComplete && inTrolley.length > 0 && (
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
            <p className="mt-0.5 text-[13px] text-ink-3">
              Clears them from the list. Your receipt will fill in the kitchen with exact sizes and prices.
            </p>
          </button>
          <button
            type="button"
            disabled={complete.pending}
            onClick={() => complete.run(() => completeShopAction(true), { onSuccess: () => setFinishing(false) })}
            className="w-full rounded-xl border border-line p-4 text-left transition hover:border-line-strong"
          >
            <p className="text-[15px] font-semibold">Add them to my kitchen now</p>
            <p className="mt-0.5 text-[13px] text-ink-3">
              Uses the usual pack sizes. If you scan the receipt later, Plenty won&apos;t double up.
            </p>
          </button>
        </div>
      </Sheet>

      <EditSheet item={editing} onClose={() => setEditing(null)} access={access} />
    </div>
  );
}

function Row({
  item,
  colorOf,
  canTick,
  onToggle,
  onEdit,
  onRemove,
  onKeep,
  onUp,
  onDown,
}: {
  item: ShoppingItemView;
  colorOf: ReadonlyMap<string, string>;
  canTick: boolean;
  onToggle: (checked: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
  onKeep: () => void;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const pendingAdd = item.id.startsWith("tmp-");
  const asked = item.requestedByName;
  // "Mum wants Pepsi Max": say who asked. If it's for someone other than the person who asked, say that too.
  const forOther = item.ownerName && item.ownerMemberId !== item.requestedByMemberId ? item.ownerName : null;
  const showOwner = item.ownerName && !asked;
  return (
    <div className={cn("flex items-center gap-3 px-4 py-3", pendingAdd && "opacity-60")}>
      {canTick ? (
        <Checkbox
          checked={item.checked}
          disabled={pendingAdd}
          onCheckedChange={(v) => onToggle(v === true)}
          aria-label={`${item.checked ? "Untick" : "Tick"} ${item.name}`}
          className="size-6"
        />
      ) : (
        <span aria-hidden className="mx-[9px] size-1.5 shrink-0 rounded-full bg-line-strong" />
      )}
      <button
        type="button"
        onClick={onEdit}
        disabled={pendingAdd || !item.canChange}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
      >
        <p
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-medium",
            item.checked && "text-ink-3 line-through decoration-ink-4",
          )}
        >
          <span className="truncate">
            {item.name}
            {item.quantityLabel && <span className="ml-2 font-normal text-ink-3">{item.quantityLabel}</span>}
          </span>
          {showOwner && (
            <PersonChip
              name={item.ownerName!}
              color={item.ownerMemberId ? colorOf.get(item.ownerMemberId) : null}
              isPrivate={item.visibility === "private"}
            />
          )}
          {item.suggested && !item.checked && (
            <Pill tone="brand" size="sm">
              Suggested
            </Pill>
          )}
          {item.recurring && !item.checked && (
            <span className="inline-flex items-center gap-1 text-[12px] font-normal text-ink-3">
              <Repeat className="size-3" aria-hidden /> Repeats
            </span>
          )}
        </p>
        {!item.checked && asked && (
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-ink-3">
            <PersonChip name={asked} color={item.requestedByMemberId ? colorOf.get(item.requestedByMemberId) : null} />
            <span>asked for this{forOther ? ` for ${forOther}` : ""}</span>
          </p>
        )}
        {!item.checked && item.note && <p className="mt-0.5 truncate text-[12px] italic text-ink-3">“{item.note}”</p>}
        {!item.checked && item.reason && <p className="truncate text-[12px] text-ink-3">{item.reason}</p>}
        {!item.checked && item.advice && <p className="truncate text-[12px] text-soon">{item.advice}</p>}
      </button>
      {!pendingAdd && item.canChange && (
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label={`Options for ${item.name}`}
              className="flex size-8 items-center justify-center rounded-full text-ink-4 hover:bg-subtle hover:text-ink"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={onEdit}>
              <Pencil /> Edit or move
            </MenuItem>
            {item.suggested && !item.checked && canTick && (
              <MenuItem onSelect={onKeep}>
                <Plus /> Keep it on my list
              </MenuItem>
            )}
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
              <Trash2 /> {item.suggested ? "Not needed" : "Remove"}
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

const LIST_UNITS: Unit[] = ["each", "g", "kg", "ml", "l", "pack", "bunch", "can", "bottle", "jar", "loaf", "dozen"];

function EditSheet({ item, onClose, access }: { item: ShoppingItemView | null; onClose: () => void; access: ListAccess }) {
  return (
    <Sheet open={item !== null} onOpenChange={(o) => !o && onClose()} title="Edit item" description={item?.reason ?? undefined} size="sm">
      {item && <EditForm key={item.id} item={item} onDone={onClose} access={access} />}
    </Sheet>
  );
}

function EditForm({ item, onDone, access }: { item: ShoppingItemView; onDone: () => void; access: ListAccess }) {
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(item.quantity ? String(item.quantity) : "");
  const [unit, setUnit] = useState<Unit>(item.unit ?? "each");
  const [aisle, setAisle] = useState<Aisle>(item.aisle);
  const [note, setNote] = useState(item.note ?? "");
  const [repeatDays, setRepeatDays] = useState<number | null>(null);
  const save = useAction();
  const qty = quantity ? Number(quantity) : null;
  const valid = name.trim().length > 0 && (qty === null || qty > 0);
  // Only send what the person actually changed: re-saving Plenty's suggested amount would
  // fix it as theirs, so Plenty could no longer adjust it or take the item off when it's not needed.
  const amountChanged = qty !== item.quantity || (qty !== null && unit !== (item.unit ?? "each"));
  const patch = {
    ...(name.trim() !== item.name ? { name: name.trim() } : {}),
    ...(amountChanged ? { quantity: qty, unit: qty ? unit : null } : {}),
    ...(aisle !== item.aisle ? { aisle } : {}),
    ...(note.trim() !== (item.note ?? "") ? { note: note.trim() || null } : {}),
  };
  const canSetRepeat = access.canEdit && !item.recurring && item.requestedByMemberId === null;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const finish = () => {
          if (repeatDays === null) return onDone();
          // The line is already on the list, so the first repeat is one interval from now.
          save.run(
            () =>
              createRecurringAction({
                name: name.trim(),
                quantity: qty,
                unit: qty ? unit : null,
                note: note.trim() || null,
                ownerMemberId: item.ownerMemberId,
                visibility: item.visibility,
                intervalDays: repeatDays,
              }),
            { onSuccess: onDone },
          );
        };
        if (Object.keys(patch).length === 0) return finish();
        save.run(() => updateListItemAction(item.id, patch), { onSuccess: finish });
      }}
    >
      <Field label="Name" htmlFor="li-name">
        <Input id="li-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="How much" htmlFor="li-qty" optional error={qty !== null && !(qty > 0) ? "More than 0" : null}>
          <Input
            id="li-qty"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="Any"
          />
        </Field>
        <Field label="Unit" htmlFor="li-unit">
          <NativeSelect id="li-unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} disabled={!quantity}>
            {(LIST_UNITS.includes(unit) ? LIST_UNITS : [unit, ...LIST_UNITS])
              .filter((u) => (UNITS as readonly string[]).includes(u))
              .map((u) => (
                <option key={u} value={u}>
                  {u === "each" ? "items" : u === "l" ? "L" : u}
                </option>
              ))}
          </NativeSelect>
        </Field>
      </div>
      <Field label="Note" htmlFor="li-note" optional hint="For whoever's shopping: a brand, a size, “the blue one”.">
        <Textarea id="li-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} className="min-h-0" />
      </Field>
      <Field label="Aisle" htmlFor="li-aisle" hint="Moves it to a different part of the list.">
        <NativeSelect id="li-aisle" value={aisle} onChange={(e) => setAisle(e.target.value as Aisle)}>
          {AISLES.map((a) => (
            <option key={a} value={a}>
              {AISLE_LABELS[a]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {canSetRepeat &&
        (access.canRepeat ? (
          <Field
            label="Repeat"
            htmlFor="li-repeat"
            hint="Plenty puts it back on the list on a schedule. You can change or stop it in Regular purchases."
          >
            <NativeSelect
              id="li-repeat"
              value={repeatDays === null ? "" : String(repeatDays)}
              onChange={(e) => setRepeatDays(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Doesn&apos;t repeat</option>
              {REPEAT_CHOICES.map((c) => (
                <option key={c.days} value={c.days}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : (
          <UpgradeNote plan="plus">Repeating this on a schedule is part of Plenty Plus.</UpgradeNote>
        ))}
      {item.ownerName && (
        <p className="text-[13px] text-ink-3">
          For {item.ownerName}
          {item.visibility === "private" ? " — private, only they can see it" : ""}.
        </p>
      )}
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
