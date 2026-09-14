import type { ChatMessage } from "@/lib/providers/types";
import type { ErrorCode } from "@/lib/http";

/**
 * The conversation graph — the data model underneath the canvas.
 *
 * **A node is one exchange: a prompt and the answer to it.** Not one message.
 * The alternative (a node per message) was rejected because it doubles the
 * cards on the canvas, and because it makes "branch from here" ambiguous —
 * branching from a user node and branching from the assistant node below it
 * would mean different things for no gain the user can see.
 *
 * An edge means "the parent exchange is context for this one". The path from
 * a root down to a node is exactly what gets sent to the model for that node,
 * which is what `toMessages` produces.
 *
 * Every mutation returns a new graph and leaves the input untouched, so a
 * React `useState` holding one of these behaves correctly without a reducer
 * library. Node objects are shared by reference where they did not change, so
 * a memoised node card only re-renders when its own node did.
 */

/**
 * Caps enforced by `POST /api/chat`. Mirrored here so an over-long branch is
 * caught before a round trip rather than after one.
 *
 * These are duplicated from `src/app/api/chat/route.ts`, which does not export
 * them. They must not drift — see the note on [TES-4](/TES/issues/TES-4).
 */
export const MAX_BRANCH_MESSAGES = 100;
export const MAX_MESSAGE_CHARS = 100_000;
export const MAX_BRANCH_CHARS = 400_000;

export type NodeStatus =
  /** Created, prompt written, nothing requested yet. */
  | "draft"
  /** A request is open; `response`/`thinking` are growing. */
  | "streaming"
  /** A `done` frame arrived. */
  | "complete"
  /** The user stopped it, or the connection dropped. Partial text is kept. */
  | "interrupted"
  /** A terminal `error` frame, or a failure before the stream opened. */
  | "error";

export type NodeError = {
  code: ErrorCode;
  /** Already written for a person — safe to render verbatim. */
  message: string;
};

export type Point = { x: number; y: number };

export type ConversationNode = {
  id: string;
  /** `null` for a root. A graph may hold several roots. */
  parentId: string | null;
  prompt: string;
  /** The visible answer, appended to as `text` frames arrive. */
  response: string;
  /** Summarized reasoning. Never the answer — render it de-emphasised. */
  thinking: string;
  status: NodeStatus;
  error: NodeError | null;
  position: Point;
  usage: { inputTokens: number; outputTokens: number } | null;
  createdAt: number;
  updatedAt: number;
};

export type ConversationGraph = {
  nodesById: Readonly<Record<string, ConversationNode>>;
  /** Insertion order. Roots and children alike; the canvas derives its own. */
  nodeIds: readonly string[];
};

export function createGraph(): ConversationGraph {
  return { nodesById: {}, nodeIds: [] };
}

export function getNode(
  graph: ConversationGraph,
  nodeId: string,
): ConversationNode | null {
  return graph.nodesById[nodeId] ?? null;
}

/** Throws rather than returning null — callers that pass an unknown id are buggy. */
function requireNode(
  graph: ConversationGraph,
  nodeId: string,
): ConversationNode {
  const node = graph.nodesById[nodeId];
  if (!node) throw new Error(`No such node: ${nodeId}`);
  return node;
}

export function rootIds(graph: ConversationGraph): string[] {
  return graph.nodeIds.filter((id) => graph.nodesById[id].parentId === null);
}

export function childIds(graph: ConversationGraph, nodeId: string): string[] {
  return graph.nodeIds.filter((id) => graph.nodesById[id].parentId === nodeId);
}

export function isEmpty(graph: ConversationGraph): boolean {
  return graph.nodeIds.length === 0;
}

/**
 * Root → node, inclusive. Cycles cannot be created through this module's API,
 * but a corrupted persisted graph could carry one, so the walk is bounded and
 * throws instead of hanging the canvas.
 */
export function pathToRoot(
  graph: ConversationGraph,
  nodeId: string,
): ConversationNode[] {
  const path: ConversationNode[] = [];
  const seen = new Set<string>();

  let current: ConversationNode | null = requireNode(graph, nodeId);
  while (current) {
    if (seen.has(current.id)) {
      throw new Error(`Cycle in conversation graph at ${current.id}`);
    }
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? requireNode(graph, current.parentId) : null;
  }

  return path.reverse();
}

/** The node and everything beneath it, parents before children. */
export function descendantIds(
  graph: ConversationGraph,
  nodeId: string,
): string[] {
  const collected: string[] = [];
  const queue = [nodeId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    collected.push(id);
    queue.push(...childIds(graph, id));
  }

  return collected;
}

/**
 * Whether a new branch may hang off this node.
 *
 * A node with no answer yet cannot be a parent: its exchange would contribute
 * a user turn with no assistant turn after it, breaking the alternation the
 * chat route requires. Blocking it here is what makes `toMessages` total —
 * it can never assemble a branch the server will reject.
 *
 * An interrupted or failed node with partial text *is* branchable. The user
 * saw that text; it is real context.
 */
export function canBranchFrom(node: ConversationNode): boolean {
  return node.response.trim() !== "";
}

export type AddNodeInput = {
  parentId?: string | null;
  prompt: string;
  position: Point;
  /** Injectable so tests are deterministic. */
  id?: string;
  now?: number;
};

export function addNode(
  graph: ConversationGraph,
  input: AddNodeInput,
): { graph: ConversationGraph; node: ConversationNode } {
  const parentId = input.parentId ?? null;

  if (parentId !== null) {
    const parent = requireNode(graph, parentId);
    if (!canBranchFrom(parent)) {
      throw new Error(
        `Cannot branch from ${parentId}: it has no answer yet.`,
      );
    }
  }

  const now = input.now ?? Date.now();
  const node: ConversationNode = {
    id: input.id ?? newNodeId(),
    parentId,
    prompt: input.prompt,
    response: "",
    thinking: "",
    status: "draft",
    error: null,
    position: input.position,
    usage: null,
    createdAt: now,
    updatedAt: now,
  };

  return {
    graph: {
      nodesById: { ...graph.nodesById, [node.id]: node },
      nodeIds: [...graph.nodeIds, node.id],
    },
    node,
  };
}

/** Removes a node and every descendant — an abandoned branch goes as a unit. */
export function removeBranch(
  graph: ConversationGraph,
  nodeId: string,
): ConversationGraph {
  const doomed = new Set(descendantIds(graph, nodeId));
  const nodesById: Record<string, ConversationNode> = {};

  for (const id of graph.nodeIds) {
    if (!doomed.has(id)) nodesById[id] = graph.nodesById[id];
  }

  return {
    nodesById,
    nodeIds: graph.nodeIds.filter((id) => !doomed.has(id)),
  };
}

function patchNode(
  graph: ConversationGraph,
  nodeId: string,
  patch: Partial<ConversationNode>,
  now?: number,
): ConversationGraph {
  const node = requireNode(graph, nodeId);
  const next: ConversationNode = {
    ...node,
    ...patch,
    updatedAt: now ?? Date.now(),
  };

  return {
    nodesById: { ...graph.nodesById, [nodeId]: next },
    nodeIds: graph.nodeIds,
  };
}

export function moveNode(
  graph: ConversationGraph,
  nodeId: string,
  position: Point,
  now?: number,
): ConversationGraph {
  return patchNode(graph, nodeId, { position }, now);
}

export function setPrompt(
  graph: ConversationGraph,
  nodeId: string,
  prompt: string,
  now?: number,
): ConversationGraph {
  return patchNode(graph, nodeId, { prompt }, now);
}

/**
 * Marks a node as awaiting a response. Clears any previous answer so that
 * retrying a failed node does not append to the text that failed.
 */
export function startStreaming(
  graph: ConversationGraph,
  nodeId: string,
  now?: number,
): ConversationGraph {
  return patchNode(
    graph,
    nodeId,
    { status: "streaming", response: "", thinking: "", error: null, usage: null },
    now,
  );
}

export function appendText(
  graph: ConversationGraph,
  nodeId: string,
  text: string,
  now?: number,
): ConversationGraph {
  const node = requireNode(graph, nodeId);
  return patchNode(graph, nodeId, { response: node.response + text }, now);
}

export function appendThinking(
  graph: ConversationGraph,
  nodeId: string,
  text: string,
  now?: number,
): ConversationGraph {
  const node = requireNode(graph, nodeId);
  return patchNode(graph, nodeId, { thinking: node.thinking + text }, now);
}

export function completeNode(
  graph: ConversationGraph,
  nodeId: string,
  usage: { inputTokens: number; outputTokens: number } | null,
  now?: number,
): ConversationGraph {
  return patchNode(graph, nodeId, { status: "complete", usage }, now);
}

export function failNode(
  graph: ConversationGraph,
  nodeId: string,
  error: NodeError,
  now?: number,
): ConversationGraph {
  return patchNode(graph, nodeId, { status: "error", error }, now);
}

/**
 * Stopped deliberately, or the connection dropped. Keeps whatever text
 * arrived: a half-written answer is still worth reading, and discarding it
 * would make cancelling feel like losing work.
 */
export function interruptNode(
  graph: ConversationGraph,
  nodeId: string,
  now?: number,
): ConversationGraph {
  return patchNode(graph, nodeId, { status: "interrupted" }, now);
}

/**
 * Any node left mid-stream when the tab went away. A `streaming` status can
 * never be resumed across a reload — the request is gone — so a rehydrated
 * graph must reconcile them or the canvas shows spinners that never stop.
 */
export function settleOrphanedStreams(
  graph: ConversationGraph,
  now?: number,
): ConversationGraph {
  let next = graph;

  for (const id of graph.nodeIds) {
    if (graph.nodesById[id].status !== "streaming") continue;
    next = patchNode(next, id, { status: "interrupted" }, now);
  }

  return next;
}

export type BranchTooLong = {
  reason: "messages" | "chars" | "message_chars";
  /** Written for a person, matching the server's phrasing for the same cap. */
  message: string;
};

/**
 * The request body for answering `nodeId`: every ancestor exchange in order,
 * then this node's prompt.
 *
 * The node's own `response` is deliberately excluded — it is what we are
 * asking for. Re-running a node that already has an answer therefore replaces
 * it rather than continuing it.
 */
export function toMessages(
  graph: ConversationGraph,
  nodeId: string,
): ChatMessage[] {
  const path = pathToRoot(graph, nodeId);
  const messages: ChatMessage[] = [];

  for (const node of path) {
    messages.push({ role: "user", content: node.prompt });
    // Every node on the path except the target has an answer, because
    // `addNode` refuses to hang a child off an unanswered node.
    if (node.id !== nodeId) {
      messages.push({ role: "assistant", content: node.response });
    }
  }

  return messages;
}

/**
 * Checks a branch against the server's caps so the canvas can say "this
 * branch is too long, start a new node further up" before spending a request.
 * Returns `null` when the branch is sendable.
 */
export function checkBranchSize(messages: ChatMessage[]): BranchTooLong | null {
  if (messages.length > MAX_BRANCH_MESSAGES) {
    return {
      reason: "messages",
      message: `This branch is too long — it holds more than ${MAX_BRANCH_MESSAGES} messages. Start a new node from further up.`,
    };
  }

  let total = 0;
  for (const message of messages) {
    if (message.content.length > MAX_MESSAGE_CHARS) {
      return { reason: "message_chars", message: "One message is too long to send." };
    }
    total += message.content.length;
  }

  if (total > MAX_BRANCH_CHARS) {
    return {
      reason: "chars",
      message:
        "This branch is too long to send. Start a new node from further up.",
    };
  }

  return null;
}

export function newNodeId(): string {
  // `randomUUID` needs a secure context; every browser we target in one, but
  // a plain-http preview would not be, and an id collision is worse than a
  // slightly weaker id.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `n_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
