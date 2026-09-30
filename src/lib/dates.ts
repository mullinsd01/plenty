/**
 * Calendar-date helpers. Calendar dates are "YYYY-MM-DD" strings interpreted
 * in the household's timezone; instants are JS Dates. No external deps.
 */

export const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" for the given instant in `timeZone`. */
export function toDateString(instant: Date, timeZone = "UTC"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Parse "YYYY-MM-DD" to a Date at UTC midnight (for pure date arithmetic). */
export function parseDateString(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

export function isDateString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseDateString(value).getTime());
}

export function addDays(date: string, days: number): string {
  const d = parseDateString(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (b - a) for calendar dates. */
export function daysBetweenDates(a: string, b: string): number {
  return Math.round((parseDateString(b).getTime() - parseDateString(a).getTime()) / DAY_MS);
}

/** Fractional days between two instants (b - a). */
export function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / DAY_MS;
}

export function addDaysToInstant(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday, for a calendar date. */
export function weekdayOf(date: string): number {
  return parseDateString(date).getUTCDay();
}

/** Hour (0–23) of an instant in `timeZone`. */
export function hourInTimeZone(instant: Date, timeZone = "UTC"): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(instant);
  return Number(h) % 24;
}

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Today", "Tomorrow", "Wednesday", or "Wed 12 Mar" relative to `today`. */
export function relativeDayLabel(date: string, today: string): string {
  const diff = daysBetweenDates(today, date);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return WEEKDAY_NAMES[weekdayOf(date)];
  return formatShortDate(date);
}

/** "Wed 12 Mar" */
export function formatShortDate(date: string): string {
  const d = parseDateString(date);
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${month}`;
}

/** "12 March 2025" */
export function formatLongDate(date: string): string {
  const d = parseDateString(date);
  return d.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
