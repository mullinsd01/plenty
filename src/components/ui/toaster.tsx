"use client";

import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      position="top-center"
      offset={16}
      mobileOffset={{ top: 12 }}
      toastOptions={{
        classNames: {
          toast:
            "!rounded-2xl !border !border-line !bg-surface !text-ink !shadow-pop !font-sans !text-[14px] !gap-2.5 !py-3 !px-4",
          description: "!text-ink-3",
          actionButton: "!bg-primary !text-on-primary !rounded-lg !font-semibold",
          cancelButton: "!bg-subtle !text-ink-2 !rounded-lg",
          success: "[&_[data-icon]]:!text-fresh",
          error: "[&_[data-icon]]:!text-alert",
        },
      }}
    />
  );
}
