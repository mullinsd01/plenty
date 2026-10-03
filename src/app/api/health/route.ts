import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { systemDb } from "@/server/db/client";

export async function GET() {
  try {
    await systemDb.execute(sql`select 1`);
    // Up or down, nothing more: which providers are configured isn't for anyone who finds this URL.
    return NextResponse.json({ ok: true, database: "up" });
  } catch {
    return NextResponse.json({ ok: false, database: "down" }, { status: 503 });
  }
}
