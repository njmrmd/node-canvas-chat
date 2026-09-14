import { NextResponse } from "next/server";

/**
 * One error envelope for every API route, so the client never has to parse a
 * stack trace or guess at a shape:
 *
 *   { "error": { "code": "invalid_credentials", "message": "…" } }
 *
 * `code` is the stable contract — the client switches on it. `message` is
 * human-readable and safe to show; it is written for the person who hit it,
 * not for the person debugging it. Internal detail never crosses this line.
 */
export const ERROR_CODES = [
  "invalid_request", // body failed validation; `fields` says which
  "unauthenticated", // no valid session
  "forbidden", // signed in, but not entitled to this resource
  "not_found",
  "email_taken",
  "invalid_credentials",
  "invalid_api_key", // the provider rejected the user's key
  "provider_unavailable", // the provider errored or timed out
  "unsupported_provider", // not on the allowlist
  "unsupported_model", // not on the allowlist
  "no_key_configured",
  "rate_limited",
  "csrf_failed",
  "not_configured", // a required server env var is missing
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  email_taken: 409,
  invalid_credentials: 401,
  invalid_api_key: 400,
  provider_unavailable: 502,
  unsupported_provider: 400,
  unsupported_model: 400,
  no_key_configured: 409,
  rate_limited: 429,
  csrf_failed: 403,
  not_configured: 503,
  internal_error: 500,
};

export type ApiErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    /** Per-field messages, present only on `invalid_request`. */
    fields?: Record<string, string>;
  };
};

/**
 * Thrown anywhere below a route handler; `withRoute` turns it into the
 * envelope. Anything that is *not* an ApiError becomes a generic
 * `internal_error`, which is what keeps an unexpected throw from leaking a
 * connection string or a key fragment into a response body.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly fields?: Record<string, string>;
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { fields?: Record<string, string>; headers?: Record<string, string> },
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.fields = options?.fields;
    this.headers = options?.headers;
  }
}

export function errorResponse(error: ApiError): NextResponse<ApiErrorBody> {
  const body: ApiErrorBody = {
    error: { code: error.code, message: error.message },
  };
  if (error.fields) body.error.fields = error.fields;

  return NextResponse.json(body, {
    status: STATUS_BY_CODE[error.code],
    headers: error.headers,
  });
}

/**
 * Wraps a route handler so that every failure path produces the envelope.
 *
 * The `catch` is the "logging without leakage" boundary. We log that a route
 * failed and the error's own message, and nothing else — no request body, no
 * headers, no user identifiers. An unexpected error's message can still be
 * noisy, so it is logged but never returned.
 */
export function withRoute<Args extends unknown[]>(
  name: string,
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error);

      console.error(
        `[${name}] unhandled error:`,
        error instanceof Error ? error.message : "unknown",
      );
      return errorResponse(
        new ApiError(
          "internal_error",
          "Something went wrong on our side. Please try again.",
        ),
      );
    }
  };
}

/** JSON response with no-store — every route here is user-scoped. */
export function json<T>(
  body: T,
  init?: { status?: number; headers?: Record<string, string> },
): NextResponse<T> {
  return NextResponse.json(body, {
    status: init?.status ?? 200,
    headers: { "Cache-Control": "no-store", ...init?.headers },
  });
}

export function noContent(headers?: Record<string, string>): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

/**
 * Parses a JSON body, defensively. `input trust boundaries`: the body is
 * hostile until proven otherwise, so we cap the size, require the content
 * type, and reject anything that is not a plain object.
 */
const MAX_BODY_BYTES = 256 * 1024;

export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError("invalid_request", "Expected a JSON request body.");
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new ApiError("invalid_request", "Request body is too large.");
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw new ApiError("invalid_request", "Request body is too large.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError("invalid_request", "Request body is not valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError("invalid_request", "Request body must be a JSON object.");
  }

  return parsed as Record<string, unknown>;
}
