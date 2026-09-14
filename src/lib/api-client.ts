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

export async function apiFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      method: init?.method ?? "GET",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
      // Same-origin only. The session cookie must never be sent anywhere else.
      credentials: "same-origin",
    });
  } catch {
    throw new ApiCallError(
      "internal_error",
      "Could not reach the server. Check your connection and try again.",
    );
  }

  if (response.status === 204) return undefined as T;

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

  return (await response.json()) as T;
}
