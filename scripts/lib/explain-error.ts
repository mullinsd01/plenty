/**
 * Turn a failed database step into words someone can act on. The migration library reports the SQL it was running
 * ("Failed query: DO $$ ...") and keeps Postgres's own reason in `cause`; people need the reason, and for the
 * permission errors a restricted database host produces, what to ask the host for.
 */

interface PgLikeError {
  code?: string;
  message?: string;
  cause?: unknown;
}

/** The innermost error that carries a Postgres error code or message. */
function rootCause(err: unknown): PgLikeError {
  let current = err as PgLikeError | undefined;
  for (let depth = 0; current?.cause && depth < 5; depth += 1) current = current.cause as PgLikeError;
  return current ?? {};
}

export function explainDatabaseError(err: unknown): string {
  const cause = rootCause(err);
  const reason = (cause.message ?? (err instanceof Error ? err.message : String(err))).split("\n")[0];
  const text = `${reason}${cause.code ? ` (${cause.code})` : ""}`;
  if (cause.code === "42501" || /permission denied|must be (owner|superuser)|must have admin option/i.test(reason)) {
    return (
      `${text}\n` +
      "The database user in DATABASE_URL isn't allowed to do something the migrations need. The first run must be able to create the " +
      "plenty_app role (CREATE ROLE), grant it to itself, create the app schema and the pg_trgm extension, and it must be the user the app " +
      "connects as afterwards. See 'Choose a Postgres host' in docs/deploy.md for what to ask your host for."
    );
  }
  if (
    cause.code === "ECONNREFUSED" ||
    cause.code === "ENOTFOUND" ||
    cause.code === "ETIMEDOUT" ||
    cause.code === "28P01" ||
    cause.code === "3D000"
  ) {
    return `${text}\nCheck DATABASE_URL: the host, port, user, password and database name, and that the database accepts connections from here.`;
  }
  return text;
}
