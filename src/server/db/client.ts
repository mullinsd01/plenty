import "server-only";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything that can run queries: the root db or a transaction. */
export type Queryable = Database | Tx;

const APP_ROLE = "plenty_app";

declare global {
  // Reuse the pool across hot reloads in development.
  var __plentyPool: Pool | undefined;
}

function createPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env and configure Postgres.");
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (err) => {
    console.error("[db] idle client error", err.message);
  });
  return pool;
}

export const pool: Pool = globalThis.__plentyPool ?? createPool();
if (process.env.NODE_ENV !== "production") globalThis.__plentyPool = pool;

/**
 * Root database handle (table owner). Bypasses row-level security — use only
 * for trusted system operations: authentication, invitation acceptance,
 * scheduled jobs, demo seeding and account deletion.
 */
export const systemDb: Database = drizzle(pool, { schema });

/**
 * Run `fn` in a transaction as the restricted `plenty_app` role with the
 * signed-in user's id in `app.user_id`. Row-level security then guarantees
 * the queries can only see and modify that user's households.
 */
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return systemDb.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('role', ${APP_ROLE}, true), set_config('app.user_id', ${userId}, true)`,
    );
    return fn(tx);
  });
}

/** Run `fn` in a system (owner) transaction. See `systemDb` for when this is appropriate. */
export async function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return systemDb.transaction(fn);
}

export { schema };
