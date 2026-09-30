"use client";

import { useMemo, useOptimistic, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Plus, RotateCcw, ScanLine, Search, X } from "lucide-react";
import { LevelMeter } from "@/components/food/level";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/controls";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/field";
import { useAction } from "@/components/hooks/use-action";
import { cn } from "@/lib/cn";
import { levelLabel, STORAGE_LOCATIONS, STORAGE_LOCATION_LABELS, type StorageLocation } from "@/lib/domain";
import { timeAgo } from "@/lib/format";
import type { FinishedItemView, InventoryItemView } from "@/server/services/inventory";
import { restoreItemAction } from "./actions";
import { AddItemsSheet } from "./add-items-sheet";
import { ItemSheet } from "./item-sheet";
import { LocationIcon } from "./location-icon";

type SortKey = "urgent" | "name" | "recent";

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Forgiving match: every query word must prefix some word of the name (plurals and typos-lite). */
function matches(name: string, query: string): boolean {
  const words = normalize(name).split(" ");
  return normalize(query)
    .split(" ")
    .filter(Boolean)
    .every((q) => words.some((w) => w.startsWith(q) || q.startsWith(w.replace(/s$/, "")) || w.replace(/s$/, "") === q.replace(/s$/, "")));
}

function urgency(item: InventoryItemView): number {
  const expiry = item.useSoon.daysUntilExpiry ?? 99;
  const runOut = item.prediction?.daysRemaining ?? 99;
  return Math.min(expiry + (item.useSoon.atRiskOfWaste ? -1 : 0), runOut);
}

export function KitchenView({ items, finished }: { items: InventoryItemView[]; finished: FinishedItemView[] }) {
  const params = useSearchParams();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState<StorageLocation | "all">("all");
  const [sort, setSort] = useState<SortKey>("urgent");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(params.get("add") === "1");
  const restore = useAction();

  const [optimistic, setOptimistic] = useOptimistic(items, (state, update: { id: string; fraction: number }) =>
    state.map((i) =>
      i.id === update.id
        ? {
            ...i,
            estimatedFraction: update.fraction,
            knownFraction: update.fraction,
            levelLabel: levelLabel(update.fraction),
            remainingCount: i.countable ? Math.round(i.quantity * update.fraction) : null,
          }
        : i,
    ),
  );

  const counts = useMemo(() => {
    const c = new Map<StorageLocation, number>();
    for (const i of optimistic) c.set(i.location, (c.get(i.location) ?? 0) + 1);
    return c;
  }, [optimistic]);

  const visible = useMemo(() => {
    const filtered = optimistic.filter((i) => (location === "all" || i.location === location) && (!query.trim() || matches(i.name, query)));
    return [...filtered].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "recent") return b.purchasedAt.localeCompare(a.purchasedAt);
      return urgency(a) - urgency(b) || a.name.localeCompare(b.name);
    });
  }, [optimistic, location, query, sort]);

  const groups = useMemo(() => {
    if (sort !== "name" || location !== "all") return [{ key: "all", label: null as string | null, items: visible }];
    return STORAGE_LOCATIONS.map((l) => ({ key: l, label: STORAGE_LOCATION_LABELS[l], items: visible.filter((i) => i.location === l) })).filter(
      (g) => g.items.length > 0,
    );
  }, [visible, sort, location]);

  const selected = optimistic.find((i) => i.id === selectedId) ?? null;

  const openAdd = (open: boolean) => {
    setAdding(open);
    if (!open && params.get("add")) router.replace("/kitchen");
  };

  if (items.length === 0) {
    return (
      <>
        <Card>
          <EmptyState
            icon={<ScanLine />}
            title="Your kitchen is empty"
            action={
              <>
                <Button asChild variant="brand">
                  <Link href="/receipts/new">
                    <ScanLine /> Scan a receipt
                  </Link>
                </Button>
                <Button variant="secondary" onClick={() => setAdding(true)}>
                  <Plus /> Add by hand
                </Button>
              </>
            }
          >
            Scan a receipt and Plenty will fill it in — or add a few things by hand to get started.
          </EmptyState>
        </Card>
        <AddItemsSheet open={adding} onOpenChange={openAdd} />
        <FinishedList finished={finished} onRestore={(id) => restore.run(() => restoreItemAction(id))} />
      </>
    );
  }

  return (
    <div>
      <div className="sticky top-14 z-20 -mx-4 space-y-3 bg-canvas/90 px-4 pb-3 pt-1 backdrop-blur-md sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:bg-transparent lg:px-0 lg:backdrop-blur-none">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-4" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your kitchen"
              aria-label="Search your kitchen"
              className="pl-10 pr-9"
              type="search"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-ink-4 hover:bg-subtle"
                aria-label="Clear search"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <Button onClick={() => setAdding(true)} className="shrink-0" aria-label="Add to kitchen">
            <Plus /> <span className="hidden sm:inline">Add</span>
          </Button>
        </div>
        <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="tablist" aria-label="Filter by where it's kept">
          <FilterChip active={location === "all"} onClick={() => setLocation("all")} label="All" count={optimistic.length} />
          {STORAGE_LOCATIONS.filter((l) => counts.get(l)).map((l) => (
            <FilterChip key={l} active={location === l} onClick={() => setLocation(l)} label={STORAGE_LOCATION_LABELS[l]} count={counts.get(l) ?? 0} />
          ))}
        </div>
      </div>

      <div className="mb-3 mt-2 flex items-center justify-between">
        <p className="text-[13px] text-ink-3">
          {visible.length} {visible.length === 1 ? "thing" : "things"}
        </p>
        <Segmented<SortKey>
          size="sm"
          ariaLabel="Sort"
          value={sort}
          onChange={setSort}
          options={[
            { value: "urgent", label: "Use first" },
            { value: "name", label: "A–Z" },
            { value: "recent", label: "Newest" },
          ]}
        />
      </div>

      {visible.length === 0 ? (
        <Card>
          <EmptyState compact icon={<Search />} title={`No “${query}” in your kitchen`} action={<Button variant="secondary" size="sm" onClick={() => setQuery("")}>Clear search</Button>}>
            Not seeing something you bought? Add it, or scan the receipt.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label ?? "Items"}>
              {g.label && <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">{g.label}</h2>}
              <Card className="divide-y divide-line overflow-hidden">
                {g.items.map((item) => (
                  <ItemRow key={item.id} item={item} onOpen={() => setSelectedId(item.id)} />
                ))}
              </Card>
            </section>
          ))}
        </div>
      )}

      <FinishedList finished={finished} onRestore={(id) => restore.run(() => restoreItemAction(id), { success: "Back in your kitchen" })} />

      <ItemSheet
        item={selected}
        open={selected !== null}
        onOpenChange={(open) => !open && setSelectedId(null)}
        onLevelChange={(id, fraction) => setOptimistic({ id, fraction })}
      />
      <AddItemsSheet open={adding} onOpenChange={openAdd} />
    </div>
  );
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition",
        active ? "border-primary bg-primary text-on-primary" : "border-line-strong bg-surface text-ink-2 hover:border-ink-4",
      )}
    >
      {label}
      <span className={cn("tabular text-[12px]", active ? "opacity-70" : "text-ink-4")}>{count}</span>
    </button>
  );
}

function ItemRow({ item, onOpen }: { item: InventoryItemView; onOpen: () => void }) {
  const soon = item.useSoon.status === "today" || item.useSoon.status === "soon";
  const expired = item.useSoon.status === "expired";
  const detail = expired
    ? item.useSoon.label
    : soon
      ? item.useSoon.label
      : item.prediction && item.prediction.daysRemaining < 10
        ? `Probably ${item.prediction.label} left`
        : `Bought ${timeAgo(item.purchasedAt)}`;
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-subtle/60 focus-visible:bg-subtle">
      <LocationIcon location={item.location} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold">
          {item.name}
          {item.needsCheckIn && <span className="ml-2 align-middle text-[11px] font-medium text-brand-ink">Finished?</span>}
        </p>
        <p className={cn("truncate text-[13px]", expired ? "text-alert" : soon ? "text-soon" : "text-ink-3")}>
          {item.quantityLabel}
          <span className="mx-1.5 text-ink-4">·</span>
          {detail}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span className="text-[12px] font-medium text-ink-3">
          {item.countable && item.remainingCount !== null ? `${item.remainingCount} left` : item.levelLabel}
        </span>
        <LevelMeter fraction={item.estimatedFraction} />
      </div>
    </button>
  );
}

function FinishedList({ finished, onRestore }: { finished: FinishedItemView[]; onRestore: (id: string) => void }) {
  if (finished.length === 0) return null;
  return (
    <details className="group mt-10">
      <summary className="flex cursor-pointer list-none items-center justify-between text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">
        Recently used up
        <span className="text-[12px] font-medium normal-case tracking-normal text-ink-4 group-open:hidden">Show</span>
      </summary>
      <Card className="mt-3 divide-y divide-line">
        {finished.map((f) => (
          <div key={f.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium">{f.name}</p>
              <p className="text-[12px] text-ink-3">
                {f.status === "finished" ? "Finished" : f.status === "wasted" ? "Thrown out" : "Went off"}
                {f.statusChangedAt && ` · ${timeAgo(f.statusChangedAt)}`}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => onRestore(f.id)}>
              <RotateCcw /> Undo
            </Button>
          </div>
        ))}
      </Card>
    </details>
  );
}
