import "server-only";
import { refresh } from "next/cache";
import { ok, type ActionResult } from "@/lib/result";
import { householdForAction, type HouseholdContext } from "@/server/auth/context";
import { toUserError } from "@/server/errors";

/**
 * Standard wrapper for household server actions: resolves the signed-in
 * household, runs the handler, refreshes the client router on success and
 * converts any failure into a friendly ActionResult.
 */
export async function householdAction<T>(
  name: string,
  handler: (ctx: HouseholdContext) => Promise<T>,
  opts: { message?: string | ((data: T) => string | undefined); refresh?: boolean } = {},
): Promise<ActionResult<T>> {
  try {
    const ctx = await householdForAction();
    const data = await handler(ctx);
    if (opts.refresh !== false) refresh();
    const message = typeof opts.message === "function" ? opts.message(data) : opts.message;
    return ok(data, message);
  } catch (err) {
    return toUserError(err, name);
  }
}
