import { NextResponse, type NextRequest } from "next/server";
import { jsonError, routeContext } from "@/server/http";
import { search } from "@/server/services/search";

export async function GET(request: NextRequest) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const results = await search(ctx, request.nextUrl.searchParams.get("q") ?? "");
    return NextResponse.json(results, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return jsonError(err, "search");
  }
}
