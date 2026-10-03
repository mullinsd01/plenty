import "server-only";
import { env, isProduction } from "@/server/env";

/**
 * What the public Privacy, Terms and Support pages say about who runs this
 * Plenty and how to reach them. Read from the environment; never invented.
 * In development a missing value shows a clearly marked placeholder so it's
 * noticed; in production it is simply left out (`null`).
 */
export interface LegalContact {
  entityName: string | null;
  supportEmail: string | null;
  privacyEmail: string | null;
  /** Placeholders shown in development for anything not set. */
  missing: string[];
}

export function legalContact(): LegalContact {
  const e = env();
  const dev = !isProduction();
  const missing: string[] = [];
  const pick = (value: string | undefined, name: string): string | null => {
    if (value) return value;
    if (dev) {
      missing.push(name);
      return `[set ${name}]`;
    }
    return null;
  };
  const supportEmail = pick(e.SUPPORT_EMAIL, "SUPPORT_EMAIL");
  return {
    entityName: pick(e.LEGAL_ENTITY_NAME, "LEGAL_ENTITY_NAME"),
    supportEmail,
    // Privacy requests go to the support address when there's no separate one.
    privacyEmail: e.PRIVACY_CONTACT_EMAIL ?? e.SUPPORT_EMAIL ?? (dev ? pick(undefined, "PRIVACY_CONTACT_EMAIL") : null),
    missing,
  };
}
