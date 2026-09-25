import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { sslOptionFor } from "./db";

/**
 * Checks the TLS settings `pg` actually ends up with — the URL's `sslmode`
 * is merged over the options we pass, so testing `sslOptionFor` alone would
 * miss the case that matters. Constructing a Client does not connect.
 */
function effectiveSsl(connectionString: string): unknown {
  const client = new pg.Client({
    connectionString,
    ssl: sslOptionFor(connectionString),
  });
  return (client as unknown as { connectionParameters: { ssl: unknown } })
    .connectionParameters.ssl;
}

function verifiesCertificate(ssl: unknown): boolean {
  if (ssl === true) return true;
  if (typeof ssl !== "object" || ssl === null) return false;
  return (ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized !== false;
}

describe("database TLS", () => {
  for (const query of ["", "?sslmode=verify-full", "?sslmode=require&channel_binding=require"]) {
    it(`verifies the server certificate for ${query || "a URL with no sslmode"}`, () => {
      const ssl = effectiveSsl(`postgres://u:p@db.example.test/app${query}`);
      assert.ok(ssl, "TLS must be on");
      assert.ok(verifiesCertificate(ssl), `certificate check is off: ${JSON.stringify(ssl)}`);
    });
  }

  it("turns TLS off only when the URL says sslmode=disable", () => {
    assert.equal(effectiveSsl("postgres://u:p@localhost/app?sslmode=disable"), false);
  });
});
