import { NextResponse } from "next/server";
import { recordClientAnalytics } from "@/server/analytics-intake";
import { jsonError, routeContext } from "@/server/http";

/**
 * First-party analytics intake: one small JSON event `{ event, props? }` from
 * a signed-in client. See src/lib/analytics-client.ts for what's allowed.
 * Never cached, never sets cookies, and answers the same whether or not the
 * event was recorded.
 */
export async function POST(request: Request) {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const result = await recordClientAnalytics(ctx, await request.text(), request.headers);
    if (result.status === 202) return new NextResponse(null, { status: 202, headers: { "cache-control": "no-store" } });
    return NextResponse.json(
      { error: result.error },
      { status: result.status, headers: result.status === 429 ? { "retry-after": String(result.retryAfterSeconds), "cache-control": "no-store" } : { "cache-control": "no-store" } },
    );
  } catch (err) {
    return jsonError(err, "analytics");
  }
}
