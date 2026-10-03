import { NextResponse, type NextRequest } from "next/server";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { jsonError, routeContext } from "@/server/http";
import { search } from "@/server/services/search";

export async function GET(request: NextRequest) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    // Search runs as you type; this stops a script hammering it, not anyone typing.
    await enforceRateLimit(`search:${ctx.user.id}`, 240, 60, "searching");
    const results = await search(ctx, request.nextUrl.searchParams.get("q") ?? "");
    return NextResponse.json(results, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return jsonError(err, "search");
  }
}
