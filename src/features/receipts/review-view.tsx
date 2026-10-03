"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, ChevronRight, Info, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox, Segmented } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { PersonChip } from "@/components/ui/person-chip";
import { useAction } from "@/components/hooks/use-action";
import { HOUSEHOLD_OWNER, OwnerPicker, type OwnerValue } from "@/features/members/owner-picker";
import { usePeople } from "@/features/members/people-context";
import { cn } from "@/lib/cn";
import { STORAGE_LOCATIONS, STORAGE_LOCATION_LABELS, type StorageLocation } from "@/lib/domain";
import { formatMoney } from "@/lib/format";
import { formatPackQuantity, formatQuantity, UNITS, type Unit } from "@/lib/units";
import type { ReceiptReview, ReceiptReviewItem } from "@/server/services/receipts";
import { confirmReceiptAction, discardReceiptAction } from "./actions";

interface Draft {
  id: string;
  include: boolean;
  name: string;
  productId: string | null;
  productName: string | null;
  quantity: number;
  unit: Unit;
  packCount: number;
  location: StorageLocation;
  existingDecision: "replace" | "keep" | "merge" | null;
  /** Set when this line is for someone other than the receipt's default. */
  owner?: OwnerValue;
}

const WARNING_TEXT: Record<string, string> = {
  duplicate: "This looks like a receipt you've already added. Discard it unless you really bought all this twice.",
  duplicate_pending: "This looks like the same receipt as one that's still waiting to be checked. Keep just one of them, unless you really bought all this twice.",
  blurry: "The photo was a little blurry, so double-check the items below.",
  no_date: "We couldn't find the date on this receipt — we've assumed today. Change it below if needed.",
  ai_fallback: "Our AI reader was busy, so this was read on-device. Give the names a quick check.",
  total_mismatch: "The items don't quite add up to the receipt total — some lines may be missing or misread.",
  partial: "Part of the receipt may be cut off. Add anything that's missing from your kitchen afterwards.",
  low_resolution: "The photo is quite small, so some lines may be misread.",
  unclear: "Parts of the receipt were hard to read, so double-check the items below.",
};

function toDraft(item: ReceiptReviewItem): Draft {
  return {
    id: item.id,
    include: item.status !== "ignored",
    name: item.name,
    productId: item.productId,
    productName: item.productName,
    quantity: item.quantity,
    unit: item.unit,
    packCount: item.packCount,
    location: item.location,
    existingDecision: item.existing?.suggestion ?? null,
  };
}

function amountLabel(d: Draft): string {
  return formatPackQuantity(d.quantity, d.unit, d.packCount);
}

/** The amount in one pack, as shown for editing (drafts hold the total across packs). */
function perPackText(d: Draft): string {
  return String(Math.round((d.quantity / d.packCount) * 1000) / 1000);
}

function localeDecimal(): string {
  return new Intl.NumberFormat().formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
}

/** A typed amount. A decimal comma ("1,5" on many phone keyboards) counts as a point; "1,500" groups thousands where that's the local style. */
function parseAmount(text: string): number {
  const t = text.trim();
  if (!t) return NaN;
  const comma = t.lastIndexOf(",");
  const point = t.lastIndexOf(".");
  if (comma < 0) return Number(t);
  if (point >= 0) return Number(comma > point ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, ""));
  const grouping = /^\d{1,3}(,\d{3})+$/.test(t) && localeDecimal() === ".";
  return Number(grouping ? t.replace(/,/g, "") : t.replace(",", "."));
}

export function ReviewView({ review, currency, today }: { review: ReceiptReview; currency: string; today: string }) {
  const router = useRouter();
  const [store, setStore] = useState(review.storeName ?? "");
  const [date, setDate] = useState(review.purchasedOn ?? today);
  const [drafts, setDrafts] = useState<Draft[]>(() => review.items.map(toDraft));
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Whose the shopping is: the household's, or one person's (on plans that allow it, privately). A line can differ.
  const [defaultOwner, setDefaultOwner] = useState<OwnerValue>(HOUSEHOLD_OWNER);
  const [showOwner, setShowOwner] = useState(false);
  const people = usePeople();
  const ownerOf = (d: Draft): OwnerValue => d.owner ?? defaultOwner;
  const confirm = useAction();
  const discard = useAction();

  const byId = useMemo(() => new Map(review.items.map((i) => [i.id, i])), [review.items]);
  const update = (id: string, patch: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const checkFirst = drafts.filter((d) => byId.get(d.id)!.certainty !== "confident" && byId.get(d.id)!.status !== "ignored");
  const confident = drafts.filter((d) => byId.get(d.id)!.certainty === "confident" && byId.get(d.id)!.status !== "ignored");
  const skipped = drafts.filter((d) => byId.get(d.id)!.status === "ignored");
  const includedCount = drafts.filter((d) => d.include).length;
  const warnings = review.warnings.filter((w) => WARNING_TEXT[w]);

  const submit = () =>
    confirm.run(
      () =>
        confirmReceiptAction(review.id, {
          storeName: store.trim() || null,
          purchasedOn: date || null,
          items: drafts.map((d) => ({
            id: d.id,
            include: d.include,
            name: d.name,
            productId: d.productId,
            quantity: d.quantity,
            unit: d.unit,
            packCount: d.packCount,
            location: d.location,
            existingDecision: d.existingDecision,
            // Left out when nothing was chosen, so Plenty doesn't assume anything about who the food is for.
            ...(d.owner || defaultOwner.ownerMemberId ? { ownerMemberId: ownerOf(d).ownerMemberId, visibility: ownerOf(d).visibility } : {}),
          })),
        }),
      { onSuccess: () => router.push("/kitchen") },
    );

  const editingDraft = drafts.find((d) => d.id === editing) ?? null;

  return (
    <div className="pb-28">
      {warnings.length > 0 && (
        <div className="mb-5 space-y-2">
          {warnings.map((w) => (
            <div
              key={w}
              className={cn(
                "flex gap-3 rounded-2xl px-4 py-3 text-[14px]",
                w === "duplicate" ? "bg-alert-soft text-alert" : "bg-soon-soft text-soon",
              )}
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{WARNING_TEXT[w]}</span>
            </div>
          ))}
        </div>
      )}

      <Card className="mb-6 grid gap-4 p-4 sm:grid-cols-3">
        <Field label="Store" htmlFor="store">
          <Input id="store" value={store} onChange={(e) => setStore(e.target.value)} placeholder="Where did you shop?" maxLength={80} />
        </Field>
        <Field label="Date" htmlFor="date">
          <Input id="date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="flex flex-col justify-end">
          <p className="text-[13px] font-semibold text-ink-2">Total</p>
          <p className="mt-1.5 text-[20px] font-semibold tabular tracking-[-0.02em]">{review.total !== null ? formatMoney(review.total, review.currency ?? currency) : "—"}</p>
        </div>
      </Card>

      {people.members.length > 1 && (
        <div className="mb-6">
          <button
            type="button"
            onClick={() => setShowOwner((v) => !v)}
            aria-expanded={showOwner}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-3 transition hover:text-ink"
          >
            Whose shopping is this: <span className="text-ink-2">{defaultOwner.ownerMemberId ? (people.members.find((m) => m.id === defaultOwner.ownerMemberId)?.name ?? "someone") : "Everyone's"}</span>
            {defaultOwner.visibility === "private" && <span>· private</span>}
            <span className="underline underline-offset-2">{showOwner ? "done" : "change"}</span>
          </button>
          {showOwner && (
            <div className="mt-2.5 max-w-sm">
              <OwnerPicker
                id="receipt-owner"
                members={people.members}
                value={defaultOwner}
                onChange={setDefaultOwner}
                canPrivate={people.canPrivate}
                label="Everything on this receipt is for"
                hint="You can change any single item from its edit sheet."
              />
            </div>
          )}
        </div>
      )}

      {checkFirst.length > 0 && (
        <section className="mb-6" aria-labelledby="check-heading">
          <h2 id="check-heading" className="mb-1 text-[15px] font-semibold">
            Give these a quick look
          </h2>
          <p className="mb-3 text-[13px] text-ink-3">Plenty wasn&apos;t completely sure what these are. Tap one to fix it.</p>
          <Card className="divide-y divide-line">
            {checkFirst.map((d) => (
              <ItemRow key={d.id} draft={d} item={byId.get(d.id)!} onToggle={(v) => update(d.id, { include: v })} onEdit={() => setEditing(d.id)} onPick={(p) => update(d.id, p)} onDecision={(v) => update(d.id, { existingDecision: v })} />
            ))}
          </Card>
        </section>
      )}

      {confident.length > 0 && (
        <section className="mb-6" aria-labelledby="ok-heading">
          <h2 id="ok-heading" className="mb-3 text-[15px] font-semibold">
            {checkFirst.length > 0 ? "These look right" : "Everything looks right"}
          </h2>
          <Card className="divide-y divide-line">
            {confident.map((d) => (
              <ItemRow key={d.id} draft={d} item={byId.get(d.id)!} onToggle={(v) => update(d.id, { include: v })} onEdit={() => setEditing(d.id)} onPick={(p) => update(d.id, p)} onDecision={(v) => update(d.id, { existingDecision: v })} />
            ))}
          </Card>
        </section>
      )}

      {skipped.length > 0 && (
        <section className="mb-6" aria-labelledby="skip-heading">
          <h2 id="skip-heading" className="mb-1 text-[15px] font-semibold text-ink-2">
            Not added
          </h2>
          <p className="mb-3 text-[13px] text-ink-3">Bags, deposits and other non-grocery lines. Tick one if it should go in your kitchen.</p>
          <Card className="divide-y divide-line">
            {skipped.map((d) => (
              <ItemRow key={d.id} draft={d} item={byId.get(d.id)!} onToggle={(v) => update(d.id, { include: v })} onEdit={() => setEditing(d.id)} onPick={(p) => update(d.id, p)} onDecision={(v) => update(d.id, { existingDecision: v })} />
            ))}
          </Card>
        </section>
      )}

      <div className="pb-safe fixed inset-x-0 bottom-16 z-30 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur-md lg:bottom-0 lg:left-[252px]">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <Button variant="ghost" onClick={() => setConfirmDiscard(true)} disabled={confirm.pending} aria-label="Discard receipt">
            <Trash2 /> <span className="hidden sm:inline">Discard</span>
          </Button>
          <div className="flex-1" />
          <Button size="lg" onClick={submit} loading={confirm.pending} disabled={includedCount === 0}>
            <Check /> Add {includedCount} {includedCount === 1 ? "thing" : "things"} to kitchen
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this receipt?"
        description="Nothing from it will be added to your kitchen. You can always scan it again."
        confirmLabel="Discard"
        destructive
        loading={discard.pending}
        onConfirm={() => discard.run(() => discardReceiptAction(review.id), { onSuccess: () => router.push("/receipts") })}
      />

      <ItemEditSheet
        defaultOwner={defaultOwner}
        draft={editingDraft}
        item={editingDraft ? byId.get(editingDraft.id)! : null}
        onClose={() => setEditing(null)}
        onSave={(patch) => {
          if (editingDraft) update(editingDraft.id, patch);
          setEditing(null);
        }}
      />
    </div>
  );
}

function ItemRow({
  draft,
  item,
  onToggle,
  onEdit,
  onPick,
  onDecision,
}: {
  draft: Draft;
  item: ReceiptReviewItem;
  onToggle: (include: boolean) => void;
  onEdit: () => void;
  onPick: (patch: Partial<Draft>) => void;
  onDecision: (d: "replace" | "keep" | "merge") => void;
}) {
  const people = usePeople();
  const ownerMember = draft.owner?.ownerMemberId ? people.members.find((m) => m.id === draft.owner!.ownerMemberId) : undefined;
  const ownerName = ownerMember?.name;
  const ownerColor = ownerMember?.color;
  const showCandidates = draft.include && item.certainty !== "confident" && draft.productId === item.productId && item.candidates.length > 0;
  return (
    <div className={cn("px-4 py-3", !draft.include && "opacity-60")}>
      <div className="flex items-center gap-3">
        <Checkbox checked={draft.include} onCheckedChange={(v) => onToggle(v === true)} aria-label={`Include ${draft.name}`} />
        <button type="button" onClick={onEdit} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold">
              {draft.name}
              {draft.owner && draft.owner.ownerMemberId && (
                <PersonChip
                  name={ownerName ?? "Someone"}
                  color={ownerColor}
                  isPrivate={draft.owner.visibility === "private"}
                  className="ml-2 align-middle"
                />
              )}
            </p>
            <p className="truncate text-[12px] text-ink-3">
              {amountLabel(draft)} · {STORAGE_LOCATION_LABELS[draft.location]}
              <span className="ml-1.5 font-mono text-[11px] text-ink-4">{item.rawText}</span>
            </p>
          </div>
          {item.totalPrice !== null && <span className="tabular text-[14px] text-ink-2">{item.totalPrice.toFixed(2)}</span>}
          <ChevronRight className="size-4 shrink-0 text-ink-4" />
        </button>
      </div>
      {showCandidates && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-9">
          <span className="text-[12px] text-ink-3">{item.productId ? "Or did you mean" : "Is it"}</span>
          {item.candidates.map((c) => (
            <button
              key={c.productId}
              type="button"
              onClick={() => onPick({ productId: c.productId, productName: c.name, name: c.name })}
              className="h-7 rounded-full border border-line-strong px-2.5 text-[12px] font-medium text-ink-2 hover:bg-subtle hover:text-ink"
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      {draft.include && item.existing && (
        <div className="mt-2.5 flex flex-col gap-2 rounded-xl bg-subtle px-3 py-2.5 sm:ml-9 sm:flex-row sm:items-center sm:gap-3">
          <span className="flex min-w-0 flex-1 items-start gap-2 text-[13px] leading-snug text-ink-2">
            <Info className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
            {item.existing.summary}
          </span>
          {item.existing.suggestion === "merge" ? (
            <Segmented
              size="sm"
              ariaLabel="Already in kitchen"
              value={draft.existingDecision === "merge" ? "merge" : "keep"}
              onChange={(v) => onDecision(v)}
              options={[
                { value: "merge", label: "Same one" },
                { value: "keep", label: "Bought more" },
              ]}
            />
          ) : (
            <Segmented
              size="sm"
              ariaLabel="Previous one"
              value={draft.existingDecision === "replace" ? "replace" : "keep"}
              onChange={(v) => onDecision(v)}
              options={[
                { value: "replace", label: "Finished it" },
                { value: "keep", label: "Still have some" },
              ]}
            />
          )}
        </div>
      )}
    </div>
  );
}

const COMMON_UNITS: Unit[] = ["each", "g", "kg", "ml", "l", "pack", "bunch", "can", "bottle", "jar", "loaf"];

function ItemEditSheet({
  defaultOwner,
  draft,
  item,
  onClose,
  onSave,
}: {
  defaultOwner: OwnerValue;
  draft: Draft | null;
  item: ReceiptReviewItem | null;
  onClose: () => void;
  onSave: (patch: Partial<Draft>) => void;
}) {
  return (
    <Sheet open={draft !== null} onOpenChange={(o) => !o && onClose()} title="Fix this item" description={item ? `Printed as “${item.rawText}”` : undefined}>
      {draft && item && <EditForm key={draft.id} draft={draft} item={item} defaultOwner={defaultOwner} onSave={onSave} onCancel={onClose} />}
    </Sheet>
  );
}

function EditForm({
  draft,
  item,
  defaultOwner,
  onSave,
  onCancel,
}: {
  draft: Draft;
  item: ReceiptReviewItem;
  defaultOwner: OwnerValue;
  onSave: (p: Partial<Draft>) => void;
  onCancel: () => void;
}) {
  const people = usePeople();
  const [owner, setOwner] = useState<OwnerValue>(draft.owner ?? defaultOwner);
  const [name, setName] = useState(draft.name);
  const [productId, setProductId] = useState(draft.productId);
  const [productName, setProductName] = useState(draft.productName);
  // "Amount" is per pack, so changing Packs scales the total (two 2 L milks are 4 L).
  const [quantity, setQuantity] = useState(perPackText(draft));
  const [unit, setUnit] = useState<Unit>(draft.unit);
  const [packs, setPacks] = useState(String(draft.packCount));
  const [location, setLocation] = useState<StorageLocation>(draft.location);
  const qty = parseAmount(quantity);
  const packCount = Math.max(1, Math.round(Number(packs) || 1));
  // Left as they were, keep the exact total (the per-pack figure is rounded for display).
  const total = quantity === perPackText(draft) && packCount === draft.packCount ? draft.quantity : Math.round(qty * packCount * 1000) / 1000;
  const valid = name.trim().length > 0 && qty > 0;
  const candidates = [
    ...(item.productId && item.productName ? [{ productId: item.productId, name: item.productName }] : []),
    ...item.candidates,
  ].filter((c, i, arr) => arr.findIndex((x) => x.productId === c.productId) === i);

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        // Only a line that differs from the receipt's default carries its own owner.
        const differs = owner.ownerMemberId !== defaultOwner.ownerMemberId || owner.visibility !== defaultOwner.visibility;
        onSave({ name: name.trim(), productId, productName, quantity: total, unit, packCount, location, include: true, owner: differs ? owner : undefined });
      }}
    >
      {candidates.length > 0 && (
        <div>
          <p className="mb-2 text-[13px] font-semibold text-ink-2">What is it?</p>
          <div className="flex flex-wrap gap-2">
            {candidates.map((c) => (
              <button
                key={c.productId}
                type="button"
                onClick={() => {
                  setProductId(c.productId);
                  setProductName(c.name);
                  setName(c.name);
                }}
                className={cn(
                  "h-9 rounded-full border px-3.5 text-[13px] font-medium transition",
                  productId === c.productId ? "border-primary bg-primary text-on-primary" : "border-line-strong text-ink-2 hover:bg-subtle",
                )}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <Field label="Name" htmlFor="rname" hint={productId ? undefined : "Plenty will match this to a product, or remember it as something new."}>
        <Input
          id="rname"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (productName && e.target.value.trim().toLowerCase() !== productName.toLowerCase()) {
              setProductId(null);
              setProductName(null);
            }
          }}
          maxLength={120}
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field
          label={packCount > 1 ? "Each pack" : "Amount"}
          htmlFor="rqty"
          error={qty > 0 ? null : "More than 0"}
          hint={packCount > 1 ? `${formatQuantity(total, unit)} in total` : undefined}
        >
          <Input id="rqty" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^\d.,]/g, ""))} />
        </Field>
        <Field label="Unit" htmlFor="runit">
          <NativeSelect id="runit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
            {(COMMON_UNITS.includes(unit) ? COMMON_UNITS : [unit, ...COMMON_UNITS]).filter((u) => (UNITS as readonly string[]).includes(u)).map((u) => (
              <option key={u} value={u}>
                {u === "each" ? "items" : u === "l" ? "L" : u}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Packs" htmlFor="rpacks">
          <Input id="rpacks" inputMode="numeric" value={packs} onChange={(e) => setPacks(e.target.value.replace(/[^\d]/g, ""))} />
        </Field>
      </div>
      <Field label="Kept in" htmlFor="rloc">
        <NativeSelect id="rloc" value={location} onChange={(e) => setLocation(e.target.value as StorageLocation)}>
          {STORAGE_LOCATIONS.map((l) => (
            <option key={l} value={l}>
              {STORAGE_LOCATION_LABELS[l]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {people.members.length > 1 && (
        <OwnerPicker id="ritem-owner" members={people.members} value={owner} onChange={setOwner} canPrivate={people.canPrivate} label="Whose is it?" />
      )}
      <div className="flex gap-2 pt-1">
        <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" className="flex-1" disabled={!valid}>
          Done
        </Button>
      </div>
    </form>
  );
}
