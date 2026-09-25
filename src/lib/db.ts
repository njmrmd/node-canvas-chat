import { Pool, type QueryResultRow } from "pg";
import { ApiError } from "@/lib/http";

/**
 * A single `pg` pool per server instance.
 *
 * `max: 1` is deliberate. Each Vercel function instance handles one request at
 * a time, so a larger pool buys nothing and multiplies connections against the
 * database's limit. Point DATABASE_URL at a pooled (pgbouncer) endpoint and
 * this scales with instances rather than with connections.
 *
 * `pg` rather than a Neon-specific driver: it speaks to any Postgres, so the
 * hosting decision stays reversible.
 */
declare global {
  var __ncc_pool: Pool | undefined;
}

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * TLS with the server's certificate verified against the system CAs, which is
 * what Neon and every other managed Postgres presents. An `sslmode` in the URL
 * overrides this (`pg` merges the parsed URL over these options), so
 * `sslmode=disable` still turns TLS off for a local database. Use
 * `sslmode=verify-full` in hosted URLs: `pg` 8 treats `require` as
 * verify-full, but `pg` 9 will give it libpq's weaker, unverified meaning.
 */
export function sslOptionFor(
  connectionString: string,
): { rejectUnauthorized: true } | undefined {
  return connectionString.includes("sslmode=disable")
    ? undefined
    : { rejectUnauthorized: true };
}

function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    // Fail closed, and say which knob is missing without printing its value.
    throw new ApiError(
      "not_configured",
      "The database is not configured for this deployment yet.",
    );
  }

  // Reuse across hot reloads in dev and across invocations on a warm instance.
  if (!globalThis.__ncc_pool) {
    globalThis.__ncc_pool = new Pool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // TES-62: `/api/chat` runs `getSessionUser` → `enforce` (rate limit) →
      // `getDecryptedKey` before it ever calls a provider, and none of the
      // three logs anything until it throws. Without a bound here, a stalled
      // query — Neon waking from scale-to-zero, a lock held by a concurrent
      // request — is a silent `await` with no ceiling but the route's own
      // 300s `maxDuration`, which looks identical to the client's own 60s
      // watchdog firing on a provider hang: zero bytes, nothing in the logs.
      // `statement_timeout` asks Postgres itself to give up server-side;
      // `query_timeout` is the client-side backstop for a server that never
      // answers at all. Either one turns that silent hang into a thrown
      // error `withRoute` logs and turns into a fast, legible `internal_error`
      // instead of eating the request's full patience window. `fail closed`.
      statement_timeout: 10_000,
      query_timeout: 10_000,
      ssl: sslOptionFor(connectionString),
    });

    // An idle client erroring out must not take the process down.
    globalThis.__ncc_pool.on("error", (error) => {
      console.error("[db] idle client error:", error.message);
    });
  }

  return globalThis.__ncc_pool;
}

/**
 * Parameterised query. Every call site in this codebase passes values through
 * `params` — there is no string interpolation into SQL anywhere.
 */
export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function transaction<T>(
  fn: (run: typeof query) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const scoped = async <R extends QueryResultRow>(
      text: string,
      params: unknown[] = [],
    ) => (await client.query<R>(text, params)).rows;

    const result = await fn(scoped as typeof query);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
