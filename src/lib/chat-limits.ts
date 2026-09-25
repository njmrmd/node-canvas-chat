/**
 * Caps on what one chat request may carry.
 *
 * These live here rather than inside the route because both sides need them:
 * the server rejects an over-long branch, and the canvas wants to catch the
 * same thing before spending a round trip on it. Two copies that must agree is
 * a bug waiting for the day someone edits one of them — Frontend Engineer
 * flagged exactly that after re-declaring these in `conversation/graph.ts`.
 *
 * The server is still the authority. Nothing here is a substitute for the
 * checks in `api/chat/route.ts`; a client that skips them is simply refused.
 *
 * No imports: this is shared between an edge-safe client module and a Node
 * route handler, so it must stay free of anything runtime-specific.
 */

/** Messages in a single branch. */
export const MAX_MESSAGES = 100;

/** Characters in any one message. */
export const MAX_MESSAGE_CHARS = 100_000;

/** Characters across every message in the request. */
export const MAX_TOTAL_CHARS = 400_000;

/** Characters in the system prompt. */
export const MAX_SYSTEM_CHARS = 10_000;

/**
 * Bytes in the request body. Sized so the character caps above are the ones
 * that actually bind: 410k characters at up to 3 UTF-8 bytes each is ~1.2 MB,
 * plus JSON escaping and envelope. The old shared 256 KB default refused a
 * branch well before it reached `MAX_TOTAL_CHARS`.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
