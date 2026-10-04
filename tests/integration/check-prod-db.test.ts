/**
 * The database half of `npm run check:prod`, against the real (migrated) test database: what it says about a
 * healthy database, and that it notices a table that was added without row-level security.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { checkDatabase, describeDatabaseUrl, type Check, type JournalEntry } from "../../scripts/lib/prod-checks";
import { syncCatalog } from "@/server/services/products";
import { syncRecipeLibrary } from "@/server/services/meals";

const journal: JournalEntry[] = (JSON.parse(readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] }).entries;

let client: Client;
const byName = (checks: Check[], name: string) => checks.find((c) => c.name === name);
const run = () => checkDatabase(client, { journal, target: describeDatabaseUrl(process.env.DATABASE_URL!) });

beforeAll(async () => {
  await syncCatalog();
  await syncRecipeLibrary();
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.query("drop table if exists public.zz_check_prod_no_rls");
  await client.end();
});

describe("check:prod database checks", () => {
  it("passes on a migrated database whose catalog is loaded", async () => {
    const checks = await run();
    expect(checks.filter((c) => c.level === "FAIL")).toEqual([]);
    for (const name of ["Database connection", "Migrations", "Role plenty_app", "Row-level security", "Query as plenty_app", "Product catalog and recipes"]) {
      expect(byName(checks, name)?.level, name).toBe("PASS");
    }
    expect(byName(checks, "Migrations")?.message).toContain(`all ${journal.length} applied`);
  });

  it("leaves the connection usable and in no transaction afterwards", async () => {
    await run();
    const { rows } = await client.query("select current_user as u, now() = statement_timestamp() as not_in_transaction");
    expect(rows[0].u).not.toBe("plenty_app");
    expect(rows[0].not_in_transaction).toBe(true);
  });

  it("fails, naming the table, when a table has no row-level security", async () => {
    await client.query("create table public.zz_check_prod_no_rls (id int)");
    try {
      const rls = byName(await run(), "Row-level security");
      expect(rls?.level).toBe("FAIL");
      expect(rls?.message).toContain("zz_check_prod_no_rls");
    } finally {
      await client.query("drop table public.zz_check_prod_no_rls");
    }
    expect(byName(await run(), "Row-level security")?.level).toBe("PASS");
  });

  it("fails when a migration this version ships hasn't been applied", async () => {
    const future = [...journal, { tag: "9999_not_applied_yet", when: Date.now() + 86_400_000 }];
    const checks = await checkDatabase(client, { journal: future, target: "t" });
    const migrations = byName(checks, "Migrations");
    expect(migrations?.level).toBe("FAIL");
    expect(migrations?.message).toContain("9999_not_applied_yet");
  });
});
