import { ApiCallError } from "@/lib/api-client";
import type { ApiErrorBody } from "@/lib/http";
import type { ChatMessage, ChatStreamEvent } from "@/lib/providers/types";

/**
 * The browser side of `POST /api/chat`.
 *
 * `EventSource` cannot POST, so this reads the `text/event-stream` body off a
 * `fetch` with a `ReadableStream` reader. That also gets us the one thing the
 * canvas needs and `EventSource` would not give: an abort signal that stops
 * the upstream provider call, so cancelling a node stops spending the user's
 * tokens.
 *
 * The route has two failure modes and this function preserves both:
 * a failure *before* the stream opens is a normal status code and JSON
 * envelope, so it rejects with `ApiCallError`; a failure *after* it opens
 * arrives as an `error` frame on a 200 response, so it is delivered to
 * `onEvent` as a terminal event. Callers handle one `code` vocabulary either
 * way.
 */

export type RateLimitSnapshot = {
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
};

export type StreamChatRequest = {
  provider: string;
  model: string;
  messages: ChatMessage[];
  system?: string;
  signal?: AbortSignal;
  /** Called for every frame, in order, including the terminal one. */
  onEvent: (event: ChatStreamEvent) => void;
  /**
   * Called once, as soon as the response headers land — before any frame.
   * This is how the canvas warns *before* the user hits the wall rather than
   * after, which is the reason the route sets these headers on successes too.
   */
  onRateLimit?: (snapshot: RateLimitSnapshot) => void;
};

export type StreamChatResult = {
  /** False when the caller aborted. Nothing failed; the user stopped it. */
  completed: boolean;
};

/** Present on every response, success or refusal. Absent only if something proxied it away. */
export function readRateLimit(headers: Headers): RateLimitSnapshot | null {
  const limit = Number(headers.get("RateLimit-Limit"));
  const remaining = Number(headers.get("RateLimit-Remaining"));
  const resetSeconds = Number(headers.get("RateLimit-Reset"));

  if (![limit, remaining, resetSeconds].every(Number.isFinite)) return null;
  return { limit, remaining, resetSeconds };
}

export async function streamChat(
  request: StreamChatRequest,
): Promise<StreamChatResult> {
  const { onEvent, onRateLimit, signal } = request;

  let response: Response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      signal,
      body: JSON.stringify({
        provider: request.provider,
        model: request.model,
        messages: request.messages,
        ...(request.system ? { system: request.system } : {}),
      }),
    });
  } catch (error) {
    if (isAbort(error, signal)) return { completed: false };
    throw new ApiCallError(
      "internal_error",
      "Could not reach the server. Check your connection and try again.",
    );
  }

  const rateLimit = readRateLimit(response.headers);
  if (rateLimit) onRateLimit?.(rateLimit);

  // Failed before the stream opened: an ordinary envelope with a status code.
  if (!response.ok) {
    throw await toApiCallError(response);
  }

  if (!response.body) {
    throw new ApiCallError(
      "internal_error",
      "The response stopped unexpectedly. Please try again.",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminal = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. A chunk boundary can fall
      // anywhere, including mid-frame, so only whole frames are consumed and
      // the remainder stays buffered.
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        const event = parseFrame(frame);
        if (event) {
          onEvent(event);
          if (event.type === "done" || event.type === "error") sawTerminal = true;
        }

        split = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (isAbort(error, signal)) return { completed: false };
    throw error;
  } finally {
    // Releasing matters on the abort path: the body is still open otherwise.
    reader.releaseLock();
  }

  if (signal?.aborted) return { completed: false };

  // The body ended without a `done` or `error` frame. The route always sends
  // one, so this is a dropped connection — surfaced as a terminal error
  // rather than leaving the node spinning forever.
  if (!sawTerminal) {
    onEvent({
      type: "error",
      code: "internal_error",
      message: "The response stopped unexpectedly. Please try again.",
    });
  }

  return { completed: true };
}

/**
 * One SSE frame → one event. A frame may carry several `data:` lines, which
 * the spec says to join with newlines; the route sends one, but honouring the
 * spec costs nothing and a silently dropped frame would be an ugly bug.
 * Comment lines (`:`) and unknown fields are ignored.
 */
function parseFrame(frame: string): ChatStreamEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (data === "") return null;

  try {
    return JSON.parse(data) as ChatStreamEvent;
  } catch {
    // A malformed frame is not worth tearing the stream down for.
    return null;
  }
}

async function toApiCallError(response: Response): Promise<ApiCallError> {
  const retryAfter = Number(response.headers.get("Retry-After"));

  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // Non-JSON means something upstream of the app failed.
  }

  return new ApiCallError(
    body?.error?.code ?? "internal_error",
    body?.error?.message ?? "Something went wrong. Please try again.",
    body?.error?.fields ?? {},
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}
