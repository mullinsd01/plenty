import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";

/**
 * Private file storage for receipt photos. Files live outside `public/` and
 * are only served through an authenticated route that checks household
 * membership. Swap this module for S3/R2 in production deployments.
 */

const KEY_PATTERN = /^[a-f0-9-]{36}\/[a-f0-9-]{36}\.jpg$/;

function root(): string {
  // Runtime data directory, not source: keep the bundler from tracing the whole project.
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), env().STORAGE_DIR);
}

function resolveKey(key: string): string {
  if (!KEY_PATTERN.test(key)) throw new AppError("storage", "That file reference isn't valid.");
  const full = path.resolve(/*turbopackIgnore: true*/ root(), key);
  if (!full.startsWith(root() + path.sep)) throw new AppError("storage", "That file reference isn't valid.");
  return full;
}

export function receiptImageKey(householdId: string, receiptId: string): string {
  return `${householdId}/${receiptId}.jpg`;
}

export async function saveFile(key: string, data: Buffer): Promise<void> {
  const full = resolveKey(key);
  try {
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { mode: 0o600 });
  } catch (err) {
    console.error("[storage] write failed:", err);
    throw new AppError("storage", "We couldn't save that photo. Please try again.");
  }
}

export async function readStoredFile(key: string): Promise<Buffer | null> {
  try {
    return await readFile(resolveKey(key));
  } catch {
    return null;
  }
}

export async function deleteFile(key: string): Promise<void> {
  await rm(resolveKey(key), { force: true }).catch(() => undefined);
}

/**
 * Remove a stored file and say whether it is gone. Unlike `deleteFile` this
 * reports a failure (permissions, a read-only disk), so a caller that records
 * "deleted" never does so while the file is still there. Already gone counts as gone.
 */
export async function removeStoredFile(key: string): Promise<boolean> {
  try {
    await rm(resolveKey(key), { force: true });
    return true;
  } catch (err) {
    console.error("[storage] delete failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

export async function deleteHouseholdFiles(householdId: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(householdId)) return;
  await rm(path.join(root(), householdId), { recursive: true, force: true }).catch(() => undefined);
}
