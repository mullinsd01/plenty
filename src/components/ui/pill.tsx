import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

export const pillVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full font-medium leading-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-subtle text-ink-2",
        brand: "bg-brand-soft text-brand-ink",
        fresh: "bg-fresh-soft text-fresh",
        soon: "bg-soon-soft text-soon",
        alert: "bg-alert-soft text-alert",
        info: "bg-info-soft text-info",
        outline: "border border-line-strong text-ink-2",
      },
      size: {
        sm: "h-5 px-2 text-[11px]",
        md: "h-6 px-2.5 text-xs",
      },
    },
    defaultVariants: { tone: "neutral", size: "md" },
  },
);

export function Pill({
  className,
  tone,
  size,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof pillVariants>) {
  return <span className={cn(pillVariants({ tone, size }), className)} {...props} />;
}
