"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import { Dialog, VisuallyHidden } from "radix-ui";
import { CookingPot, Refrigerator, Search, ShoppingBasket } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { SearchResults } from "./types";

export interface CommandSearchController {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  setOpen: (open: boolean) => void;
}

/** Open/close state for the global search, with the ⌘K / Ctrl+K shortcut. */
export function useCommandSearch(): CommandSearchController {
  const [isOpen, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { isOpen, setOpen, open: useCallback(() => setOpen(true), []), close: useCallback(() => setOpen(false), []) };
}

const EMPTY: SearchResults = { inventory: [], shopping: [], meals: [] };

export function CommandSearch({ controller }: { controller: CommandSearchController }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const onOpenChange = (open: boolean) => {
    if (!open) {
      setQuery("");
      setResults(EMPTY);
      setError(null);
      setLoading(false);
    }
    controller.setOpen(open);
  };

  const onQueryChange = (value: string) => {
    setQuery(value);
    if (!value.trim()) {
      requestId.current += 1;
      setResults(EMPTY);
      setLoading(false);
    } else {
      setLoading(true);
    }
  };

  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) return;
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as SearchResults;
        if (id === requestId.current) {
          setResults(data);
          setError(null);
        }
      } catch {
        if (id === requestId.current) setError("Search isn't available right now. Check your connection and try again.");
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 140);
    return () => clearTimeout(timer);
  }, [query]);

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  const total = results.inventory.length + results.shopping.length + results.meals.length;

  return (
    <Dialog.Root open={controller.isOpen} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(17_18_20/0.32)] backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <Dialog.Content className="fixed inset-x-3 top-3 z-50 mx-auto max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-pop outline-none data-[state=open]:animate-rise sm:top-[12vh]">
          <VisuallyHidden.Root>
            <Dialog.Title>Search</Dialog.Title>
            <Dialog.Description>Search your kitchen, shopping list and meals</Dialog.Description>
          </VisuallyHidden.Root>
          <Command shouldFilter={false} label="Search Plenty" loop>
            <div className="flex items-center gap-3 border-b border-line px-4">
              {loading ? <Spinner className="size-[18px] text-ink-3" /> : <Search className="size-[18px] text-ink-3" />}
              <Command.Input
                value={query}
                onValueChange={onQueryChange}
                placeholder="Search kitchen, list, meals…"
                className="h-14 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-4"
                autoFocus
              />
              <kbd className="hidden rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-4 sm:inline">Esc</kbd>
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto p-2">
              {error && <div className="px-3 py-6 text-center text-sm text-alert">{error}</div>}
              {!error && query.trim() && !loading && total === 0 && (
                <Command.Empty className="px-3 py-8 text-center text-sm text-ink-3">
                  Nothing matches &ldquo;{query.trim()}&rdquo; yet.
                </Command.Empty>
              )}
              {!query.trim() && (
                <div className="px-3 py-6 text-center text-sm text-ink-3">
                  Try &ldquo;milk&rdquo;, &ldquo;curry&rdquo; or &ldquo;spinach&rdquo;.
                </div>
              )}
              <ResultGroup heading="In your kitchen" icon={<Refrigerator />} items={results.inventory} onSelect={go} />
              <ResultGroup heading="On your list" icon={<ShoppingBasket />} items={results.shopping} onSelect={go} />
              <ResultGroup heading="Meals" icon={<CookingPot />} items={results.meals} onSelect={go} />
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ResultGroup({
  heading,
  icon,
  items,
  onSelect,
}: {
  heading: string;
  icon: React.ReactNode;
  items: SearchResults["inventory"];
  onSelect: (href: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.07em] [&_[cmdk-group-heading]]:text-ink-3"
    >
      {items.map((item) => (
        <Command.Item
          key={`${heading}:${item.id}`}
          value={`${heading}:${item.id}`}
          onSelect={() => onSelect(item.href)}
          className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] data-[selected=true]:bg-subtle"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-subtle text-ink-3 [&_svg]:size-4">{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-ink">{item.title}</span>
            {item.detail && <span className="block truncate text-[13px] text-ink-3">{item.detail}</span>}
          </span>
        </Command.Item>
      ))}
    </Command.Group>
  );
}
