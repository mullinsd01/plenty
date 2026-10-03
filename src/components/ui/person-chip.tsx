import { Lock } from "lucide-react";
import { cn } from "@/lib/cn";

/** Initial(s) for a name: "Mum" → "M", "Alex Kim" → "AK". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 1) : parts[0].slice(0, 1) + parts[parts.length - 1].slice(0, 1)).toUpperCase();
}

/**
 * Whose something is: a small coloured dot and name. A lock marks what only
 * its owner can see. The colour never carries the meaning alone — the name is
 * always there.
 */
export function PersonChip({
  name,
  color,
  isPrivate,
  className,
}: {
  name: string;
  color?: string | null;
  isPrivate?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full bg-subtle py-0.5 pl-1.5 pr-2 text-[12px] font-medium leading-5 text-ink-2",
        className,
      )}
      title={isPrivate ? `${name} — private, only they can see this` : name}
    >
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color ?? "var(--ink-4)" }} />
      <span className="truncate">{name}</span>
      {isPrivate && (
        <>
          <Lock aria-hidden className="size-3 shrink-0 text-ink-3" />
          <span className="sr-only">(private)</span>
        </>
      )}
    </span>
  );
}
