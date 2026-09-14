import { assertSameOrigin } from "@/lib/auth/csrf";
import { createSession } from "@/lib/auth/session";
import { dummyPasswordHash, verifyPassword } from "@/lib/crypto/password";
import { queryOne } from "@/lib/db";
import { ApiError, json, readJsonBody, withRoute } from "@/lib/http";
import { POLICIES, enforce, ipSubject, rateLimitHeaders } from "@/lib/rate-limit";
import { FieldErrors, parseEmail, parseExistingPassword } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/signin
 *
 * The per-IP limit here is the credential-stuffing control: it is the reason
 * this route is rate limited at all.
 */
export const POST = withRoute("signin", async (request: Request) => {
  assertSameOrigin(request);

  const limit = await enforce(POLICIES.signIn, ipSubject(request));

  const body = await readJsonBody(request);
  const errors = new FieldErrors();
  const email = parseEmail(body.email, errors);
  const password = parseExistingPassword(body.password, errors);
  errors.throwIfAny();

  const row = await queryOne<{
    id: string;
    email: string;
    password_hash: string;
    created_at: Date;
  }>(
    "select id, email, password_hash, created_at from users where email = $1",
    [email],
  );

  // Always run a verify, even with no matching account. Returning early on a
  // miss would make sign-in measurably faster for unregistered emails, which
  // turns response time into an account-enumeration oracle.
  const verified = await verifyPassword(
    password!,
    row?.password_hash ?? (await dummyPasswordHash()),
  );

  if (!row || !verified) {
    // One message for both failures, so the response cannot distinguish
    // "no such account" from "wrong password".
    throw new ApiError(
      "invalid_credentials",
      "That email and password do not match.",
    );
  }

  await createSession(row.id);

  return json(
    {
      user: {
        id: row.id,
        email: row.email,
        createdAt: row.created_at.toISOString(),
      },
    },
    { headers: rateLimitHeaders(limit) },
  );
});
