/**
 * Proves that a built Plenty image can do what receipts need, on the platform it was built for:
 * hash a password (the native argon2 module), decode and re-encode a photo (the native sharp module), read it
 * with the on-device OCR (the Tesseract WASM engine and its English model) and store it.
 * Needs no database. The Dockerfile runs it as the last build step, so an image missing any of these
 * files never gets published; you can also run it any time:
 *
 *   docker run --rm <image> node tools/smoke.cjs
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const failures: string[] = [];

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    console.log(`✓ ${name}: ${await fn()}`);
  } catch (err) {
    failures.push(name);
    console.error(`✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  // The storage step reads the settings the way the app does; the database is never touched.
  process.env.DATABASE_URL ??= "postgres://smoke:smoke@localhost:5432/smoke";

  await step("Passwords (argon2)", async () => {
    const { hashPassword, verifyPassword } = await import("../src/server/auth/crypto");
    const hash = await hashPassword("a long passphrase for the smoke test");
    if (!(await verifyPassword(hash, "a long passphrase for the smoke test"))) throw new Error("a correct password was refused");
    if (await verifyPassword(hash, "a different passphrase")) throw new Error("a wrong password was accepted");
    return "hashed and verified";
  });

  let prepared: Buffer | null = null;
  await step("Photos (sharp)", async () => {
    const { prepareReceiptImage } = await import("../src/server/receipts/image");
    const sample = await readFile(path.join(process.cwd(), "public", "demo", "receipts", "coles-topup.png"));
    const image = await prepareReceiptImage(sample);
    prepared = image.buffer;
    return `decoded and re-encoded a ${image.width}x${image.height} photo`;
  });

  await step("Receipt reading (Tesseract OCR)", async () => {
    if (!prepared) throw new Error("needs the photo step to pass first");
    const { ocrVariant } = await import("../src/server/receipts/image");
    const { ocrReceipt, terminateOcrWorker } = await import("../src/server/receipts/ocr");
    try {
      const { text, confidence } = await ocrReceipt(await ocrVariant(prepared));
      if (!/coles/i.test(text) || !/\d+\.\d\d/.test(text))
        throw new Error("the engine ran but read nothing sensible from the sample receipt");
      return `read the sample receipt (confidence ${Math.round(confidence)}%)`;
    } finally {
      await terminateOcrWorker();
    }
  });

  await step("Photo storage (the configured STORAGE_DIR)", async () => {
    const files = await import("../src/server/storage/files");
    const { env } = await import("../src/server/env");
    if (env().STORAGE_DRIVER !== "local") return "skipped: the S3 driver is checked by check:prod";
    const household = randomUUID();
    const key = files.receiptImageKey(household, randomUUID());
    const bytes = Buffer.from("smoke test");
    try {
      await files.saveFile(key, bytes);
      const back = await files.readStoredFile(key);
      if (!back?.equals(bytes)) throw new Error("wrote a file but couldn't read it back");
    } finally {
      await files.deleteHouseholdFiles(household);
    }
    return `wrote, read and removed a file in ${env().STORAGE_DIR}`;
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}.`);
    process.exit(1);
  }
  console.log("\nThis image can hash passwords, process photos, read receipts and store them.");
  process.exit(0);
}

main().catch((err) => {
  console.error("The smoke test itself failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
