"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, ScanLine, Search, Settings } from "lucide-react";
import { PlentyLogo, PlentyMark } from "@/components/brand/logo";
import { cn } from "@/lib/cn";
import { NAV_ITEMS, isActive } from "./nav-items";
import { UserMenu } from "./user-menu";
import { CommandSearch, useCommandSearch } from "@/features/search/command-search";

export interface ShellUser {
  displayName: string;
  email: string;
  isDemo: boolean;
}

export interface ShellHousehold {
  name: string;
}

export function AppShell({
  user,
  household,
  unreadCount,
  children,
}: {
  user: ShellUser;
  household: ShellHousehold;
  unreadCount: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const search = useCommandSearch();

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[252px_minmax(0,1fr)]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-canvas px-4 pb-4 pt-6 lg:flex">
        <Link href="/home" className="mb-7 px-2" aria-label="Plenty home">
          <PlentyLogo className="h-[26px]" />
        </Link>
        <Link
          href="/receipts/new"
          className="mb-5 flex h-11 items-center justify-center gap-2 rounded-xl bg-brand text-[14px] font-semibold text-white shadow-[0_1px_2px_rgb(0_0_0/0.12)] transition hover:bg-brand-strong active:scale-[0.98]"
        >
          <ScanLine className="size-[18px]" />
          Scan a receipt
        </Link>
        <nav aria-label="Main" className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-10 items-center gap-3 rounded-[10px] px-3 text-[14px] font-medium transition-colors",
                  active ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-subtle hover:text-ink",
                )}
              >
                <item.icon className={cn("size-[18px]", active ? "text-brand" : "text-ink-3")} strokeWidth={active ? 2.2 : 1.8} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto flex flex-col gap-0.5">
          <Link
            href="/settings"
            aria-current={isActive(pathname, "/settings") ? "page" : undefined}
            className={cn(
              "flex h-10 items-center gap-3 rounded-[10px] px-3 text-[14px] font-medium transition-colors",
              isActive(pathname, "/settings") ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-subtle hover:text-ink",
            )}
          >
            <Settings className="size-[18px] text-ink-3" strokeWidth={1.8} />
            Settings
          </Link>
          <div className="mt-3 border-t border-line pt-3">
            <UserMenu user={user} household={household} placement="sidebar" />
          </div>
        </div>
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        {/* Top bar */}
        <header className="pt-safe sticky top-0 z-30 border-b border-line/0 bg-canvas/85 backdrop-blur-md supports-[backdrop-filter]:bg-canvas/75">
          <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-2 px-4 sm:px-6 lg:h-16 lg:px-8">
            <Link href="/home" className="lg:hidden" aria-label="Plenty home">
              <PlentyMark className="h-7" />
            </Link>
            <button
              type="button"
              onClick={search.open}
              className="ml-auto flex h-10 items-center gap-2 rounded-full px-3 text-[14px] text-ink-3 transition hover:bg-subtle hover:text-ink lg:ml-0 lg:w-72 lg:border lg:border-line lg:bg-surface lg:shadow-card"
              aria-label="Search"
            >
              <Search className="size-[18px]" />
              <span className="hidden lg:inline">Search kitchen, list, meals</span>
              <kbd className="ml-auto hidden rounded-md border border-line px-1.5 py-0.5 text-[11px] font-medium text-ink-4 lg:inline">
                ⌘K
              </kbd>
            </button>
            <Link
              href="/notifications"
              className="relative flex size-10 items-center justify-center rounded-full text-ink-2 transition hover:bg-subtle hover:text-ink lg:ml-auto"
              aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
            >
              <Bell className="size-[19px]" />
              {unreadCount > 0 && (
                <span className="absolute right-2 top-2 flex size-2.5 rounded-full border-2 border-canvas bg-brand" />
              )}
            </Link>
            <div className="lg:hidden">
              <UserMenu user={user} household={household} placement="topbar" />
            </div>
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 pb-32 pt-2 sm:px-6 lg:px-8 lg:pb-16 lg:pt-4">
          {children}
        </main>
      </div>

      {/* Mobile tab bar */}
      <nav
        aria-label="Main"
        className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/92 backdrop-blur-md lg:hidden"
      >
        <div className="mx-auto grid h-16 max-w-md grid-cols-5 items-center px-2">
          {NAV_ITEMS.filter((i) => i.tab)
            .slice(0, 2)
            .map((item) => (
              <TabLink key={item.href} href={item.href} label={item.label} icon={item.icon} active={isActive(pathname, item.href)} />
            ))}
          <div className="flex justify-center">
            <Link
              href="/receipts/new"
              aria-label="Scan a receipt"
              className="-mt-5 flex size-14 items-center justify-center rounded-full bg-brand text-white shadow-[0_6px_16px_-4px_color-mix(in_srgb,var(--brand)_60%,transparent)] ring-4 ring-canvas transition active:scale-95"
            >
              <ScanLine className="size-6" />
            </Link>
          </div>
          {NAV_ITEMS.filter((i) => i.tab)
            .slice(2, 4)
            .map((item) => (
              <TabLink
                key={item.href}
                href={item.href}
                label={item.href === "/list" ? "List" : item.label}
                icon={item.icon}
                active={isActive(pathname, item.href)}
              />
            ))}
        </div>
      </nav>

      <CommandSearch controller={search} />
    </div>
  );
}

function TabLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex flex-col items-center justify-center gap-1 py-1 text-[11px] font-medium transition-colors",
        active ? "text-ink" : "text-ink-3",
      )}
    >
      <Icon className={cn("size-[22px]", active && "text-brand")} strokeWidth={active ? 2.2 : 1.8} />
      {label}
    </Link>
  );
}
