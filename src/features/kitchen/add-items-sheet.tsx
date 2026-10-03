"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ScanLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { HOUSEHOLD_OWNER, OwnerPicker, type OwnerValue } from "@/features/members/owner-picker";
import { usePeople } from "@/features/members/people-context";
import { Sheet } from "@/components/ui/sheet";
import { useAction } from "@/components/hooks/use-action";
import { parseQuickAdd } from "@/lib/quick-add";
import { formatQuantity } from "@/lib/units";
import { addItemsAction } from "./actions";

const EXAMPLES = ["2 milk", "bread", "500g mince", "a dozen eggs", "bananas"];

/**
 * Add things by typing naturally — "2 milk, bread, 500g mince". Plenty works
 * out the product, where it's kept, the usual pack size and when it'll expire.
 */
export function AddItemsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [text, setText] = useState("");
  const [owner, setOwner] = useState<OwnerValue>(HOUSEHOLD_OWNER);
  const [showOwner, setShowOwner] = useState(false);
  const { pending, run } = useAction();
  const items = useMemo(() => parseQuickAdd(text), [text]);
  const people = usePeople();
  const ownerName = owner.ownerMemberId ? (people.members.find((m) => m.id === owner.ownerMemberId)?.name ?? "someone") : "Everyone";

  const submit = () => {
    if (items.length === 0) return;
    run(
      () =>
        addItemsAction(
          items.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            unit: i.unit,
            packCount: i.packCount,
            ...(people.restricted ? {} : { ownerMemberId: owner.ownerMemberId, visibility: owner.visibility }),
          })),
        ),
      {
        onSuccess: () => {
          setText("");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add to your kitchen"
      description="Type what you've got, separated by commas. Plenty fills in the rest."
      footer={
        <Button block size="lg" onClick={submit} loading={pending} disabled={items.length === 0}>
          {items.length > 1 ? `Add ${items.length} things` : "Add"}
        </Button>
      }
    >
      <div className="space-y-4">
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="2 milk, bread, 500g mince…"
          aria-label="What did you get?"
          className="min-h-20 text-[16px]"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        {items.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Items to add">
            {items.map((item, i) => (
              <li key={`${item.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-full bg-subtle py-1.5 pl-3 pr-2 text-[13px]">
                <span className="font-medium">{item.name}</span>
                <span className="text-ink-3">
                  {item.quantity && item.unit ? formatQuantity(item.quantity, item.unit) : item.packCount > 1 ? `× ${item.packCount}` : ""}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${item.name}`}
                  className="flex size-5 items-center justify-center rounded-full text-ink-4 hover:bg-sunken hover:text-ink"
                  onClick={() => {
                    const parts = text.split(/[\n;]+|(?<!\d),|,(?!\d)/).map((p) => p.trim()).filter(Boolean);
                    parts.splice(i, 1);
                    setText(parts.join(", "));
                  }}
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setText((t) => (t.trim() ? `${t.trim().replace(/,$/, "")}, ${ex}` : ex))}
                className="h-8 rounded-full border border-dashed border-line-strong px-3 text-[13px] text-ink-3 hover:border-ink-4 hover:text-ink"
              >
                + {ex}
              </button>
            ))}
          </div>
        )}
        {people.restricted ? (
          <p className="text-[13px] text-ink-3">Things you add are marked as yours.</p>
        ) : (
          people.members.length > 1 && (
            <div>
              <button
                type="button"
                onClick={() => setShowOwner((v) => !v)}
                aria-expanded={showOwner}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-3 transition hover:text-ink"
              >
                Whose is it: <span className="text-ink-2">{ownerName}</span>
                {owner.visibility === "private" && <span>· private</span>}
                <span className="underline underline-offset-2">{showOwner ? "done" : "change"}</span>
              </button>
              {showOwner && (
                <div className="mt-2.5">
                  <OwnerPicker id="add-owner" members={people.members} value={owner} onChange={setOwner} canPrivate={people.canPrivate} label="Whose is it?" />
                </div>
              )}
            </div>
          )
        )}
        <div className="flex items-center gap-3 rounded-xl bg-subtle px-3.5 py-3 text-[13px] text-ink-2">
          <ScanLine className="size-4 shrink-0 text-brand" />
          <span className="flex-1">Just been shopping? Scanning the receipt is quicker.</span>
          <Link href="/receipts/new" className="font-semibold text-ink hover:underline" onClick={() => onOpenChange(false)}>
            Scan
          </Link>
        </div>
      </div>
    </Sheet>
  );
}
