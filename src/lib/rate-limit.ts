import { queryOne } from "@/lib/db";
import { ApiError } from "@/lib/http";

/**
 * Rate limiting as an abuse control, not a cost control.
 *
 * The user pays for their own inference, so we are not metering spend. We are
 * stopping credential stuffing against sign-in, mass account creation, and one
 * account hammering the provider through us.
 *
 * Fixed windows in Postgres, not a second managed service. The window start is
 * part of the primary key, so a window rolls over by inserting a new row — no
 * sweeper has to run for the limit to be correct, and `resetAt` is a real
 * timestamp we can hand to the UI instead of failing silently.
 *
 * The trade-off of fixed over sliding windows is a burst at a window boundary:
 * a caller can spend one window's budget at its end and the next at its start.
 * At these limits that is not an abuse channel worth a more complex counter.
 */

export type RateLimitPolicy = {
  /** Bucket name; part of the counter key. */
  bucket: string;
  /** Requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

/**
 * Every limit in the product, in one place, so the numbers are reviewable
 * rather than scattered across route handlers.
 */
export const POLICIES = {
  /** Per IP. Stops scripted account farming from one host. */
  signUp: { bucket: "signup", limit: 5, windowSeconds: 3600 },
  /** Per IP. The credential-stuffing control. */
  signIn: { bucket: "signin", limit: 10, windowSeconds: 900 },
  /** Per account. Saving a key hits the provider, so it is not free. */
  keyWrite: { bucket: "key_write", limit: 20, windowSeconds: 3600 },
  /** Per account. The main product action. */
  chat: { bucket: "chat", limit: 60, windowSeconds: 3600 },
  /**
   * Per account. Debounced client writes (§2.5: position 500ms, viewport
   * 1000ms), so normal use is a handful a minute — this is a backstop against
   * a runaway client loop, not a real limit on saving your own canvas.
   */
  canvasWrite: { bucket: "canvas_write", limit: 120, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitResult = {
  /**
   * Whether *this* request was permitted. Distinct from `remaining === 0`,
   * which is also true for the last request a window allows.
   */
  allowed: boolean;
  limit: number;
  remaining: number;
  /** When the current window ends and `remaining` returns to `limit`. */
  resetAt: Date;
};

/**
 * Response headers so the client can render the state before it is refused.
 * Names follow the IETF `RateLimit` header draft, plus `Retry-After` on a 429
 * because that one is universally understood.
 */
export function rateLimitHeaders(
  result: RateLimitResult,
  options?: { retryAfter?: boolean },
): Record<string, string> {
  const resetSeconds = Math.max(
    0,
    Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
  );

  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(resetSeconds),
  };

  if (options?.retryAfter) headers["Retry-After"] = String(resetSeconds);
  return headers;
}

/**
 * Consumes one unit against `policy` for `subject`, atomically.
 *
 * The insert-or-increment is a single statement so two concurrent requests
 * cannot both read 4 and both write 5. `where rate_limits.count < $4` is what
 * makes the limit real: at the ceiling the update matches no row, so the
 * statement returns nothing and we know we are over without a second read.
 */
export async function consume(
  policy: RateLimitPolicy,
  subject: string,
): Promise<RateLimitResult> {
  const windowMs = policy.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const resetAt = new Date(windowStart.getTime() + windowMs);

  const row = await queryOne<{ count: number }>(
    `insert into rate_limits (bucket, subject, window_start, count)
          values ($1, $2, $3, 1)
     on conflict (bucket, subject, window_start) do update
            set count = rate_limits.count + 1
          where rate_limits.count < $4
      returning count`,
    [policy.bucket, subject, windowStart, policy.limit],
  );

  // No returned row means the `count < limit` guard rejected the update, which
  // is exactly and only the refusal case. A returned row means this request
  // was counted, even when it consumed the last unit of the window.
  if (!row) {
    return { allowed: false, limit: policy.limit, remaining: 0, resetAt };
  }

  return {
    allowed: true,
    limit: policy.limit,
    remaining: Math.max(0, policy.limit - row.count),
    resetAt,
  };
}

/**
 * Consumes and throws a 429 when refused. The thrown error carries the same
 * `RateLimit-*` headers as a success, so the refusal is just as legible — and
 * the message names the limit and when it lifts rather than saying "slow down".
 */
export async function enforce(
  policy: RateLimitPolicy,
  subject: string,
): Promise<RateLimitResult> {
  const result = await consume(policy, subject);
  if (result.allowed) return result;

  const minutes = Math.max(
    1,
    Math.ceil((result.resetAt.getTime() - Date.now()) / 60000),
  );

  throw new ApiError(
    "rate_limited",
    `You have reached the limit of ${policy.limit} for this action. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    { headers: rateLimitHeaders(result, { retryAfter: true }) },
  );
}

/** Namespaced subjects, so an IP and a user id can never collide. */
export function userSubject(userId: string): string {
  return `user:${userId}`;
}

export function ipSubject(request: Request): string {
  return `ip:${clientIp(request)}`;
}

/**
 * Vercel sets `x-forwarded-for` and strips any client-supplied copy at the
 * edge, so the left-most entry is the real peer. Trusting this header would be
 * wrong behind an arbitrary proxy; it is correct on Vercel specifically, which
 * is where this runs.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
