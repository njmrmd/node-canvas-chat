import { ApiCallError } from "@/lib/api-client";
import { COPY } from "@/lib/canvas/copy";
import type { NodeError } from "@/lib/conversation/graph";

/**
 * §4.6's `errorCode` vocabulary, and the canonical line that goes with each —
 * never the server's own message, per §4.6 ("never a raw provider error").
 *
 * This mapping is honest about a real gap rather than papering over it: §4.6
 * specifies six codes (`auth`, `timeout`, `network`, `content_filter`,
 * `context_too_long`, `unknown`), but the server's actual `ErrorCode` union
 * (`src/lib/http.ts`) does not distinguish most of them —
 * `src/lib/providers/anthropic.ts` folds a provider timeout, a bad request, a
 * safety refusal and a connection failure into one `provider_unavailable`.
 * There is no field on the wire that tells `timeout` from `content_filter`
 * from a dropped connection.
 *
 * So only the codes this client can actually *know* are asserted:
 * - `auth` — the server said `invalid_api_key` / `no_key_configured`.
 * - `network` — *this* client's own fetch failed before a response arrived
 *   (matched on the literal message `stream.ts` throws for that case, which
 *   is our own string, not the server's).
 * - `context_too_long` — matched on `checkBranchSize`'s own message, since
 *   that check runs client-side before a request is sent and is the only
 *   place this code can be produced honestly.
 * - everything else, including every `provider_unavailable`, becomes
 *   `unknown` rather than a guess dressed as a fact.
 *
 * Flagged to Platform Engineer: distinguishing `timeout` / `content_filter` /
 * a real `network` failure at the provider hop needs the server to emit
 * separate codes for them — §4.6 was written assuming it already could.
 */
export type SpecErrorCode =
  | "auth"
  | "timeout"
  | "network"
  | "content_filter"
  | "context_too_long"
  | "unknown";

/** The exact literal `stream.ts` throws for a fetch that never got a response. */
const NETWORK_MESSAGE =
  "Could not reach the server. Check your connection and try again.";

/**
 * §4.3: no first token within 60000ms. This one *is* a real client-observed
 * timeout — the canvas controller aborts the stream itself and fails the node
 * with this sentinel, rather than inferring "timeout" from an ambiguous
 * server code.
 */
export const CLIENT_TIMEOUT_MESSAGE = "No response arrived within the time limit.";

/**
 * §4.6 wants the header `<StatusChip>` to carry "the failure category" while
 * the body carries the full plain-language line — two different lengths of
 * the same fact. §9 only names the body sentence, so these short labels are
 * placeholder text pending Design Engineer sign-off, the same treatment as
 * `LOCAL_PLACEHOLDERS` in `copy.ts`. Rendering the full sentence in both
 * places (the previous behaviour) collided with the header's fixed height.
 */
const CATEGORY_LABEL: Record<SpecErrorCode, string> = {
  auth: "Auth error",
  timeout: "Timed out",
  network: "Network error",
  content_filter: "Declined",
  context_too_long: "Too long",
  unknown: "Error",
};

export function presentError(
  error: NodeError,
): { errorCode: SpecErrorCode; category: string; message: string } {
  const withCategory = (errorCode: SpecErrorCode, message: string) => ({
    errorCode,
    category: CATEGORY_LABEL[errorCode],
    message,
  });

  if (error.code === "invalid_api_key" || error.code === "no_key_configured") {
    return withCategory("auth", COPY["node.error.auth"]);
  }
  if (error.message === NETWORK_MESSAGE) {
    return withCategory("network", COPY["node.error.network"]);
  }
  if (error.message === CLIENT_TIMEOUT_MESSAGE) {
    return withCategory("timeout", COPY["node.error.timeout"]);
  }
  if (error.code === "invalid_request" && /too long/i.test(error.message)) {
    return withCategory("context_too_long", COPY["node.error.context_too_long"]);
  }
  return withCategory("unknown", COPY["node.error.unknown"]);
}

/** Converts a caught error into the shape `failNode` stores on the node. */
export function toNodeError(error: unknown): NodeError {
  if (error instanceof ApiCallError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : "Unknown error",
  };
}
