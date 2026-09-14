import type { ApiErrorBody, ErrorCode } from "@/lib/http";

/**
 * The browser side of the contract.
 *
 * Every call goes through here so that error handling exists in exactly one
 * place: a route either resolves with its payload or rejects with an
 * `ApiCallError` carrying a stable `code`, a message safe to display, and any
 * per-field messages. No component parses a response body itself.
 */

export class ApiCallError extends Error {
  readonly code: ErrorCode;
  readonly fields: Record<string, string>;
  /** Seconds until a rate limit resets, when the server sent one. */
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    message: string,
    fields: Record<string, string> = {},
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiCallError";
    this.code = code;
    this.fields = fields;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** What the `RateLimit-*` headers say about the budget a call just spent. */
export type RateLimitSnapshot = {
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
};

/**
 * Reads the `RateLimit-*` headers off any response.
 *
 * These ride on successes as well as refusals, which is the whole point: a UI
 * that only learns about the limit from a 429 can only ever report the wall
 * after walking into it. Returns null when the route is unlimited or the
 * headers are malformed — a missing budget is not a zero budget.
 */
export function readRateLimit(headers: Headers): RateLimitSnapshot | null {
  const limit = Number(headers.get("RateLimit-Limit"));
  const remaining = Number(headers.get("RateLimit-Remaining"));
  const resetSeconds = Number(headers.get("RateLimit-Reset"));

  if (
    !Number.isFinite(limit) ||
    !Number.isFinite(remaining) ||
    !Number.isFinite(resetSeconds)
  ) {
    return null;
  }

  return { limit, remaining, resetSeconds };
}

export type ApiRequestInit = {
  method?: string;
  body?: unknown;
  /**
   * Cancels the request. `PUT /api/keys/:provider` validates against the
   * provider before storing, so it is slow by design and is exactly the call a
   * user navigates away from mid-flight.
   */
  signal?: AbortSignal;
};

/** A response body alongside what the call cost against the rate limit. */
export type ApiResult<T> = {
  data: T;
  rateLimit: RateLimitSnapshot | null;
};

/**
 * The full-fidelity call. Use this when the caller wants the rate-limit budget
 * as well as the payload; `apiFetch` is the shorthand for when it does not.
 */
export async function apiRequest<T>(
  path: string,
  init?: ApiRequestInit,
): Promise<ApiResult<T>> {
  let response: Response;

  try {
    response = await fetch(path, {
      method: init?.method ?? "GET",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
      // Same-origin only. The session cookie must never be sent anywhere else.
      credentials: "same-origin",
      signal: init?.signal,
    });
  } catch (caught) {
    // An abort is the caller's own doing, not a failure to report to the user.
    // Rethrowing it verbatim lets `caught.name === "AbortError"` still work.
    if (caught instanceof DOMException && caught.name === "AbortError") {
      throw caught;
    }

    throw new ApiCallError(
      "internal_error",
      "Could not reach the server. Check your connection and try again.",
    );
  }

  const rateLimit = readRateLimit(response.headers);

  if (response.status === 204) {
    return { data: undefined as T, rateLimit };
  }

  if (!response.ok) {
    const retryAfter = Number(response.headers.get("Retry-After"));

    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // A non-JSON error means something upstream of the app failed.
    }

    throw new ApiCallError(
      body?.error?.code ?? "internal_error",
      body?.error?.message ?? "Something went wrong. Please try again.",
      body?.error?.fields ?? {},
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  return { data: (await response.json()) as T, rateLimit };
}

/**
 * The common case: the payload, or a throw. Callers that need the rate-limit
 * budget reach for `apiRequest` instead.
 */
export async function apiFetch<T>(
  path: string,
  init?: ApiRequestInit,
): Promise<T> {
  const { data } = await apiRequest<T>(path, init);
  return data;
}
