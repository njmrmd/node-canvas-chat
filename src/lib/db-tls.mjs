/**
 * TLS settings for every Postgres connection: the app's pool (`db.ts`) and
 * the migration runner (`scripts/migrate.mjs`). Plain JS so both can import it.
 *
 * `pg` merges the URL's `sslmode` over the `ssl` option, so the URL is what
 * decides, and the Neon integration writes `sslmode=require` into
 * DATABASE_URL and re-writes it on every secret rotation. `pg` 8 treats
 * `require`, `prefer` and `verify-ca` as verify-full; `pg` 9 will give them
 * libpq's meaning — encrypted, but the server certificate goes unchecked.
 * Rewriting them to `verify-full` here pins today's behaviour across that
 * upgrade, whatever the integration writes.
 *
 * `sslmode=disable` is left alone, so a local database still works without TLS.
 */

const WEAK_SSLMODE = /([?&]sslmode=)(require|prefer|verify-ca)(?=&|#|$)/gi;

/**
 * @param {string} connectionString
 * @returns {{ connectionString: string, ssl: { rejectUnauthorized: true } | undefined }}
 */
export function tlsConnectionConfig(connectionString) {
  return {
    connectionString: connectionString.replace(WEAK_SSLMODE, "$1verify-full"),
    // No sslmode in the URL: verified TLS rather than pg's default of none.
    ssl: /[?&]sslmode=disable(?=&|#|$)/i.test(connectionString)
      ? undefined
      : { rejectUnauthorized: true },
  };
}
