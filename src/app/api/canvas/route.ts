import { emptyCanvasState, getCanvas, saveCanvas } from "@/lib/canvas-store";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { requireSessionUser } from "@/lib/auth/session";
import { json, noContent, readJsonBody, withRoute } from "@/lib/http";
import { POLICIES, enforce, userSubject } from "@/lib/rate-limit";
import type { ConversationGraph } from "@/lib/conversation/graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isGraphShaped(value: unknown): value is ConversationGraph {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.nodesById === "object" &&
    candidate.nodesById !== null &&
    Array.isArray(candidate.nodeIds)
  );
}

function isViewportShaped(
  value: unknown,
): value is { x: number; y: number; zoom: number } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.zoom === "number"
  );
}

/** GET /api/canvas — the whole persisted canvas for the signed-in account. */
export const GET = withRoute("canvas.get", async () => {
  const user = await requireSessionUser();
  const state = await getCanvas(user.id);
  return json(state);
});

/**
 * PUT /api/canvas — whole-document replace, from the client's in-memory state.
 *
 * No partial updates: the client always holds the authoritative graph (it is
 * what streaming writes into), so there is nothing to merge server-side. A
 * write that races another tab last-writer-wins, which is an accepted gap for
 * a single-user MVP (§10: no collaboration).
 */
export const PUT = withRoute("canvas.put", async (request: Request) => {
  assertSameOrigin(request);
  const user = await requireSessionUser();
  await enforce(POLICIES.canvasWrite, userSubject(user.id));

  const body = await readJsonBody(request);
  const fallback = emptyCanvasState();

  const graph = isGraphShaped(body.graph) ? body.graph : fallback.graph;
  const viewport = isViewportShaped(body.viewport)
    ? body.viewport
    : fallback.viewport;
  const selectedNodeId =
    typeof body.selectedNodeId === "string" ? body.selectedNodeId : null;
  const hasBranchedOnce = body.hasBranchedOnce === true;

  await saveCanvas(user.id, { graph, viewport, selectedNodeId, hasBranchedOnce });
  return noContent();
});
