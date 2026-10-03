/**
 * Result shape returned by every server action. Client-safe.
 * Errors are always human-readable; raw errors are only logged on the server.
 */
export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string>; code?: string; values?: Record<string, string> };

export function ok<T>(data: T, message?: string): ActionResult<T> {
  return { ok: true, data, message };
}

export function fail(
  error: string,
  extra?: { fieldErrors?: Record<string, string>; code?: string; values?: Record<string, string> },
): { ok: false; error: string; fieldErrors?: Record<string, string>; code?: string; values?: Record<string, string> } {
  return { ok: false, error, ...extra };
}

/** Initial state for `useActionState` forms. */
export const IDLE: ActionResult<never> | null = null;
