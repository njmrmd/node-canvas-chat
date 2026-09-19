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

/**
 * Two very different operations shared one 120s timeout, sized for the one
 * that needs it: a streamed completion, which `/api/chat` gives a matching
 * `maxDuration = 300` to run inside. `validateApiKey` calls `models.list`, a
 * single cheap GET, from a route with no `maxDuration` override — so it runs
 * inside Vercel's platform default, which is well under 120s. A real key that
 * legitimately takes longer than usual to authenticate would hit the
 * *platform's* timeout first, not ours, and surface as an abrupt connection
 * error indistinguishable from Anthropic itself being unreachable. Giving
 * validation its own short, intentional timeout means our code decides when
 * to give up, with room to spare inside the route's own budget below.
 */
const CHAT_TIMEOUT_MS = 120_000;
const VALIDATE_TIMEOUT_MS = 20_000;

function clientFor(apiKey: string, timeout: number): Anthropic {
  return new Anthropic({
    apiKey,
    timeout,
    maxRetries: 1,
  });
}

/**
 * Which call produced the error. Matters for exactly one branch below
 * (`BadRequestError`): `validate` is a bodyless, promptless GET, so neither
 * the user's message text nor anything content-shaped can appear in the
 * request Anthropic is complaining about — only the credential can. `chat`
 * carries a real conversation, where the same HTTP status could just as
 * easily mean an oversized message or an unsupported model.
 */
type ErrorContext = "validate" | "chat";

/**
 * Translates an SDK error into our envelope.
 *
 * `logging without leakage`: the provider's message can echo request content,
 * so we never forward it verbatim. The user gets a sentence they can act on;
 * the detail stays on our side of the boundary. The SDK's error *class* is not
 * request content, though, so each branch below can still log its own label —
 * without this, a rate limit, a malformed request and a dropped connection
 * are indistinguishable after the fact.
 *
 * `error.constructor.name` looked free but is not: a production bundle
 * minifies class names, so it logs single letters instead of "RateLimitError".
 * The `instanceof` branch below is what actually identifies the error (it
 * walks the prototype chain, not a name string), so each branch logs its own
 * literal label instead — that survives minification. `error.status` is a
 * plain data property on `APIError` (the real upstream HTTP status, e.g. 429,
 * or `undefined` for a connection-level failure with no response at all), so
 * it is included for free and needs no name lookup either.
 *
 * `error.message` is normally exactly the request content the leakage rule
 * exists to keep out of a log — except on `validate`, where there is no
 * content for it to be: Anthropic's own diagnostic text about *why* a
 * bodyless GET was malformed is safe there in a way it can never be for
 * `chat`, so it is the one context that logs it.
 */
function toApiError(error: unknown, context: ErrorContext): ApiError {
  const status = error instanceof Anthropic.APIError ? error.status : undefined;
  const detail =
    context === "validate" && error instanceof Anthropic.APIError
      ? ` detail=${JSON.stringify(error.message)}`
      : "";
  const classify = (label: string) =>
    console.error(`[anthropic] classified as ${label}, status=${status}${detail}`);

  if (error instanceof Anthropic.AuthenticationError) {
    classify("AuthenticationError");
    return new ApiError(
      "invalid_api_key",
      "Anthropic rejected that key. Check that you copied it in full and that it is still active.",
    );
  }

  if (error instanceof Anthropic.PermissionDeniedError) {
    classify("PermissionDeniedError");
    return new ApiError(
      "invalid_api_key",
      "That key does not have permission to use the Anthropic API. Check its scopes or your account's billing status.",
    );
  }

  if (error instanceof Anthropic.RateLimitError) {
    classify("RateLimitError");
    return new ApiError(
      "provider_unavailable",
      "Anthropic is rate limiting this key right now. Wait a moment and try again.",
    );
  }

  if (error instanceof Anthropic.BadRequestError) {
    classify("BadRequestError");
    if (context === "validate") {
      // `models.list({ limit: 1 })` has no body and no prompt — the only
      // thing left in the request for Anthropic to call malformed is the
      // credential itself. That is a property of this key, not a transient
      // provider blip, so `provider_unavailable` (implying "try again") would
      // be actively misleading: retrying the same key fails identically every
      // time. `invalid_api_key` at least tells the user the retry that will
      // actually work is pasting a different key.
      return new ApiError(
        "invalid_api_key",
        "Anthropic rejected that key as malformed. Check that you pasted a full API key from console.anthropic.com (not a Claude.ai session or subscription token).",
      );
    }
    return new ApiError(
      "provider_unavailable",
      "Anthropic rejected this request. Try a shorter message or a different model.",
    );
  }

  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    classify("APIConnectionTimeoutError");
    return new ApiError(
      "provider_unavailable",
      "Could not reach Anthropic. Please try again.",
    );
  }

  if (error instanceof Anthropic.APIConnectionError) {
    classify("APIConnectionError");
    return new ApiError(
      "provider_unavailable",
      "Could not reach Anthropic. Please try again.",
    );
  }

  if (error instanceof Anthropic.APIError) {
    classify("APIError(generic)");
    return new ApiError(
      "provider_unavailable",
      "Anthropic returned an error. Please try again.",
    );
  }

  // `.name` is a fixed string on the prototype (e.g. "TypeError", "AbortError"),
  // not a reflected class name, so it is stable under minification too. Never
  // `.message` here: unlike the branches above, this is not an Anthropic
  // `APIError` with a structured, request-shaped body — it is an arbitrary
  // thrown value, and an arbitrary message is exactly what the leakage rule
  // at the top of this function exists to keep out of a log.
  classify(error instanceof Error ? `non-SDK ${error.name}` : "non-Error throw");
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
    await clientFor(apiKey, VALIDATE_TIMEOUT_MS).models.list({ limit: 1 });
  } catch (error) {
    throw toApiError(error, "validate");
  }
}

/**
 * Haiku 4.5 rejects `thinking: { type: "adaptive" }` outright (400) — it only
 * takes the older `budget_tokens` form or no `thinking` param. Returning
 * `undefined` for it means the request omits `thinking` entirely, which is a
 * supported no-thinking call rather than an error.
 */
export function buildThinkingParam(
  supportsAdaptiveThinking: boolean,
): { type: "adaptive"; display: "summarized" } | undefined {
  return supportsAdaptiveThinking
    ? { type: "adaptive", display: "summarized" }
    : undefined;
}

/**
 * Streams a completion, yielding our own transport-neutral events rather than
 * the SDK's. The route turns these into SSE frames — nothing provider-shaped
 * reaches the client, so swapping or adding a provider does not change the
 * client contract.
 *
 * Adaptive thinking with `display: "summarized"` is on deliberately, for every
 * model that accepts it. On Opus 5 thinking runs by default, and with the
 * default omitted display the user would watch a long pause with nothing on
 * screen. Surfacing the summary gives the canvas something real to render
 * while the model works.
 */
export async function* streamChat(options: {
  apiKey: string;
  model: string;
  supportsAdaptiveThinking: boolean;
  system?: string;
  messages: ChatMessage[];
  signal: AbortSignal;
}): AsyncGenerator<ChatStreamEvent> {
  const thinking = buildThinkingParam(options.supportsAdaptiveThinking);
  const stream = clientFor(options.apiKey, CHAT_TIMEOUT_MS).messages.stream(
    {
      model: options.model,
      max_tokens: MAX_TOKENS,
      ...(thinking ? { thinking } : {}),
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

    const apiError = toApiError(error, "chat");
    yield { type: "error", code: apiError.code, message: apiError.message };
  }
}
