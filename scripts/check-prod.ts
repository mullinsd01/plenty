/**
 * Is this configuration ready to go live? Prints PASS / WARN / FAIL for each setting, then connects to the
 * database and the photo storage and checks they are set up the way Plenty needs. Exit code 1 if anything FAILs.
 * It never prints a secret value.
 *
 *   npm run check:prod                                 # the environment plus .env files in this folder
 *   npm run check:prod -- --env-file path/to/prod.env  # one specific file (plus the real environment)
 *   npm run check:prod -- --env-only                   # settings only: no database, no storage
 *   docker run --rm --env-file prod.env <image> check  # from inside the Docker image
 *
 * Writes and removes one tiny test file in the photo storage (local folder or bucket) to prove it works.
 * Reads the database; changes nothing in it.
 */
import { loadEnvConfig } from "@next/env";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { AppError } from "../src/server/errors";
import {
  checkDatabase,
  checkEnvironment,
  describeDatabaseUrl,
  exitCode,
  formatReport,
  safeMessage,
  type Check,
  type JournalEntry,
} from "./lib/prod-checks";

function readJournal(): JournalEntry[] | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as {
      entries?: JournalEntry[];
    };
    return (raw.entries ?? []).map((e) => ({ tag: e.tag, when: e.when }));
  } catch {
    return null;
  }
}

async function databaseChecks(databaseUrl: string): Promise<Check[]> {
  const target = describeDatabaseUrl(databaseUrl);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000, statement_timeout: 20_000 });
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (err) {
    return [
      {
        level: "FAIL",
        name: "Database connection",
        message: `to ${target} failed: ${safeMessage(err)}`,
        hint: "Check the host, port, user, password, database name and that the database accepts connections from here (firewall, sslmode).",
      },
    ];
  }
  try {
    return await checkDatabase(client, { journal: readJournal(), target });
  } catch (err) {
    return [{ level: "FAIL", name: "Database checks", message: `stopped: ${safeMessage(err)}` }];
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Save, read back and delete a test photo with the app's own storage code, so every permission it needs is exercised. */
async function storageCheck(): Promise<Check> {
  const { env } = await import("../src/server/env");
  const files = await import("../src/server/storage/files");
  const e = env();
  const where = e.STORAGE_DRIVER === "s3" ? `object storage (bucket ${e.S3_BUCKET})` : `local folder ${e.STORAGE_DIR}`;
  const name = "Receipt photo storage";
  const household = randomUUID();
  const key = files.receiptImageKey(household, randomUUID());
  const bytes = randomBytes(64);
  try {
    await files.saveFile(key, bytes);
    const back = await files.readStoredFile(key);
    if (!back || !back.equals(bytes))
      return {
        level: "FAIL",
        name,
        message: `wrote a test file to ${where} but couldn't read the same bytes back.`,
        hint: "Check the credentials can read objects, or the folder's permissions.",
      };
    // The same call that removes a household's photos when it is deleted: needs list and delete rights.
    await files.deleteHouseholdFiles(household);
    if (await files.readStoredFile(key))
      return {
        level: "FAIL",
        name,
        message: `the test file in ${where} was not removed.`,
        hint: "The storage user needs permission to list and delete objects, or household deletion would leave photos behind.",
      };
    return { level: "PASS", name, message: `wrote, read and removed a test file in ${where}.` };
  } catch (err) {
    return {
      level: "FAIL",
      name,
      message: `couldn't use ${where}${err instanceof AppError ? "" : ` (${safeMessage(err)})`}. The reason is in the [storage] line printed above the report.`,
      hint:
        e.STORAGE_DRIVER === "s3"
          ? "Check the bucket exists and the key can put, get, list and delete in it (and the endpoint and region)."
          : "Check the folder exists and is writable by the user the app runs as.",
    };
  } finally {
    await files.deleteHouseholdFiles(household).catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npm run check:prod -- [--env-file <path>] [--env-only] [--no-color]");
    return 0;
  }
  const envFileIndex = args.findIndex((a) => a === "--env-file" || a.startsWith("--env-file="));
  const envFile =
    envFileIndex < 0 ? null : args[envFileIndex].includes("=") ? args[envFileIndex].split("=").slice(1).join("=") : args[envFileIndex + 1];
  const envOnly = args.includes("--env-only");
  const color = !args.includes("--no-color") && !process.env.NO_COLOR && Boolean(process.stdout.isTTY);

  let source: string;
  if (envFileIndex >= 0) {
    if (!envFile) {
      console.error("--env-file needs a path.");
      return 2;
    }
    try {
      process.loadEnvFile(envFile);
    } catch {
      console.error(`Couldn't read the environment file ${envFile}.`);
      return 2;
    }
    source = `the environment plus ${envFile}`;
  } else {
    // Production mode: .env.production.local, .env.local, .env.production, .env (real environment variables win).
    const { loadedEnvFiles } = loadEnvConfig(process.cwd(), false, { info: () => undefined, error: () => undefined });
    const names = loadedEnvFiles.map((f) => path.basename(f.path));
    source = names.length > 0 ? `the environment plus ${names.join(", ")}` : "the environment (no .env files found)";
  }
  console.log(`Plenty production check\nSettings read from ${source}.\n`);

  const snapshot: Record<string, string | undefined> = { ...process.env };
  const checks: Check[] = checkEnvironment(snapshot);
  const settingsOk = !checks.some((c) => c.level === "FAIL");

  // The app's own validation (src/server/env.ts), as production would run it. Catches anything the checks above don't know about.
  let appAccepts = false;
  if (settingsOk) {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      const { env } = await import("../src/server/env");
      env();
      appAccepts = true;
      checks.push({ level: "PASS", name: "App settings", message: "are accepted by the app's own validation." });
    } catch (err) {
      checks.push({
        level: "FAIL",
        name: "App settings",
        message: `are refused by the app: ${safeMessage(err)}`,
        hint: "The server would not start with these values. Fix them.",
      });
    }
  }

  if (envOnly) {
    checks.push({
      level: "WARN",
      name: "Database and storage",
      message: "were not checked (--env-only).",
      hint: "Run without --env-only against the real environment before going live.",
    });
  } else {
    const databaseUrl = snapshot.DATABASE_URL?.trim();
    if (databaseUrl && /^postgres(ql)?:\/\//.test(databaseUrl)) checks.push(...(await databaseChecks(databaseUrl)));
    if (appAccepts) checks.push(await storageCheck());
    else
      checks.push({
        level: "WARN",
        name: "Receipt photo storage",
        message: "was not tested because the settings above need fixing first.",
      });
  }

  console.log(formatReport(checks, { color }));
  return exitCode(checks);
}

main()
  .then((code) => {
    // Exit explicitly: a storage client can keep connections open for a while.
    process.stdout.write("", () => process.exit(code));
  })
  .catch((err) => {
    console.error("The check itself failed:", safeMessage(err));
    process.exit(2);
  });
