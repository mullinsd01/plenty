import * as React from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/cn";

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  className?: string;
}) {
  return (
    <header className={cn("mb-6 pt-2 sm:mb-8", className)}>
      {back && (
        <Link
          href={back.href}
          className="-ml-1.5 mb-3 inline-flex items-center gap-0.5 rounded-lg px-1.5 py-1 text-[13px] font-medium text-ink-3 transition hover:bg-subtle hover:text-ink"
        >
          <ChevronLeft className="size-4" />
          {back.label}
        </Link>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-balance text-[28px] font-semibold leading-tight tracking-[-0.03em] sm:text-[32px]">{title}</h1>
          {subtitle && <p className="mt-1 text-pretty text-[15px] text-ink-3">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2 pt-1 sm:pt-1.5">{actions}</div>}
      </div>
    </header>
  );
}
