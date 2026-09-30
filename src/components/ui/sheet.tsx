"use client";

import * as React from "react";
import { Dialog as RDialog, VisuallyHidden } from "radix-ui";
import { Drawer } from "vaul";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useMediaQuery } from "@/components/hooks/use-media-query";

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Hide the visible title (still announced to screen readers). */
  hideTitle?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  /** Desktop dialog width. */
  size?: "sm" | "md" | "lg";
}

const sizes = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-xl" };

/**
 * A bottom sheet on phones and a centred dialog on larger screens — the same
 * content and API either way.
 */
export function Sheet({ open, onOpenChange, title, description, hideTitle, children, footer, className, size = "md" }: SheetProps) {
  const desktop = useMediaQuery("(min-width: 768px)");

  if (desktop) {
    return (
      <RDialog.Root open={open} onOpenChange={onOpenChange}>
        <RDialog.Portal>
          <RDialog.Overlay className="fixed inset-0 z-50 bg-[rgb(17_18_20/0.32)] backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
          <RDialog.Content
            className={cn(
              "fixed left-1/2 top-1/2 z-50 flex max-h-[min(88vh,760px)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-surface shadow-pop outline-none data-[state=open]:animate-rise",
              sizes[size],
              className,
            )}
          >
            <SheetHead title={title} description={description} hideTitle={hideTitle} kind="dialog" />
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
            {footer && <div className="flex gap-2 border-t border-line px-6 py-4">{footer}</div>}
            <RDialog.Close
              className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-full text-ink-3 transition hover:bg-subtle hover:text-ink"
              aria-label="Close"
            >
              <X className="size-4" />
            </RDialog.Close>
          </RDialog.Content>
        </RDialog.Portal>
      </RDialog.Root>
    );
  }

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-[rgb(17_18_20/0.36)]" />
        <Drawer.Content
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-[22px] border-t border-line bg-surface outline-none",
            className,
          )}
        >
          <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line-strong" aria-hidden />
          <SheetHead title={title} description={description} hideTitle={hideTitle} kind="drawer" />
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
          {footer && <div className="pb-safe flex gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function SheetHead({
  title,
  description,
  hideTitle,
  kind,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  hideTitle?: boolean;
  kind: "dialog" | "drawer";
}) {
  const Title = kind === "dialog" ? RDialog.Title : Drawer.Title;
  const Description = kind === "dialog" ? RDialog.Description : Drawer.Description;
  const titleEl = <Title className="pr-8 text-lg font-semibold tracking-[-0.015em] text-ink">{title}</Title>;
  const descEl = description ? (
    <Description className="mt-1 text-sm text-ink-3">{description}</Description>
  ) : (
    <VisuallyHidden.Root>
      <Description>{typeof title === "string" ? title : "Dialog"}</Description>
    </VisuallyHidden.Root>
  );
  if (hideTitle) {
    return (
      <VisuallyHidden.Root>
        {titleEl}
        {descEl}
      </VisuallyHidden.Root>
    );
  }
  return (
    <div className={cn(kind === "dialog" ? "px-6 pb-4 pt-6" : "px-5 pb-3 pt-4")}>
      {titleEl}
      {descEl}
    </div>
  );
}
