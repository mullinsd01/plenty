import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";

/**
 * Private file storage for receipt photos. Files are never public: they are only served through an
 * authenticated route that checks household membership. Two drivers, chosen by `STORAGE_DRIVER`:
 *
 *  - `local` (default): the server's own disk, under `STORAGE_DIR`. One server only, and the directory must
 *    be on a volume that survives redeploys.
 *  - `s3`: any S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2). Keep the bucket
 *    private. Objects use the same key as the local file: `<household id>/<receipt id>.jpg`.
 *
 * The exported functions are the same for both drivers; callers never know which one is in use.
 */

const KEY_PATTERN = /^[a-f0-9-]{36}\/[a-f0-9-]{36}\.jpg$/;
const ID_PATTERN = /^[a-f0-9-]{36}$/;
const INVALID_KEY = "That file reference isn't valid.";
/** Give up on object storage after this long, so a stalled connection can't hang an upload or a page. */
const S3_TIMEOUT_MS = 30_000;
/** S3 accepts at most 1000 keys per batch delete (and returns at most 1000 per listing page). */
const S3_BATCH = 1000;

/** The store behind the exported functions. Keys are already validated; each method does one thing and throws on failure. */
interface Driver {
  save(key: string, data: Buffer): Promise<void>;
  /** The file, or null when it doesn't exist. */
  read(key: string): Promise<Buffer | null>;
  /** Remove a file. A file that is already gone is not an error. */
  remove(key: string): Promise<void>;
  /** Remove everything stored for a household. */
  removeHousehold(householdId: string): Promise<void>;
}

function validKey(key: string): string {
  if (!KEY_PATTERN.test(key)) throw new AppError("storage", INVALID_KEY);
  return key;
}

// ─── Local disk ─────────────────────────────────────────────────────────────

function root(): string {
  // Runtime data directory, not source: keep the bundler from tracing the whole project.
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), env().STORAGE_DIR);
}

function resolveKey(key: string): string {
  validKey(key);
  const full = path.resolve(/*turbopackIgnore: true*/ root(), key);
  if (!full.startsWith(root() + path.sep)) throw new AppError("storage", INVALID_KEY);
  return full;
}

const localDriver: Driver = {
  async save(key, data) {
    const full = resolveKey(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { mode: 0o600 });
  },
  async read(key) {
    try {
      return await readFile(resolveKey(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  },
  async remove(key) {
    await rm(resolveKey(key), { force: true });
  },
  async removeHousehold(householdId) {
    // A household folder that can't be removed is not reported: the files age out with the receipts' own retention.
    await rm(path.join(root(), householdId), { recursive: true, force: true }).catch(() => undefined);
  },
};

// ─── S3-compatible object storage ───────────────────────────────────────────

type S3Sdk = typeof import("@aws-sdk/client-s3");
interface S3Context {
  sdk: S3Sdk;
  client: InstanceType<S3Sdk["S3Client"]>;
  bucket: string;
}

let s3Context: Promise<S3Context> | null = null;

/** The client is made on first use (and the SDK only loaded then), so deployments on local disk never pay for it. */
function s3(): Promise<S3Context> {
  if (!s3Context) {
    const created = (async (): Promise<S3Context> => {
      const sdk = await import("@aws-sdk/client-s3");
      const e = env();
      const client = new sdk.S3Client({
        region: e.S3_REGION,
        endpoint: e.S3_ENDPOINT,
        forcePathStyle: e.S3_FORCE_PATH_STYLE,
        credentials: { accessKeyId: e.S3_ACCESS_KEY_ID!, secretAccessKey: e.S3_SECRET_ACCESS_KEY! },
        maxAttempts: 3,
        // R2, B2 and older MinIO reject the extra checksum headers the SDK adds by default; only send them where S3 requires them.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        requestHandler: { connectionTimeout: 5_000, requestTimeout: S3_TIMEOUT_MS },
      });
      return { sdk, client, bucket: e.S3_BUCKET! };
    })();
    s3Context = created;
    created.catch(() => {
      if (s3Context === created) s3Context = null;
    });
  }
  return s3Context;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.Code === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

const s3Driver: Driver = {
  async save(key, data) {
    const { sdk, client, bucket } = await s3();
    await client.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: "image/jpeg", CacheControl: "private, no-store" }));
  },
  async read(key) {
    const { sdk, client, bucket } = await s3();
    try {
      const res = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },
  async remove(key) {
    const { sdk, client, bucket } = await s3();
    // S3 answers success for a key that isn't there, which is what "already gone" should mean.
    await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },
  async removeHousehold(householdId) {
    const { sdk, client, bucket } = await s3();
    const prefix = `${householdId}/`;
    let token: string | undefined;
    let failed = 0;
    do {
      const page = await client.send(new sdk.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: S3_BATCH }));
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key?.startsWith(prefix) ? [o.Key] : []));
      if (keys.length > 0) {
        const res = await client.send(new sdk.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
        failed += res.Errors?.length ?? 0;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    // Unlike a local folder, a photo that stays in a bucket is invisible to the app: say so, so it reaches the log.
    if (failed > 0) throw new AppError("storage", `${failed} photo file(s) for household ${householdId} could not be removed from object storage.`);
  },
};

function driver(): Driver {
  return env().STORAGE_DRIVER === "s3" ? s3Driver : localDriver;
}

/** Log what went wrong without the SDK's request details. */
function describe(err: unknown): string {
  if (err instanceof AppError) return err.message;
  const name = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);
  return `${name}: ${message}`;
}

// ─── Public API (the same whichever driver is in use) ───────────────────────

export function receiptImageKey(householdId: string, receiptId: string): string {
  return `${householdId}/${receiptId}.jpg`;
}

export async function saveFile(key: string, data: Buffer): Promise<void> {
  validKey(key);
  try {
    await driver().save(key, data);
  } catch (err) {
    console.error("[storage] write failed:", describe(err));
    throw new AppError("storage", "We couldn't save that photo. Please try again.");
  }
}

/** The stored file, or null when there is none, the key is invalid, or the store can't be read right now. */
export async function readStoredFile(key: string): Promise<Buffer | null> {
  try {
    return await driver().read(validKey(key));
  } catch (err) {
    if (!(err instanceof AppError)) console.error("[storage] read failed:", describe(err));
    return null;
  }
}

export async function deleteFile(key: string): Promise<void> {
  validKey(key);
  await driver()
    .remove(key)
    .catch(() => undefined);
}

/**
 * Remove a stored file and say whether it is gone. Unlike `deleteFile` this
 * reports a failure (permissions, a read-only disk, the storage service being down), so a caller that
 * records "deleted" never does so while the file is still there. Already gone counts as gone.
 */
export async function removeStoredFile(key: string): Promise<boolean> {
  try {
    await driver().remove(validKey(key));
    return true;
  } catch (err) {
    console.error("[storage] delete failed:", describe(err));
    return false;
  }
}

/**
 * Remove every photo a household has. On local disk a failure is ignored (the files age out with the
 * receipts); on object storage it throws, so the caller can log that photos are still there.
 */
export async function deleteHouseholdFiles(householdId: string): Promise<void> {
  if (!ID_PATTERN.test(householdId)) return;
  await driver().removeHousehold(householdId);
}
