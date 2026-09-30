import * as React from "react";
import { cn } from "@/lib/cn";

const controlBase =
  "w-full rounded-[11px] border border-line-strong bg-surface text-ink text-[15px] shadow-[inset_0_1px_1px_rgb(0_0_0/0.02)] transition-[border-color,box-shadow] outline-none placeholder:text-ink-4 focus:border-ink-3 focus:ring-4 focus:ring-[color-mix(in_srgb,var(--brand)_14%,transparent)] disabled:opacity-60 aria-[invalid=true]:border-alert aria-[invalid=true]:focus:ring-[color-mix(in_srgb,var(--alert)_14%,transparent)]";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(controlBase, "h-11 px-3.5", className)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(controlBase, "min-h-24 px-3.5 py-2.5 leading-relaxed", className)} {...props} />;
  },
);

export const NativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function NativeSelect({ className, children, ...props }, ref) {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(controlBase, "h-11 appearance-none pl-3.5 pr-10", className)}
          {...props}
        >
          {children}
        </select>
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="m6 8 4 4 4-4" />
        </svg>
      </div>
    );
  },
);

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-[13px] font-semibold text-ink-2", className)} {...props} />;
}

interface FieldProps {
  label?: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: string | null;
  className?: string;
  children: React.ReactNode;
  optional?: boolean;
}

/** Label + control + hint/error, with consistent spacing. */
export function Field({ label, htmlFor, hint, error, className, children, optional }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <Label htmlFor={htmlFor} className="flex items-baseline justify-between">
          <span>{label}</span>
          {optional && <span className="text-xs font-normal text-ink-3">Optional</span>}
        </Label>
      )}
      {children}
      {error ? (
        <p role="alert" className="text-[13px] text-alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}
