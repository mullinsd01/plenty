/**
 * The S3 driver of src/server/storage/files.ts, against an in-memory stand-in for the S3 client.
 * Nothing here touches the network: S3Client.prototype.send is replaced, so the real command objects
 * are built (and their inputs checked) but never sent.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { AppError } from "@/server/errors";

const HOUSEHOLD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOUSEHOLD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BUCKET = "plenty-test-photos";
const PAGE_SIZE = 2;

const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const keyFor = (household: string, n: number) => `${household}/${rid(n)}.jpg`;

interface Stored {
  body: Buffer;
  contentType?: string;
}

/** What a fake bucket holds, and what was asked of it. */
const bucket = new Map<string, Stored>();
const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
let failWith: ((name: string, input: Record<string, unknown>) => Error | null) | null = null;
let failDeleteKeys = new Set<string>();
let seenClient: S3Client | null = null;

function notFound(): Error {
  return Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
}

/** Just enough of S3: put, get, delete, batch delete and a listing that pages every PAGE_SIZE keys. */
async function fakeSend(this: S3Client, command: unknown): Promise<unknown> {
  seenClient = this;
  const input = (command as { input: Record<string, unknown> }).input;
  const name = (command as { constructor: { name: string } }).constructor.name;
  calls.push({ name, input });
  const failure = failWith?.(name, input);
  if (failure) throw failure;
  expect(input.Bucket).toBe(BUCKET);

  if (command instanceof PutObjectCommand) {
    bucket.set(input.Key as string, { body: Buffer.from(input.Body as Buffer), contentType: input.ContentType as string | undefined });
    return {};
  }
  if (command instanceof GetObjectCommand) {
    const found = bucket.get(input.Key as string);
    if (!found) throw notFound();
    return { Body: { transformToByteArray: async () => new Uint8Array(found.body) } };
  }
  if (command instanceof DeleteObjectCommand) {
    bucket.delete(input.Key as string);
    return {};
  }
  if (command instanceof ListObjectsV2Command) {
    const prefix = (input.Prefix as string | undefined) ?? "";
    // Like S3, the continuation token marks the last key returned, so deleting earlier keys between pages skips nothing.
    const after = (input.ContinuationToken as string | undefined) ?? "";
    const keys = [...bucket.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
    const page = keys.slice(0, PAGE_SIZE);
    const more = keys.length > PAGE_SIZE;
    return { Contents: page.map((Key) => ({ Key })), IsTruncated: more, NextContinuationToken: more ? page[page.length - 1] : undefined };
  }
  if (command instanceof DeleteObjectsCommand) {
    const objects = (input.Delete as { Objects: Array<{ Key: string }> }).Objects;
    expect(objects.length).toBeLessThanOrEqual(1000);
    const errors: Array<{ Key: string; Code: string }> = [];
    for (const { Key } of objects) {
      if (failDeleteKeys.has(Key)) errors.push({ Key, Code: "InternalError" });
      else bucket.delete(Key);
    }
    return errors.length > 0 ? { Errors: errors } : {};
  }
  throw new Error(`The fake S3 doesn't know ${name}`);
}

const saved: Record<string, string | undefined> = {};
const SETTINGS: Record<string, string> = {
  STORAGE_DRIVER: "s3",
  S3_BUCKET: BUCKET,
  S3_ACCESS_KEY_ID: "test-access-key-id",
  S3_SECRET_ACCESS_KEY: "test-secret-access-key-never-logged",
  S3_ENDPOINT: "http://minio.test:9000",
  S3_REGION: "auto",
  S3_FORCE_PATH_STYLE: "true",
};

let files: typeof import("@/server/storage/files");

beforeAll(async () => {
  for (const [name, value] of Object.entries(SETTINGS)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  vi.spyOn(S3Client.prototype, "send").mockImplementation(fakeSend as never);
  files = await import("@/server/storage/files");
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const name of Object.keys(SETTINGS)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

beforeEach(() => {
  bucket.clear();
  calls.length = 0;
  failWith = null;
  failDeleteKeys = new Set();
  seenClient = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(S3Client.prototype, "send").mockImplementation(fakeSend as never);
});

const photo = (text = "jpeg bytes") => Buffer.from(text);
const sentCommands = (name: string) => calls.filter((c) => c.name === name);

describe("S3 storage: save and read", () => {
  it("stores the photo under its key in the configured bucket, as a private JPEG", async () => {
    const key = files.receiptImageKey(HOUSEHOLD_A, rid(1));
    await files.saveFile(key, photo("hello"));
    expect(key).toBe(`${HOUSEHOLD_A}/${rid(1)}.jpg`);
    const put = sentCommands("PutObjectCommand");
    expect(put).toHaveLength(1);
    expect(put[0].input).toMatchObject({ Bucket: BUCKET, Key: key, ContentType: "image/jpeg", CacheControl: "private, no-store" });
    expect(bucket.get(key)?.body.toString()).toBe("hello");
  });

  it("reads back exactly what was saved", async () => {
    const key = keyFor(HOUSEHOLD_A, 2);
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 250]);
    await files.saveFile(key, bytes);
    const back = await files.readStoredFile(key);
    expect(Buffer.isBuffer(back)).toBe(true);
    expect(back?.equals(bytes)).toBe(true);
  });

  it("returns null for a photo that isn't there, without logging an error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await files.readStoredFile(keyFor(HOUSEHOLD_A, 99))).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("returns null, and logs it, when the store can't be read for another reason", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    failWith = () => Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    expect(await files.readStoredFile(keyFor(HOUSEHOLD_A, 3))).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("fails a save in plain words, and keeps the cause and the credentials out of the message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    failWith = () => new Error("connect ECONNREFUSED 10.1.2.3:9000");
    const err = await files.saveFile(keyFor(HOUSEHOLD_A, 4), photo()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("storage");
    expect(err.message).toBe("We couldn't save that photo. Please try again.");
    expect(JSON.stringify(error.mock.calls)).not.toContain(SETTINGS.S3_SECRET_ACCESS_KEY);
    expect(bucket.size).toBe(0);
  });

  it("builds its client from the settings (endpoint, region, path-style addressing)", async () => {
    await files.saveFile(keyFor(HOUSEHOLD_A, 5), photo());
    expect(seenClient).not.toBeNull();
    expect(await seenClient!.config.region()).toBe("auto");
    expect(seenClient!.config.forcePathStyle).toBe(true);
    const endpoint = await seenClient!.config.endpoint!();
    expect(endpoint.hostname).toBe("minio.test");
    expect(endpoint.port).toBe(9000);
    const credentials = await seenClient!.config.credentials();
    expect(credentials.accessKeyId).toBe(SETTINGS.S3_ACCESS_KEY_ID);
  });
});

describe("S3 storage: deleting one photo", () => {
  it("removes the photo", async () => {
    const key = keyFor(HOUSEHOLD_A, 6);
    await files.saveFile(key, photo());
    await files.deleteFile(key);
    expect(bucket.has(key)).toBe(false);
    expect(sentCommands("DeleteObjectCommand")[0].input).toMatchObject({ Bucket: BUCKET, Key: key });
  });

  it("treats a photo that is already gone as removed", async () => {
    expect(await files.removeStoredFile(keyFor(HOUSEHOLD_A, 7))).toBe(true);
  });

  it("removeStoredFile removes the photo and says so", async () => {
    const key = keyFor(HOUSEHOLD_A, 8);
    await files.saveFile(key, photo());
    expect(await files.removeStoredFile(key)).toBe(true);
    expect(await files.readStoredFile(key)).toBeNull();
  });

  it("removeStoredFile reports false when the store refuses, so nobody records a deletion that didn't happen", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const key = keyFor(HOUSEHOLD_A, 9);
    await files.saveFile(key, photo());
    failWith = (name) => (name === "DeleteObjectCommand" ? new Error("Service Unavailable") : null);
    expect(await files.removeStoredFile(key)).toBe(false);
    expect(bucket.has(key)).toBe(true);
  });

  it("deleteFile never throws for a store failure", async () => {
    failWith = () => new Error("Service Unavailable");
    await expect(files.deleteFile(keyFor(HOUSEHOLD_A, 10))).resolves.toBeUndefined();
  });
});

describe("S3 storage: deleting a household's photos", () => {
  it("deletes every object under the household's prefix across several listing pages, and nothing else", async () => {
    for (let n = 1; n <= 5; n++) await files.saveFile(keyFor(HOUSEHOLD_A, n), photo(`a${n}`));
    for (let n = 1; n <= 3; n++) await files.saveFile(keyFor(HOUSEHOLD_B, n), photo(`b${n}`));
    calls.length = 0;

    await files.deleteHouseholdFiles(HOUSEHOLD_A);

    expect([...bucket.keys()].some((k) => k.startsWith(`${HOUSEHOLD_A}/`))).toBe(false);
    expect([...bucket.keys()].sort()).toEqual([1, 2, 3].map((n) => keyFor(HOUSEHOLD_B, n)));

    const listings = sentCommands("ListObjectsV2Command");
    expect(listings).toHaveLength(3);
    expect(listings.every((c) => c.input.Prefix === `${HOUSEHOLD_A}/`)).toBe(true);
    // Every page after the first continues from where the previous one stopped.
    expect(listings.map((c) => c.input.ContinuationToken)).toEqual([undefined, keyFor(HOUSEHOLD_A, 2), keyFor(HOUSEHOLD_A, 4)]);

    const deleted = sentCommands("DeleteObjectsCommand").flatMap((c) => (c.input.Delete as { Objects: Array<{ Key: string }> }).Objects.map((o) => o.Key));
    expect(deleted).toHaveLength(5);
    expect(deleted.every((k) => k.startsWith(`${HOUSEHOLD_A}/`))).toBe(true);
  });

  it("finishes without deleting anything when the household has no photos", async () => {
    await files.saveFile(keyFor(HOUSEHOLD_B, 1), photo());
    calls.length = 0;
    await files.deleteHouseholdFiles(HOUSEHOLD_A);
    expect(sentCommands("DeleteObjectsCommand")).toHaveLength(0);
    expect(bucket.size).toBe(1);
  });

  it("does not look at the bucket for something that isn't a household id (a prefix like '' or '../' must never reach S3)", async () => {
    for (const bad of ["", "/", "../", "*", HOUSEHOLD_A.toUpperCase(), `${HOUSEHOLD_A}/`, `${HOUSEHOLD_A}/${rid(1)}`]) {
      await files.deleteHouseholdFiles(bad);
    }
    expect(calls).toHaveLength(0);
  });

  it("keeps going after a batch fails, then throws so the failure is logged", async () => {
    for (let n = 1; n <= 5; n++) await files.saveFile(keyFor(HOUSEHOLD_A, n), photo());
    failDeleteKeys = new Set([keyFor(HOUSEHOLD_A, 1)]);
    const err = await files.deleteHouseholdFiles(HOUSEHOLD_A).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain("1 photo file(s)");
    expect([...bucket.keys()]).toEqual([keyFor(HOUSEHOLD_A, 1)]);
  });

  it("throws when the listing itself fails", async () => {
    failWith = (name) => (name === "ListObjectsV2Command" ? new Error("Access Denied") : null);
    await expect(files.deleteHouseholdFiles(HOUSEHOLD_A)).rejects.toThrow();
  });
});

describe("S3 storage: invalid keys", () => {
  const BAD_KEYS = [
    "",
    "../etc/passwd",
    `../${rid(1)}.jpg`,
    `${HOUSEHOLD_A}/../${HOUSEHOLD_B}.jpg`,
    `${HOUSEHOLD_A}/${rid(1)}.png`,
    `${HOUSEHOLD_A}/${rid(1)}.jpg/`,
    `/${HOUSEHOLD_A}/${rid(1)}.jpg`,
    `${HOUSEHOLD_A}/sub/${rid(1)}.jpg`,
    `${HOUSEHOLD_A.toUpperCase()}/${rid(1)}.jpg`,
    `${HOUSEHOLD_A}\\${rid(1)}.jpg`,
    `${HOUSEHOLD_A}/${rid(1)}.jpg\n`,
    "short/key.jpg",
  ];

  it.each(BAD_KEYS.map((k) => [JSON.stringify(k), k]))("rejects %s before anything is sent", async (_label, key) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const saved = await files.saveFile(key, photo()).catch((e) => e);
    expect(saved).toBeInstanceOf(AppError);
    expect(saved.message).toBe("That file reference isn't valid.");
    expect(await files.readStoredFile(key)).toBeNull();
    await expect(files.deleteFile(key)).rejects.toBeInstanceOf(AppError);
    expect(await files.removeStoredFile(key)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(bucket.size).toBe(0);
  });
});
