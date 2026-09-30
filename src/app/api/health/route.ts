import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { systemDb } from "@/server/db/client";
import { aiStatus } from "@/server/ai";

export async function GET() {
  try {
    await systemDb.execute(sql`select 1`);
    const ai = aiStatus();
    return NextResponse.json({ ok: true, database: "up", ai: ai.externalConfigured ? "external" : "local" });
  } catch {
    return NextResponse.json({ ok: false, database: "down" }, { status: 503 });
  }
}
