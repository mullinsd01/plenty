import { addDays, relativeDayLabel } from "@/lib/dates";

/** The next 7 nights, labelled "Today", "Tomorrow", "Wednesday"… */
export function nextDays(today: string, count = 7): Array<{ date: string; label: string }> {
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(today, i);
    return { date, label: i === 0 ? "Tonight" : relativeDayLabel(date, today) };
  });
}
