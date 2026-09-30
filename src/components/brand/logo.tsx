import { cn } from "@/lib/cn";

/**
 * Plenty brand marks, as crisp inline SVG. Replace the paths here to update
 * the brand everywhere.
 */

const MARK_PATHS = (
  <>
    <path d="M0 100C0 45 45 0 105 0h45q8 0 8 8v124q0 22-22 22H62c-26 0-42 12-50 28q-6 12-12 4Z" />
    <circle cx="248" cy="76" r="75" />
    <path d="M0 258c0-45 34-80 78-80h32q42 0 42 42v146c0 14-12 22-27 28-30 11-45 36-63 58-12 14-22 20-32 20-18 0-30-12-30-32Z" />
    <path d="M174 190q0-14 14-14h74c23 0 43-4 53-10q8-4 8 6v68c0 65-45 110-113 120l-24 4q-12 2-12-10Z" />
  </>
);

const WORD_PATHS = (
  <>
    <path d="M9 9v130" />
    <circle cx="55" cy="50" r="41" />
    <path d="M131-35V91" />
    <path d="M164 50h82a41 41 0 1 0-14 31" />
    <path d="M283 9v82m0-46a35.5 35.5 0 0 1 71 0v46" />
    <path d="M395-33v91a33 33 0 0 0 33 33" />
    <path d="M377 9h51" />
    <path d="M454 9v46a34 34 0 0 0 68 0" />
    <path d="M522 9v96a34 34 0 0 1-34 34c-13 0-22-5-29-12" />
  </>
);

interface LogoProps {
  className?: string;
  title?: string;
}

/** The four-part "p" mark. Uses the brand coral unless `mono` is set (then currentColor). */
export function PlentyMark({ className, title = "Plenty", mono = false }: LogoProps & { mono?: boolean }) {
  return (
    <svg viewBox="0 0 324 472" role="img" aria-label={title} className={cn("h-8 w-auto", className)}>
      <g fill={mono ? "currentColor" : "var(--brand)"}>{MARK_PATHS}</g>
    </svg>
  );
}

/** The "plenty" wordmark in currentColor. */
export function PlentyWordmark({ className, title = "Plenty" }: LogoProps) {
  return (
    <svg viewBox="-1 -45 533 194" role="img" aria-label={title} className={cn("h-6 w-auto", className)}>
      <g fill="none" stroke="currentColor" strokeWidth="18" strokeLinecap="round" strokeLinejoin="round">
        {WORD_PATHS}
      </g>
    </svg>
  );
}

/** Mark + wordmark lockup. Size it with a height class; width follows. */
export function PlentyLogo({ className, title = "Plenty", mono = false }: LogoProps & { mono?: boolean }) {
  return (
    <svg viewBox="0 0 720 206" role="img" aria-label={title} className={cn("h-7 w-auto", className)}>
      <g transform="scale(0.4364)" fill={mono ? "currentColor" : "var(--brand)"}>
        {MARK_PATHS}
      </g>
      <g
        transform="translate(187.4 54)"
        fill="none"
        stroke={mono ? "currentColor" : "var(--navy)"}
        strokeWidth="18"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {WORD_PATHS}
      </g>
    </svg>
  );
}
