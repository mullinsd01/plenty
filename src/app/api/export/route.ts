import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { jsonError, routeContext } from "@/server/http";
import { exportHouseholdData } from "@/server/services/data";

/** Download everything Plenty stores about the household, as JSON. */
export async function GET() {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    // A full copy of the household's data is the heaviest read there is: a handful an hour is plenty.
    await enforceRateLimit(`export:${ctx.user.id}`, 6, 3600, "downloading your data");
    const data = await exportHouseholdData(ctx);
    const filename = `plenty-export-${new Date().toISOString().slice(0, 10)}.json`;
    return new NextResponse(JSON.stringify(data, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return jsonError(err, "export");
  }
}
