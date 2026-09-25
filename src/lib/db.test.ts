import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { tlsConnectionConfig } from "./db-tls.mjs";

/**
 * Checks the TLS settings `pg` actually ends up with — the URL's `sslmode`
 * is merged over the options we pass, so testing the helper's output alone
 * would miss the case that matters. Constructing a Client does not connect.
 *
 * `uselibpqcompat=true` makes `pg` 8 read sslmode the way `pg` 9 will, where
 * `require` no longer checks the certificate. Every URL is tried both ways.
 */
function effectiveSsl(connectionString: string): unknown {
  const client = new pg.Client(tlsConnectionConfig(connectionString));
  return (client as unknown as { connectionParameters: { ssl: unknown } })
    .connectionParameters.ssl;
}

function verifiesCertificate(ssl: unknown): boolean {
  if (ssl === true) return true;
  if (typeof ssl !== "object" || ssl === null) return false;
  return (ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized !== false;
}

const BASE = "postgres://user:p%40ss@db.example.test/app";

// What the Neon integration writes, and the other shapes a URL can take.
const HOSTED = [
  "",
  "?sslmode=require&channel_binding=require",
  "?sslmode=prefer",
  "?sslmode=verify-ca",
  "?sslmode=verify-full",
];

describe("database TLS", () => {
  for (const query of HOSTED) {
    for (const semantics of ["pg 8", "pg 9 (libpq)"] as const) {
      const label = query || "(no sslmode)";
      it(`verifies the certificate for ${label} under ${semantics}`, () => {
        const libpq = semantics === "pg 8" ? "" : "uselibpqcompat=true";
        const url = libpq ? `${BASE}${query ? `${query}&` : "?"}${libpq}` : `${BASE}${query}`;
        const ssl = effectiveSsl(url);
        assert.ok(ssl, "TLS must be on");
        assert.ok(verifiesCertificate(ssl), `certificate check is off: ${JSON.stringify(ssl)}`);
      });
    }
  }

  it("upgrades only the sslmode, leaving the rest of the URL intact", () => {
    const { connectionString } = tlsConnectionConfig(
      `${BASE}?sslmode=require&channel_binding=require`,
    );
    assert.equal(connectionString, `${BASE}?sslmode=verify-full&channel_binding=require`);
  });

  it("turns TLS off only when the URL says sslmode=disable", () => {
    assert.equal(effectiveSsl("postgres://u:p@localhost/app?sslmode=disable"), false);
    assert.equal(
      tlsConnectionConfig("postgres://u:p@localhost/app?sslmode=disable").connectionString,
      "postgres://u:p@localhost/app?sslmode=disable",
    );
  });
});
