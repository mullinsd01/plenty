"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const TABS = [
  { href: "/meals", label: "Plan" },
  { href: "/meals/cook", label: "What can I make?" },
  { href: "/meals/recipes", label: "Recipes" },
];

export function MealsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Meals" className="scrollbar-none -mx-4 mb-6 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      {TABS.map((t) => {
        const active = t.href === "/meals" ? pathname === "/meals" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-9 shrink-0 items-center rounded-full px-4 text-[14px] font-medium transition",
              active ? "bg-primary text-on-primary" : "text-ink-2 hover:bg-subtle hover:text-ink",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
