import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ApiCallError } from "@/lib/api-client";
import type { ChatStreamEvent } from "@/lib/providers/types";
import { streamChat } from "./stream";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** An SSE response whose body arrives in exactly these chunks. */
function sseResponse(
  chunks: string[],
  headers: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}

function frame(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function stubFetch(response: Response | (() => Promise<Response>)): void {
  globalThis.fetch = (async () =>
    typeof response === "function" ? response() : response) as typeof fetch;
}

const REQUEST = {
  provider: "anthropic",
  model: "claude-opus-5",
  messages: [{ role: "user" as const, content: "hi" }],
};

async function collect(response: Response, signal?: AbortSignal) {
  const events: ChatStreamEvent[] = [];
  stubFetch(response);
  const result = await streamChat({
    ...REQUEST,
    signal,
    onEvent: (event) => events.push(event),
  });
  return { events, result };
}

const DONE: ChatStreamEvent = {
  type: "done",
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 2 },
};

describe("streamChat", () => {
  it("delivers frames in order", async () => {
    const { events, result } = await collect(
      sseResponse([
        frame({ type: "thinking", text: "hmm" }),
        frame({ type: "text", text: "an " }),
        frame({ type: "text", text: "answer" }),
        frame(DONE),
      ]),
    );

    assert.equal(result.completed, true);
    assert.deepEqual(
      events.map((event) => event.type),
      ["thinking", "text", "text", "done"],
    );
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    // The realistic failure: a network chunk ends mid-JSON.
    const whole = frame({ type: "text", text: "hello world" }) + frame(DONE);
    const cut = 12;

    const { events } = await collect(
      sseResponse([whole.slice(0, cut), whole.slice(cut)]),
    );

    assert.deepEqual(events[0], { type: "text", text: "hello world" });
    assert.equal(events[1].type, "done");
  });

  it("handles several frames arriving in one chunk", async () => {
    const { events } = await collect(
      sseResponse([
        frame({ type: "text", text: "a" }) +
          frame({ type: "text", text: "b" }) +
          frame(DONE),
      ]),
    );

    assert.equal(events.length, 3);
  });

  it("surfaces the rate limit before any frame", async () => {
    const seen: string[] = [];
    stubFetch(
      sseResponse([frame({ type: "text", text: "a" }), frame(DONE)], {
        "RateLimit-Limit": "60",
        "RateLimit-Remaining": "41",
        "RateLimit-Reset": "2280",
      }),
    );

    await streamChat({
      ...REQUEST,
      onRateLimit: (snapshot) => {
        seen.push(`limit:${snapshot.limit}/${snapshot.remaining}/${snapshot.resetSeconds}`);
      },
      onEvent: (event) => seen.push(event.type),
    });

    assert.deepEqual(seen, ["limit:60/41/2280", "text", "done"]);
  });

  it("rejects with the envelope when it fails before the stream opens", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          error: { code: "no_key_configured", message: "Connect a key first." },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    await assert.rejects(
      streamChat({ ...REQUEST, onEvent: () => {} }),
      (error: unknown) => {
        assert.ok(error instanceof ApiCallError);
        assert.equal(error.code, "no_key_configured");
        assert.equal(error.message, "Connect a key first.");
        return true;
      },
    );
  });

  it("carries Retry-After through a pre-stream rate limit", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          error: { code: "rate_limited", message: "Try again in 38 minutes." },
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "2280" },
        },
      ),
    );

    await assert.rejects(
      streamChat({ ...REQUEST, onEvent: () => {} }),
      (error: unknown) => {
        assert.ok(error instanceof ApiCallError);
        assert.equal(error.retryAfterSeconds, 2280);
        return true;
      },
    );
  });

  it("delivers a mid-stream failure as an event, not a rejection", async () => {
    // The status was already 200, so this must not throw.
    const { events, result } = await collect(
      sseResponse([
        frame({ type: "text", text: "partial" }),
        frame({
          type: "error",
          code: "provider_unavailable",
          message: "The provider stopped responding.",
        }),
      ]),
    );

    assert.equal(result.completed, true);
    assert.equal(events[1].type, "error");
  });

  it("synthesises a terminal error when the connection drops", async () => {
    const { events } = await collect(
      sseResponse([frame({ type: "text", text: "half an ans" })]),
    );

    assert.equal(events.length, 2);
    assert.deepEqual(events[1], {
      type: "error",
      code: "internal_error",
      message: "The response stopped unexpectedly. Please try again.",
    });
  });

  it("reports an abort as not completed rather than as a failure", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();

    // Pull-based, so the first frame is actually read before the abort lands —
    // which is what happens when a stop button is pressed mid-answer.
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(output) {
        pulls += 1;
        if (pulls === 1) {
          output.enqueue(encoder.encode(frame({ type: "text", text: "partial" })));
          return;
        }
        controller.abort();
        output.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
    });

    stubFetch(new Response(body, { status: 200 }));

    const events: ChatStreamEvent[] = [];
    const result = await streamChat({
      ...REQUEST,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.completed, false);
    assert.deepEqual(events, [{ type: "text", text: "partial" }]);
  });

  it("surfaces a spurious AbortError as a legible error, not a silent stop", async () => {
    // The browser can throw an AbortError-named exception (tab throttling, the
    // browser evicting the request) with no controller of ours ever aborted.
    // That must not be read as the user pressing stop.
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw Object.assign(new Error("spurious"), { name: "AbortError" });
      },
    });

    stubFetch(new Response(body, { status: 200 }));

    const events: ChatStreamEvent[] = [];
    await assert.rejects(
      streamChat({
        ...REQUEST,
        signal: controller.signal,
        onEvent: (event) => events.push(event),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error).name, "AbortError");
        return true;
      },
    );

    assert.equal(controller.signal.aborted, false);
    assert.deepEqual(events, []);
  });

  it("ignores a malformed frame instead of tearing the stream down", async () => {
    const { events, result } = await collect(
      sseResponse([
        "data: {not json\n\n",
        ": a comment\n\n",
        frame({ type: "text", text: "fine" }),
        frame(DONE),
      ]),
    );

    assert.equal(result.completed, true);
    assert.deepEqual(
      events.map((event) => event.type),
      ["text", "done"],
    );
  });

  it("turns an unreachable server into a legible error", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    await assert.rejects(
      streamChat({ ...REQUEST, onEvent: () => {} }),
      (error: unknown) => {
        assert.ok(error instanceof ApiCallError);
        assert.equal(error.code, "internal_error");
        assert.match(error.message, /Check your connection/);
        return true;
      },
    );
  });
});
