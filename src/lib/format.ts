/** Display formatting helpers shared by server and client. */

export function formatMoney(amount: number | null | undefined, currency = "AUD"): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "";
  try {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: amount >= 100 ? 0 : 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** "just now", "5 min ago", "3 hours ago", "yesterday", "12 Mar". */
export function timeAgo(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const diff = (now.getTime() - then.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} hours ago`;
  if (diff < 172800) return "yesterday";
  if (diff < 604800) return `${Math.round(diff / 86400)} days ago`;
  return then.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * Turn a run-out label ("about 4 days", "probably out now") into a phrase
 * that reads naturally on its own: "Probably about 4 days left",
 * "Probably out now", "Probably runs out today".
 */
export function remainingPhrase(label: string): string {
  if (label === "probably today") return "Probably runs out today";
  if (label.startsWith("probably")) return `P${label.slice(1)}`;
  return `Probably ${label} left`;
}

/**
 * Plural of a product name for things counted one by one ("Apple" → "Apples",
 * "Brown onion" → "Brown onions", "Mango" → "Mangoes"). Names already plural stay as they are.
 */
export function pluralNoun(name: string): string {
  const trimmed = name.trim();
  if (/s$/i.test(trimmed)) return trimmed;
  if (/[^aeiou]y$/i.test(trimmed)) return `${trimmed.slice(0, -1)}ies`;
  if (/(ch|sh|x|z)$/i.test(trimmed) || /(tomato|potato|mango)$/i.test(trimmed)) return `${trimmed}es`;
  return `${trimmed}s`;
}
