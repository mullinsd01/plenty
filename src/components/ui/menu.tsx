"use client";

import * as React from "react";
import { DropdownMenu } from "radix-ui";
import { cn } from "@/lib/cn";

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({ className, align = "end", ...props }: React.ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={6}
        className={cn(
          "z-50 min-w-48 overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-pop data-[state=open]:animate-fade-in",
          className,
        )}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

export function MenuItem({
  className,
  destructive,
  ...props
}: React.ComponentProps<typeof DropdownMenu.Item> & { destructive?: boolean }) {
  return (
    <DropdownMenu.Item
      className={cn(
        "flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-subtle data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-ink-3",
        destructive && "text-alert [&_svg]:text-alert",
        className,
      )}
      {...props}
    />
  );
}

export function MenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownMenu.Label>) {
  return <DropdownMenu.Label className={cn("px-2.5 pb-1 pt-2 text-xs font-medium text-ink-3", className)} {...props} />;
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}
