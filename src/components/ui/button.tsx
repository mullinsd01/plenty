import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";
import { Spinner } from "./spinner";

export const buttonVariants = cva(
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-semibold transition-[background-color,color,box-shadow,transform,opacity] duration-150 ease-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-on-primary hover:bg-primary-hover shadow-[0_1px_2px_rgb(0_0_0/0.12)]",
        brand: "bg-brand text-white hover:bg-brand-strong shadow-[0_1px_2px_rgb(0_0_0/0.12)]",
        secondary: "bg-surface text-ink border border-line-strong hover:bg-subtle shadow-card",
        subtle: "bg-subtle text-ink hover:bg-sunken",
        ghost: "text-ink-2 hover:bg-subtle hover:text-ink",
        danger: "bg-alert text-white hover:opacity-90",
        "danger-subtle": "bg-alert-soft text-alert hover:opacity-80",
        link: "text-ink underline-offset-4 hover:underline px-0 h-auto active:scale-100",
      },
      size: {
        sm: "h-8 rounded-md px-3 text-[13px] [&_svg]:size-4",
        md: "h-10 rounded-[11px] px-4 text-sm [&_svg]:size-[18px]",
        lg: "h-12 rounded-xl px-5 text-[15px] [&_svg]:size-5",
        icon: "size-10 rounded-full [&_svg]:size-5",
        "icon-sm": "size-8 rounded-full [&_svg]:size-4",
      },
      block: { true: "w-full" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, asChild = false, loading = false, disabled, children, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size, block }), className)}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && (
            <span className="absolute inset-0 flex items-center justify-center">
              <Spinner className="size-4" />
            </span>
          )}
          <span className={cn("inline-flex items-center gap-2", loading && "invisible")}>{children}</span>
        </>
      )}
    </Comp>
  );
});
