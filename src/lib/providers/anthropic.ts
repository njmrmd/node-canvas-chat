import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "@/lib/http";
import type { ChatMessage, ChatStreamEvent } from "./types";

/**
 * The Anthropic provider.
 *
 * `server-side egress only`: every function here runs in a Route Handler. The
 * user's key is decrypted, used to construct a client for the lifetime of one
 * request, and goes out of scope. It is never returned, never logged, never
 * put in a response header, and never sent to the browser.
 *
 * A fresh client per request is deliberate. Caching clients would mean a map
 * keyed by user, which is a cache of decrypted secrets living across requests —
 * exactly the thing we do not want in memory longer than necessary.
 */

/** A cap, not a target: generous for a conversational turn, but it bounds a
 *  runaway response, which matters when the user is paying for it. */
const MAX_TOKENS = 32_000;

/** Requests are user-initiated and interactive; do not sit on a dead socket. */
const TIMEOUT_MS = 120_000;

function clientFor(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    timeout: TIMEOUT_MS,
    maxRetries: 1,
  });
}

/**
 * Translates an SDK error into our envelope.
 *
 * `logging without leakage`: the provider's message can echo request content,
 * so we never forward it verbatim. The user gets a sentence they can act on;
 * the detail stays on our side of the boundary.
 */
function toApiError(error: unknown): ApiError {
  if (error instanceof Anthropic.AuthenticationError) {
    return new ApiError(
      "invalid_api_key",
      "Anthropic rejected that key. Check that you copied it in full and that it is still active.",
    );
  }

  if (error instanceof Anthropic.PermissionDeniedError) {
    return new ApiError(
      "invalid_api_key",
      "That key does not have permission to use the Anthropic API. Check its scopes or your account's billing status.",
    );
  }

  if (error instanceof Anthropic.RateLimitError) {
    return new ApiError(
      "provider_unavailable",
      "Anthropic is rate limiting this key right now. Wait a moment and try again.",
    );
  }

  if (error instanceof Anthropic.BadRequestError) {
    return new ApiError(
      "provider_unavailable",
      "Anthropic rejected this request. Try a shorter message or a different model.",
    );
  }

  if (error instanceof Anthropic.APIConnectionError) {
    return new ApiError(
      "provider_unavailable",
      "Could not reach Anthropic. Please try again.",
    );
  }

  if (error instanceof Anthropic.APIError) {
    return new ApiError(
      "provider_unavailable",
      "Anthropic returned an error. Please try again.",
    );
  }

  return new ApiError(
    "provider_unavailable",
    "The model provider could not be reached. Please try again.",
  );
}

/**
 * Proves a pasted key works before we store it, so an invalid key fails on the
 * screen where it was pasted rather than later inside a chat.
 *
 * `models.list` is an authenticated GET: it costs no tokens, so validating is
 * free for the user, and a 401 here is unambiguous.
 */
export async function validateApiKey(apiKey: string): Promise<void> {
  try {
    await clientFor(apiKey).models.list({ limit: 1 });
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * Streams a completion, yielding our own transport-neutral events rather than
 * the SDK's. The route turns these into SSE frames — nothing provider-shaped
 * reaches the client, so swapping or adding a provider does not change the
 * client contract.
 *
 * Adaptive thinking with `display: "summarized"` is on deliberately. On Opus 5
 * thinking runs by default, and with the default omitted display the user
 * would watch a long pause with nothing on screen. Surfacing the summary gives
 * the canvas something real to render while the model works.
 */
export async function* streamChat(options: {
  apiKey: string;
  model: string;
  system?: string;
  messages: ChatMessage[];
  signal: AbortSignal;
}): AsyncGenerator<ChatStreamEvent> {
  const stream = clientFor(options.apiKey).messages.stream(
    {
      model: options.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive", display: "summarized" },
      ...(options.system ? { system: options.system } : {}),
      messages: options.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    },
    { signal: options.signal },
  );

  try {
    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;

      if (event.delta.type === "text_delta") {
        yield { type: "text", text: event.delta.text };
      } else if (event.delta.type === "thinking_delta") {
        yield { type: "thinking", text: event.delta.thinking };
      }
    }

    const final = await stream.finalMessage();

    // A safety refusal is a 200 with `stop_reason: "refusal"`, not a thrown
    // error. Checking `stop_reason` before trusting the content is the only
    // way to tell "the model declined" from "the model said nothing".
    if (final.stop_reason === "refusal") {
      yield {
        type: "error",
        code: "provider_unavailable",
        message:
          "The model declined to answer this request. Try rephrasing it.",
      };
      return;
    }

    yield {
      type: "done",
      stopReason: final.stop_reason ?? "end_turn",
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      },
    };
  } catch (error) {
    // The client navigating away aborts the stream; that is not an error.
    if (options.signal.aborted) return;

    const apiError = toApiError(error);
    yield { type: "error", code: apiError.code, message: apiError.message };
  }
}
