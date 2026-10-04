/**
 * Storage settings in src/server/env.ts: the local disk stays the default, and the S3 driver only
 * validates when it has what it needs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NAMES = ["STORAGE_DRIVER", "STORAGE_DIR", "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_FORCE_PATH_STYLE"];

async function load(settings: Record<string, string>) {
  vi.resetModules();
  for (const name of NAMES) vi.stubEnv(name, undefined as unknown as string);
  for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
  const { env } = await import("@/server/env");
  return env;
}

const S3 = { STORAGE_DRIVER: "s3", S3_BUCKET: "photos", S3_ACCESS_KEY_ID: "key-id", S3_SECRET_ACCESS_KEY: "key-secret" };

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgres://plenty:plenty@localhost:5432/plenty_test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("storage settings", () => {
  it("defaults to the local disk", async () => {
    const e = (await load({}))();
    expect(e.STORAGE_DRIVER).toBe("local");
    expect(e.STORAGE_DIR).toBe(".data/uploads");
    expect(e.S3_BUCKET).toBeUndefined();
    expect(e.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it("treats blank values (an empty line in an env file) as not set", async () => {
    const e = (await load({ STORAGE_DRIVER: "", STORAGE_DIR: "  ", S3_ENDPOINT: "", S3_REGION: "", S3_BUCKET: "", S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "" }))();
    expect(e.STORAGE_DRIVER).toBe("local");
    expect(e.STORAGE_DIR).toBe(".data/uploads");
    expect(e.S3_ENDPOINT).toBeUndefined();
    expect(e.S3_REGION).toBe("us-east-1");
  });

  it("does not need any S3 setting on the local driver", async () => {
    const e = (await load({ STORAGE_DRIVER: "local", STORAGE_DIR: "/data/uploads" }))();
    expect(e.STORAGE_DIR).toBe("/data/uploads");
  });

  it("accepts a complete S3 configuration", async () => {
    const e = (await load({ ...S3, S3_ENDPOINT: "https://abc123.r2.cloudflarestorage.com", S3_REGION: "auto", S3_FORCE_PATH_STYLE: "true" }))();
    expect(e).toMatchObject({
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "photos",
      S3_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
      S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "key-id",
      S3_SECRET_ACCESS_KEY: "key-secret",
      S3_FORCE_PATH_STYLE: true,
    });
  });

  it("works against AWS with no endpoint", async () => {
    const e = (await load({ ...S3, S3_REGION: "ap-southeast-2" }))();
    expect(e.S3_ENDPOINT).toBeUndefined();
    expect(e.S3_REGION).toBe("ap-southeast-2");
  });

  it.each(["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])("refuses the S3 driver without %s", async (missing) => {
    const settings: Record<string, string> = { ...S3 };
    delete settings[missing];
    const env = await load(settings);
    expect(() => env()).toThrow(new RegExp(`${missing}: is required when STORAGE_DRIVER=s3`));
  });

  it("names every missing S3 setting at once", async () => {
    const env = await load({ STORAGE_DRIVER: "s3" });
    expect(() => env()).toThrow(/S3_BUCKET.*S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY/);
  });

  it("refuses an unknown driver", async () => {
    const env = await load({ STORAGE_DRIVER: "gcs" });
    expect(() => env()).toThrow(/STORAGE_DRIVER/);
  });

  it("refuses an endpoint that isn't a web address, without echoing it", async () => {
    const env = await load({ ...S3, S3_ENDPOINT: "minio:9000/secret-looking-value" });
    let message = "";
    try {
      env();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/S3_ENDPOINT/);
    expect(message).not.toContain("secret-looking-value");
  });

  it("never puts the secret key in an error", async () => {
    const env = await load({ STORAGE_DRIVER: "s3", S3_SECRET_ACCESS_KEY: "do-not-print-this-key" });
    let message = "";
    try {
      env();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/S3_BUCKET/);
    expect(message).not.toContain("do-not-print-this-key");
  });
});
