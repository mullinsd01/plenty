import "server-only";
import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { systemDb, type Queryable } from "@/server/db/client";
import { receipts } from "@/server/db/schema";
import { removeStoredFile } from "@/server/storage/files";

/**
 * How long Plenty keeps receipt photos.
 *
 * A receipt photo is only needed to read it and to check the reading. Once
 * it's confirmed the structured items are what Plenty works from, so the
 * photo is removed by default; the household can ask to keep photos for
 * 30 days or until they delete them. A photo nobody ever checked is removed
 * after 14 days. What's kept after the photo goes: the accepted items, the
 * store, the date and the total (and a fingerprint, so the same photo isn't
 * added twice).
 */

export const RETENTION_POLICIES = ["after_review", "days_30", "keep"] as const;
export type ReceiptImageRetention = (typeof RETENTION_POLICIES)[number];

export const RETENTION_LABELS: Record<ReceiptImageRetention, { label: string; description: string }> = {
  after_review: { label: "Delete once checked", description: "The photo is removed as soon as you've added the receipt to your kitchen or thrown it away." },
  days_30: { label: "Keep for 30 days", description: "The photo is removed 30 days after you check it, in case you want to look again." },
  keep: { label: "Keep until I delete it", description: "Photos stay until you delete the receipt, your household or your account." },
};

/** A photo that was never checked is removed after this many days. */
export const UNCHECKED_IMAGE_DAYS = 14;
export const KEPT_IMAGE_DAYS = 30;
const DAY = 86_400_000;

export function isRetentionPolicy(value: unknown): value is ReceiptImageRetention {
  return typeof value === "string" && (RETENTION_POLICIES as readonly string[]).includes(value);
}

/** When a photo checked at `checkedAt` is due for removal under `policy`; null when it's kept. */
export function imageDeleteAfter(policy: ReceiptImageRetention, checkedAt: Date): Date | null {
  switch (policy) {
    case "after_review":
      return checkedAt;
    case "days_30":
      return new Date(checkedAt.getTime() + KEPT_IMAGE_DAYS * DAY);
    case "keep":
      return null;
  }
}

/** When a freshly uploaded photo is removed if nobody checks it. */
export function uncheckedImageDeadline(uploadedAt: Date): Date {
  return new Date(uploadedAt.getTime() + UNCHECKED_IMAGE_DAYS * DAY);
}

export interface ImageSweepResult {
  deleted: number;
  /** Photos that couldn't be removed this time; the next run tries again. */
  failed: number;
}

/**
 * Scheduled job (also run right after a receipt is checked): remove the stored
 * photo of every receipt whose time is up, and record that it's gone. The
 * receipt and its accepted items stay. Idempotent and safe to run as often as
 * you like: a receipt is only marked once its file is really gone, and a
 * crash between the two steps is repaired by the next run.
 * System connection: it works across households.
 */
export async function deleteExpiredReceiptImages(
  now = new Date(),
  opts: { receiptId?: string; householdId?: string; limit?: number; db?: Queryable } = {},
): Promise<ImageSweepResult> {
  const db = opts.db ?? systemDb;
  const due = await db
    .select({ id: receipts.id, imagePath: receipts.imagePath })
    .from(receipts)
    .where(
      and(
        isNotNull(receipts.imagePath),
        isNull(receipts.imageDeletedAt),
        isNotNull(receipts.imageDeleteAfter),
        lte(receipts.imageDeleteAfter, now),
        opts.receiptId ? eq(receipts.id, opts.receiptId) : undefined,
        opts.householdId ? eq(receipts.householdId, opts.householdId) : undefined,
      ),
    )
    .orderBy(receipts.imageDeleteAfter)
    .limit(opts.limit ?? 500);
  let deleted = 0;
  let failed = 0;
  for (const r of due) {
    if (!r.imagePath) continue;
    if (!(await removeStoredFile(r.imagePath))) {
      failed += 1;
      continue;
    }
    const marked = await db
      .update(receipts)
      .set({ imagePath: null, imageDeletedAt: now })
      .where(and(eq(receipts.id, r.id), eq(receipts.imagePath, r.imagePath)))
      .returning({ id: receipts.id });
    deleted += marked.length;
  }
  return { deleted, failed };
}

/**
 * The household changed how long photos are kept: apply it to the photos it
 * already has. A shorter choice brings forward the removal of photos not yet
 * removed; "keep" cancels removals still pending for receipts that are done
 * with. Photos already deleted don't come back. Runs in the caller's
 * transaction (the member's own row-level-security context).
 */
export async function applyRetentionToExisting(tx: Queryable, householdId: string, policy: ReceiptImageRetention, now: Date): Promise<void> {
  const checked = and(
    eq(receipts.householdId, householdId),
    isNotNull(receipts.imagePath),
    isNull(receipts.imageDeletedAt),
    inArray(receipts.status, ["confirmed", "discarded"]),
  );
  if (policy === "keep") {
    await tx.update(receipts).set({ imageDeleteAfter: null }).where(and(checked, eq(receipts.status, "confirmed")));
    return;
  }
  const days = policy === "after_review" ? 0 : KEPT_IMAGE_DAYS;
  // From when each receipt was checked, never later than any removal already scheduled.
  await tx
    .update(receipts)
    .set({
      imageDeleteAfter: sql`least(coalesce(${receipts.imageDeleteAfter}, 'infinity'::timestamptz), coalesce(${receipts.confirmedAt}, ${now.toISOString()}::timestamptz) + make_interval(days => ${days}))`,
    })
    .where(checked);
}
