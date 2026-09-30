import { NextResponse } from "next/server";
import { jsonError, routeContext } from "@/server/http";
import { exportHouseholdData } from "@/server/services/data";

/** Download everything Plenty stores about the household, as JSON. */
export async function GET() {
  const ctx = await routeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
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
