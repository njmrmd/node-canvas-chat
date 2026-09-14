import type { ErrorCode } from "@/lib/http";

/**
 * The transport-neutral shapes that sit between a provider and the client.
 *
 * The client never sees a provider's own event names or JSON. That is both a
 * contract decision (adding a provider must not change the client) and a
 * safety one (nothing provider-shaped can leak through by accident).
 */

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatStreamEvent =
  /** An increment of the visible answer. */
  | { type: "text"; text: string }
  /** An increment of the model's summarized reasoning, when it produces any. */
  | { type: "thinking"; text: string }
  /** Terminal success. */
  | {
      type: "done";
      stopReason: string;
      usage: { inputTokens: number; outputTokens: number };
    }
  /** Terminal failure, mid-stream. Carries the same codes as the JSON API. */
  | { type: "error"; code: ErrorCode; message: string };
