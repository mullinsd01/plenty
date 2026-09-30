"use client";

import Link from "next/link";
import { startTransition } from "react";
import { ChevronRight, LogOut, ReceiptText, Settings, Sprout, Users } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { signOutAction } from "@/features/auth/actions";
import { cn } from "@/lib/cn";
import type { ShellHousehold, ShellUser } from "./app-shell";

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-navy text-[13px] font-semibold text-inverse",
        className,
      )}
    >
      {initial}
    </span>
  );
}

export function UserMenu({
  user,
  household,
  placement,
}: {
  user: ShellUser;
  household: ShellHousehold;
  placement: "sidebar" | "topbar";
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        {placement === "sidebar" ? (
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left transition hover:bg-subtle"
          >
            <Avatar name={user.displayName} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-ink">{household.name}</span>
              <span className="block truncate text-xs text-ink-3">{user.displayName}</span>
            </span>
            <ChevronRight className="size-4 text-ink-4" />
          </button>
        ) : (
          <button type="button" aria-label="Account menu" className="flex size-10 items-center justify-center rounded-full">
            <Avatar name={user.displayName} />
          </button>
        )}
      </MenuTrigger>
      <MenuContent align={placement === "sidebar" ? "start" : "end"} side={placement === "sidebar" ? "top" : "bottom"} className="w-60">
        <MenuLabel>
          <span className="block truncate text-[13px] font-semibold text-ink">{user.displayName}</span>
          <span className="block truncate">{user.email}</span>
        </MenuLabel>
        <MenuSeparator />
        <MenuItem asChild className="lg:hidden">
          <Link href="/insights">
            <Sprout /> What Plenty knows
          </Link>
        </MenuItem>
        <MenuItem asChild className="lg:hidden">
          <Link href="/receipts">
            <ReceiptText /> Receipts
          </Link>
        </MenuItem>
        <MenuItem asChild>
          <Link href="/settings/household">
            <Users /> Household & sharing
          </Link>
        </MenuItem>
        <MenuItem asChild>
          <Link href="/settings">
            <Settings /> Settings
          </Link>
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={() => {
            startTransition(() => signOutAction());
          }}
        >
          <LogOut /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
