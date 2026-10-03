/** When the public Privacy Policy, Terms and Support pages were last changed. Update it with the text, and only then. */
export const LEGAL_LAST_UPDATED = "2026-10-03";

/** "3 October 2026" */
export function formatLegalDate(iso: string = LEGAL_LAST_UPDATED): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
