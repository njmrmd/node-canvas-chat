import { assertSameOrigin } from "@/lib/auth/csrf";
import { createSession } from "@/lib/auth/session";
import { hashPassword } from "@/lib/crypto/password";
import { queryOne } from "@/lib/db";
import { ApiError, json, readJsonBody, withRoute } from "@/lib/http";
import { POLICIES, enforce, ipSubject, rateLimitHeaders } from "@/lib/rate-limit";
import { FieldErrors, parseEmail, parseNewPassword } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/signup — create an account and sign in.
 *
 * Limited per IP: this is an unauthenticated surface, so there is no account
 * to attribute the request to yet.
 */
export const POST = withRoute("signup", async (request: Request) => {
  assertSameOrigin(request);

  const body = await readJsonBody(request);
  const errors = new FieldErrors();
  const email = parseEmail(body.email, errors);
  const password = parseNewPassword(body.password, errors);
  errors.throwIfAny();

  // Counted *after* validation, deliberately. The limit exists to stop scripted
  // account farming, and a request that fails validation does no database write
  // and no scrypt — it is not an attempt at an account, so it does not buy one.
  // Charging for it meant a stranger fumbling this form could spend their five
  // tries on typos and be locked out of signing up at all. Malformed requests
  // are now free, which is the right trade: they cost us nothing to refuse,
  // while anything that could actually create an account is still counted.
  const limit = await enforce(POLICIES.signUp, ipSubject(request));

  const passwordHash = await hashPassword(password!);

  // `on conflict do nothing` instead of a select-then-insert: the unique index
  // is the only thing that can decide this race, so let it.
  const row = await queryOne<{ id: string; email: string; created_at: Date }>(
    `insert into users (email, password_hash)
          values ($1, $2)
     on conflict (email) do nothing
       returning id, email, created_at`,
    [email, passwordHash],
  );

  if (!row) {
    // Sign-up necessarily reveals whether an email is registered — there is no
    // way to create an account at a taken address. We say so plainly and point
    // at sign-in, rather than pretending otherwise with a vague error.
    throw new ApiError(
      "email_taken",
      "An account already exists for that email. Try signing in instead.",
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
    { status: 201, headers: rateLimitHeaders(limit) },
  );
});
