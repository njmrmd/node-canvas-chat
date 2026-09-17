import { query, queryOne } from "@/lib/db";
import type { ConversationGraph } from "@/lib/conversation/graph";

/**
 * Server-side persistence for the one canvas an account has (§2.5, §10).
 *
 * Every read and write here is scoped by `user_id` in the SQL itself, the same
 * discipline `keys.ts` uses — ownership is a predicate in the statement, not a
 * check performed after the fetch.
 *
 * The graph is trusted structurally but not semantically: a row is only ever
 * written by `saveCanvas`, whose caller is the canvas app posting its own
 * in-memory state, so there is no cross-account content to validate against.
 * What *is* checked is shape, because a value that fails `JSON.parse` or comes
 * back missing `nodesById`/`nodeIds` must not crash the canvas on load — it is
 * treated as an empty canvas instead (§4.11 `canvas.loading` still has to
 * resolve to something).
 */

export type Viewport = { x: number; y: number; zoom: number };

export type CanvasState = {
  graph: ConversationGraph;
  viewport: Viewport;
  selectedNodeId: string | null;
  hasBranchedOnce: boolean;
};

export function emptyCanvasState(): CanvasState {
  return {
    graph: { nodesById: {}, nodeIds: [] },
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedNodeId: null,
    hasBranchedOnce: false,
  };
}

function isGraphShaped(value: unknown): value is ConversationGraph {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.nodesById === "object" &&
    candidate.nodesById !== null &&
    Array.isArray(candidate.nodeIds)
  );
}

function isViewportShaped(value: unknown): value is Viewport {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.zoom === "number"
  );
}

export async function getCanvas(userId: string): Promise<CanvasState> {
  const row = await queryOne<{
    graph: unknown;
    viewport: unknown;
    selected_node_id: string | null;
    has_branched_once: boolean;
  }>(
    `select graph, viewport, selected_node_id, has_branched_once
       from canvases
      where user_id = $1`,
    [userId],
  );

  if (!row) return emptyCanvasState();

  const fallback = emptyCanvasState();
  return {
    graph: isGraphShaped(row.graph) ? row.graph : fallback.graph,
    viewport: isViewportShaped(row.viewport) ? row.viewport : fallback.viewport,
    selectedNodeId: row.selected_node_id,
    hasBranchedOnce: row.has_branched_once,
  };
}

/**
 * Whole-document upsert. Called from a debounced client write (§2.5: position
 * on pointerup debounced 500ms, viewport debounced 1000ms), so this can be
 * called often; there is exactly one row per account for it to touch.
 */
export async function saveCanvas(
  userId: string,
  state: CanvasState,
): Promise<void> {
  await query(
    `insert into canvases (user_id, graph, viewport, selected_node_id, has_branched_once)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update
            set graph             = excluded.graph,
                viewport          = excluded.viewport,
                selected_node_id  = excluded.selected_node_id,
                has_branched_once = excluded.has_branched_once,
                updated_at        = now()`,
    [
      userId,
      JSON.stringify(state.graph),
      JSON.stringify(state.viewport),
      state.selectedNodeId,
      state.hasBranchedOnce,
    ],
  );
}
