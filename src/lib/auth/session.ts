import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { query, queryOne } from "@/lib/db";
import { ApiError } from "@/lib/http";

/**
 * Server-side sessions.
 *
 * A JWT would avoid this table, but a JWT cannot be revoked, and this product
 * has to honour sign-out and "deleting the account deletes the key" for real.
 * The `on delete cascade` from users → sessions is what makes account deletion
 * one transaction.
 *
 * The cookie holds 32 random bytes. The database holds only their SHA-256, so
 * database read access does not yield a usable cookie. No stretching is needed
 * here the way it is for passwords: the token is full-entropy random, not a
 * guessable secret, so a single fast hash is the correct choice.
 */

export const SESSION_COOKIE = "ncc_session";
const SESSION_TTL_DAYS = 30;
const TOKEN_BYTES = 32;

export type SessionUser = {
  id: string;
  email: string;
  createdAt: string;
};

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Creates a session row and sets the cookie. Returns nothing to the caller. */
export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);

  await query(
    "insert into sessions (user_id, token_hash, expires_at) values ($1, $2, $3)",
    [userId, hashToken(token), expiresAt],
  );

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true, // JavaScript can never read it, so XSS cannot exfiltrate it.
    secure: process.env.NODE_ENV === "production", // HTTPS only in production.
    sameSite: "lax", // Blocks cross-site POST; keeps normal top-level links working.
    path: "/",
    expires: expiresAt,
  });
}

/**
 * Resolves the caller's session. Returns null rather than throwing so that
 * public surfaces can ask "is anyone signed in?" without branching on errors.
 *
 * Expiry is enforced in the SQL predicate, not in JavaScript after the fetch —
 * an expired row can never be mistaken for a live one.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const row = await queryOne<{
    id: string;
    email: string;
    created_at: Date;
  }>(
    `select u.id, u.email, u.created_at
       from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1
        and s.expires_at > now()`,
    [hashToken(token)],
  );

  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Authentication gate. Use this at the top of any route that needs a signed-in
 * caller — and remember it answers "who are you", never "may you touch this
 * row". Ownership is a separate check at every query.
 */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    throw new ApiError("unauthenticated", "Please sign in to continue.");
  }
  return user;
}

/** Revokes the current session server-side and clears the cookie. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;

  if (token) {
    // Delete the row first. If the cookie somehow survives, it is already dead.
    await query("delete from sessions where token_hash = $1", [
      hashToken(token),
    ]);
  }

  jar.delete(SESSION_COOKIE);
}

/** Revokes every session for an account — used when the account is deleted. */
export async function destroyAllSessions(userId: string): Promise<void> {
  await query("delete from sessions where user_id = $1", [userId]);
}
