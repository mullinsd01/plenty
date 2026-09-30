import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Calm, helpful empty state: a soft icon, one clear sentence and the next step.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
  compact = false,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center text-center", compact ? "px-4 py-8" : "px-6 py-14", className)}>
      {icon && (
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-subtle text-ink-3 [&_svg]:size-6">
          {icon}
        </div>
      )}
      <h3 className="text-balance text-[15px] font-semibold text-ink">{title}</h3>
      {children && <div className="mt-1.5 max-w-sm text-pretty text-sm leading-relaxed text-ink-3">{children}</div>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
