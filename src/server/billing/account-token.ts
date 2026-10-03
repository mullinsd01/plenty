import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { env } from "@/server/env";

/**
 * The opaque token a store purchase carries so a notification can be tied to
 * the household that bought it (Apple's `appAccountToken`, Google's
 * `obfuscatedAccountId`).
 *
 * The token is the household id passed through a keyed one-block permutation
 * (AES-128 with a key derived from BILLING_ACCOUNT_SECRET), formatted as a
 * UUID. Nothing is stored: a notification's token decrypts straight back to
 * the household id. Without the secret nobody can make a token that
 * decrypts to someone else's household, so a purchase can't be pointed at a
 * household its buyer didn't get a token for — a random token decrypts to
 * random bytes, which are not the id of any household.
 *
 * It reveals nothing about the household to the store, and it is only ever a
 * hint: an existing subscription link always wins over it (see apply-event).
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function key(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "plenty-billing", "account-token-v1", 16));
}

function toUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fromUuid(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

export function accountTokenFor(householdId: string, secret: string): string {
  if (!UUID_ANY.test(householdId.toLowerCase())) throw new Error("A household id is a UUID.");
  const cipher = createCipheriv("aes-128-ecb", key(secret), null);
  cipher.setAutoPadding(false);
  return toUuid(Buffer.concat([cipher.update(fromUuid(householdId.toLowerCase())), cipher.final()]));
}

/** The household a token was made for, or null if it isn't one of ours. */
export function householdFromAccountToken(token: string | null | undefined, secret: string | null | undefined): string | null {
  if (!token || !secret) return null;
  const lower = token.toLowerCase();
  if (!UUID_ANY.test(lower)) return null;
  try {
    const decipher = createDecipheriv("aes-128-ecb", key(secret), null);
    decipher.setAutoPadding(false);
    const id = toUuid(Buffer.concat([decipher.update(fromUuid(lower)), decipher.final()]));
    // Household ids are random (v4) UUIDs; anything else is a forged or foreign token.
    return UUID_V4.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The token for a household on this server, or null when no secret is configured. */
export function householdAccountToken(householdId: string): string | null {
  const secret = env().BILLING_ACCOUNT_SECRET;
  return secret ? accountTokenFor(householdId, secret) : null;
}
