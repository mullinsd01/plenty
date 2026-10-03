import "server-only";
import { z } from "zod";
import { fail } from "@/lib/result";

export type AppErrorCode =
  | "validation"
  | "not_found"
  | "forbidden"
  | "unauthenticated"
  | "rate_limited"
  | "conflict"
  | "ai_unavailable"
  | "receipt_invalid"
  | "storage"
  | "plan_limit"
  | "internal";

/** An error whose message is safe to show to users. */
export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what = "That item") => new AppError("not_found", `${what} couldn't be found. It may have been removed.`);

/** Flatten a zod error into { field: message }. */
export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/** Parse input with zod or throw a validation AppError with field messages. */
export function parseInput<S extends z.ZodType>(schemaDef: S, input: unknown): z.infer<S> {
  const parsed = schemaDef.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = zodFieldErrors(parsed.error);
    const first = Object.values(fieldErrors)[0] ?? "Please check the highlighted fields.";
    throw new AppError("validation", first, fieldErrors);
  }
  return parsed.data;
}

function isPgError(err: unknown): err is { code: string; message: string } {
  return typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string";
}

/**
 * Convert any thrown error into a user-safe message. Unknown errors are logged
 * with full detail on the server and shown generically — never a stack trace.
 */
export function toUserError(err: unknown, context: string): ReturnType<typeof fail> {
  if (err instanceof AppError) {
    return fail(err.message, { fieldErrors: err.fieldErrors, code: err.code });
  }
  const cause = (err as { cause?: unknown })?.cause;
  const pg = isPgError(err) ? err : isPgError(cause) ? cause : null;
  if (pg) {
    console.error(`[${context}] database error ${pg.code}:`, pg.message);
    if (pg.code === "42501") return fail("You don't have access to that.", { code: "forbidden" });
    if (pg.code === "23505") return fail("That already exists.", { code: "conflict" });
    if (pg.code === "23514" || pg.code === "22P02" || pg.code === "22003") {
      return fail("Some of those values aren't valid. Please check and try again.", { code: "validation" });
    }
    if (pg.code === "57P01" || pg.code === "08006" || pg.code === "08001" || pg.code === "53300") {
      return fail("Plenty is having trouble reaching its database. Please try again in a moment.", { code: "internal" });
    }
  } else {
    console.error(`[${context}]`, err);
  }
  return fail("Something went wrong on our side. Please try again.", { code: "internal" });
}
