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
      // Managed Postgres terminates TLS with a certificate we do not pin; the
      // connection string's sslmode governs. This keeps `pg` from rejecting
      // Neon's chain while still requiring TLS via the URL.
      ssl: connectionString.includes("sslmode=disable")
        ? undefined
        : { rejectUnauthorized: false },
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
