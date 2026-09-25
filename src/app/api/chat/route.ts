import { assertSameOrigin } from "@/lib/auth/csrf";
import { requireSessionUser } from "@/lib/auth/session";
/**
 * Caps on what one request may carry. `input trust boundaries`: the client
 * decides the *content* of a conversation, never its size.
 *
 * Imported rather than declared, so the canvas can pre-check a branch against
 * the same numbers this route enforces — one edit changes both sides.
 */
import {
  MAX_BODY_BYTES,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_SYSTEM_CHARS,
  MAX_TOTAL_CHARS,
} from "@/lib/chat-limits";
import { ApiError, readJsonBody, withRoute } from "@/lib/http";
import { getDecryptedKey } from "@/lib/keys";
import { streamChat } from "@/lib/providers/anthropic";
import { requireModel, requireProvider } from "@/lib/providers/registry";
import { POLICIES, enforce, rateLimitHeaders, userSubject } from "@/lib/rate-limit";
import type { ChatMessage, ChatStreamEvent } from "@/lib/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Vercel Hobby allows up to 300s for a streaming function. */
export const maxDuration = 300;


function parseMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError("invalid_request", "Send at least one message.", {
      fields: { messages: "Send at least one message." },
    });
  }

  if (value.length > MAX_MESSAGES) {
    throw new ApiError(
      "invalid_request",
      `This branch is too long — it holds more than ${MAX_MESSAGES} messages.`,
    );
  }

  let total = 0;
  const messages: ChatMessage[] = [];

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      throw new ApiError("invalid_request", "A message was malformed.");
    }

    const { role, content } = entry as Record<string, unknown>;

    // An allowlist of two, not a cast. "system" is not accepted here: a
    // client that could inject a system turn could rewrite the instructions.
    if (role !== "user" && role !== "assistant") {
      throw new ApiError("invalid_request", "A message had an unknown role.");
    }

    if (typeof content !== "string" || content.trim() === "") {
      throw new ApiError("invalid_request", "A message was empty.");
    }

    if (content.length > MAX_MESSAGE_CHARS) {
      throw new ApiError("invalid_request", "One message is too long.");
    }

    total += content.length;
    if (total > MAX_TOTAL_CHARS) {
      throw new ApiError(
        "invalid_request",
        "This branch is too long to send. Start a new node from further up.",
      );
    }

    messages.push({ role, content });
  }

  // The Messages API requires the first turn to be a user turn. Catching it
  // here produces our own legible error instead of a provider 400.
  if (messages[0].role !== "user") {
    throw new ApiError(
      "invalid_request",
      "A conversation has to start with a message from you.",
    );
  }

  return messages;
}

function sseFrame(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * POST /api/chat — the only route that touches a decrypted key.
 *
 * Order matters, and it is the order below: prove who is calling, charge the
 * rate limit, resolve provider and model against the allowlist, *then* decrypt.
 * A request that fails any earlier check never causes a decrypt.
 *
 * Everything that can fail before the first byte fails as a normal JSON
 * envelope with a status code. Once the stream is open the status is already
 * 200, so a later failure arrives as an `error` event on the stream carrying
 * the same `code` vocabulary. The client handles one set of codes either way.
 */
export const POST = withRoute("chat", async (request: Request) => {
  assertSameOrigin(request);

  const user = await requireSessionUser();
  const limit = await enforce(POLICIES.chat, userSubject(user.id));

  const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
  const provider = requireProvider(body.provider);
  const model = requireModel(provider, body.model);
  const messages = parseMessages(body.messages);

  const system =
    typeof body.system === "string" && body.system.trim() !== ""
      ? body.system.slice(0, MAX_SYSTEM_CHARS)
      : undefined;

  const apiKey = await getDecryptedKey(user.id, provider.id);

  // Aborts the upstream provider request when the browser goes away, so a
  // closed tab does not keep spending the user's tokens.
  const controller = new AbortController();
  request.signal.addEventListener("abort", () => controller.abort());

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(output) {
      try {
        for await (const event of streamChat({
          apiKey,
          model: model.id,
          supportsAdaptiveThinking: model.supportsAdaptiveThinking,
          system,
          messages,
          signal: controller.signal,
        })) {
          output.enqueue(encoder.encode(sseFrame(event)));
        }
      } catch (error) {
        // The generator handles provider failures itself; this is the
        // last-resort net. Log without content, emit a generic frame.
        console.error(
          "[chat] stream failed:",
          error instanceof Error ? error.message : "unknown",
        );
        output.enqueue(
          encoder.encode(
            sseFrame({
              type: "error",
              code: "internal_error",
              message: "The response stopped unexpectedly. Please try again.",
            }),
          ),
        );
      } finally {
        output.close();
      }
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // Proxies that buffer would defeat streaming entirely.
      "X-Accel-Buffering": "no",
      ...rateLimitHeaders(limit),
    },
  });
});
