/**
 * The local-disk driver of src/server/storage/files.ts (the default): files land under STORAGE_DIR with
 * private permissions, invalid or traversing keys are refused, and a household's folder goes in one call.
 */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/errors";

const HOUSEHOLD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOUSEHOLD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const keyFor = (household: string, n: number) => `${household}/${rid(n)}.jpg`;

let dir: string;
let files: typeof import("@/server/storage/files");
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "plenty-storage-"));
  for (const name of ["STORAGE_DRIVER", "STORAGE_DIR"]) saved[name] = process.env[name];
  delete process.env.STORAGE_DRIVER; // the default must be the local disk
  process.env.STORAGE_DIR = dir;
  files = await import("@/server/storage/files");
});

afterAll(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("local storage", () => {
  it("saves under STORAGE_DIR (the default driver) and reads the same bytes back", async () => {
    const key = files.receiptImageKey(HOUSEHOLD_A, rid(1));
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
    await files.saveFile(key, bytes);
    expect((await readdir(path.join(dir, HOUSEHOLD_A))).sort()).toEqual([`${rid(1)}.jpg`]);
    expect((await files.readStoredFile(key))?.equals(bytes)).toBe(true);
  });

  it("keeps photos private to the server's own user", async () => {
    const key = keyFor(HOUSEHOLD_A, 2);
    await files.saveFile(key, Buffer.from("x"));
    const mode = (await stat(path.join(dir, key))).mode & 0o777;
    // 0600 (the process umask can only remove bits); on Windows there are no such bits.
    if (process.platform !== "win32") expect(mode & 0o077).toBe(0);
  });

  it("returns null for a missing photo, quietly", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await files.readStoredFile(keyFor(HOUSEHOLD_A, 50))).toBeNull();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("deletes one photo, and a photo that is already gone counts as deleted", async () => {
    const key = keyFor(HOUSEHOLD_A, 3);
    await files.saveFile(key, Buffer.from("x"));
    expect(await files.removeStoredFile(key)).toBe(true);
    expect(await files.readStoredFile(key)).toBeNull();
    expect(await files.removeStoredFile(key)).toBe(true);
    await expect(files.deleteFile(key)).resolves.toBeUndefined();
  });

  it("deletes a household's whole folder and leaves other households alone", async () => {
    for (let n = 1; n <= 3; n++) await files.saveFile(keyFor(HOUSEHOLD_A, 10 + n), Buffer.from("a"));
    await files.saveFile(keyFor(HOUSEHOLD_B, 1), Buffer.from("b"));
    await files.deleteHouseholdFiles(HOUSEHOLD_A);
    expect(await readdir(dir)).toEqual([HOUSEHOLD_B]);
    // Nothing to delete is fine.
    await expect(files.deleteHouseholdFiles(HOUSEHOLD_A)).resolves.toBeUndefined();
  });

  it("ignores something that isn't a household id, so a path like '..' can't remove anything", async () => {
    await files.saveFile(keyFor(HOUSEHOLD_B, 2), Buffer.from("b"));
    for (const bad of ["", ".", "..", "../", "/", `${HOUSEHOLD_B}/..`]) await files.deleteHouseholdFiles(bad);
    expect((await readdir(path.join(dir, HOUSEHOLD_B))).length).toBeGreaterThan(0);
  });

  it.each([
    "",
    "../etc/passwd",
    `../${rid(1)}.jpg`,
    `${HOUSEHOLD_A}/../${HOUSEHOLD_B}.jpg`,
    `${HOUSEHOLD_A}/${rid(1)}.png`,
    `/${HOUSEHOLD_A}/${rid(1)}.jpg`,
    `${HOUSEHOLD_A}/sub/${rid(1)}.jpg`,
    `${HOUSEHOLD_A}\\${rid(1)}.jpg`,
  ])("refuses the key %j", async (key) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const err = await files.saveFile(key, Buffer.from("x")).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe("That file reference isn't valid.");
    expect(await files.readStoredFile(key)).toBeNull();
    await expect(files.deleteFile(key)).rejects.toBeInstanceOf(AppError);
    expect(await files.removeStoredFile(key)).toBe(false);
    vi.restoreAllMocks();
  });
});
