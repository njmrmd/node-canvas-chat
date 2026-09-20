import {
  childIds,
  placeNode,
  rootIds,
  type ConversationGraph,
  type Point,
} from "@/lib/conversation/graph";

/** Real measured card heights, keyed by node id. A node with no entry (not
 * yet measured, e.g. the split second before its first paint) falls back to
 * `NODE_HEIGHT`. Kept out of the graph model so it stays serialisable — see
 * the height-measurement plumbing in `canvas-app.tsx`. */
export type NodeHeights = ReadonlyMap<string, number>;

const NO_HEIGHTS: NodeHeights = new Map();

/**
 * §2.4's auto-layout: auto-place on create (cheap, no reflow) plus a full
 * Tidy pass (§2.4 "Tidy" button / `L`) that re-lays-out every `auto` node as a
 * top-down tidy tree.
 *
 * The Tidy pass below is a simplified Reingold–Tilford: each subtree's width
 * is the sum of its children's subtree widths (plus gaps), a node centers
 * over its own children, and a `manual` node is a fixed anchor — its subtree
 * lays out beneath its real position and it does not push `auto` siblings.
 * It is not the full contour-tracking algorithm (no handling for a manual
 * node's subtree overlapping an unrelated auto subtree beside it) — flagged
 * as a follow-up rather than shipped as silently exact.
 */

export const NODE_WIDTH_DESKTOP = 320;
export const NODE_WIDTH_MOBILE = 288;
/** Nominal card height for layout math. Real cards vary 96–420px; §2.4 gives
 * no placement rule for that, so this is the smallest sensible constant. */
const NODE_HEIGHT = 160;
export const V_GAP = 72;
export const H_GAP = 48;

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function heightOf(heights: NodeHeights, nodeId: string): number {
  return heights.get(nodeId) ?? NODE_HEIGHT;
}

/** Depth of every node, root(s) at depth 0, via a BFS from the roots. */
function depthsByNode(graph: ConversationGraph): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: Array<[string, number]> = rootIds(graph).map((id) => [id, 0]);
  while (queue.length > 0) {
    const [id, depth] = queue.shift()!;
    depths.set(id, depth);
    for (const childId of childIds(graph, id)) queue.push([childId, depth + 1]);
  }
  return depths;
}

/**
 * The y each depth's row starts at: a running sum of the tallest measured
 * card at every shallower depth, plus one `V_GAP` per row. Replaces the flat
 * `depth * (NODE_HEIGHT + V_GAP)` pitch, which overlapped any row whose real
 * cards were taller than 232px.
 */
function rowOffsets(graph: ConversationGraph, heights: NodeHeights): number[] {
  const depths = depthsByNode(graph);
  const maxHeightByDepth: number[] = [];
  for (const [nodeId, depth] of depths) {
    const height = heightOf(heights, nodeId);
    maxHeightByDepth[depth] = Math.max(maxHeightByDepth[depth] ?? 0, height);
  }

  const offsets: number[] = [0];
  for (let depth = 1; depth <= maxHeightByDepth.length; depth++) {
    offsets[depth] = offsets[depth - 1] + (maxHeightByDepth[depth - 1] ?? NODE_HEIGHT) + V_GAP;
  }
  return offsets;
}

/**
 * §2.4 "Auto-place on create": directly below the parent, shifted right by
 * `(width + gap) × siblingIndex`; if that overlaps an existing card, shift
 * right by another `width + gap` until it does not.
 */
export function autoPlaceOnCreate(
  graph: ConversationGraph,
  parentId: string | null,
  width: number = NODE_WIDTH_DESKTOP,
  heights: NodeHeights = NO_HEIGHTS,
): Point {
  if (parentId === null) {
    // A root with no parent: place clear of every existing root.
    const existing = rootIds(graph).map((id) => graph.nodesById[id].position);
    const maxX = existing.reduce((max, p) => Math.max(max, p.x), -Infinity);
    return { x: Number.isFinite(maxX) ? maxX + width + H_GAP : 0, y: 0 };
  }

  const parent = graph.nodesById[parentId];
  const siblingIndex = childIds(graph, parentId).length;
  let x = parent.position.x + (width + H_GAP) * siblingIndex;
  const y = parent.position.y + heightOf(heights, parentId) + V_GAP;

  // Includes the parent: a parent taller than the nominal `NODE_HEIGHT` can
  // reach down into a naively-offset child's rect, and only the parent's real
  // height (above) rules that out — the overlap loop must still be able to
  // see it.
  const occupied = graph.nodeIds.map((id) => ({
    position: graph.nodesById[id].position,
    height: heightOf(heights, id),
  }));

  const candidate = () => ({ x, y, width, height: NODE_HEIGHT });
  while (
    occupied.some((o) =>
      rectsOverlap(candidate(), { x: o.position.x, y: o.position.y, width, height: o.height }),
    )
  ) {
    x += width + H_GAP;
  }

  return { x, y };
}

type TidyResult = { position: Point; subtreeWidth: number };

/**
 * Lays out one subtree, post-order, and returns its width in canvas units so
 * the caller can center a parent over it. `manual` nodes (and everything
 * beneath them) are left untouched — they are still visited so their
 * descendants know their width for sibling spacing, but their own position and
 * their children's positions are not overwritten.
 */
function layoutSubtree(
  graph: ConversationGraph,
  nodeId: string,
  depth: number,
  width: number,
  offsets: number[],
  writes: Map<string, Point>,
): TidyResult {
  const node = graph.nodesById[nodeId];
  const children = childIds(graph, nodeId).sort(
    (a, b) => graph.nodesById[a].createdAt - graph.nodesById[b].createdAt,
  );

  if (children.length === 0) {
    const position =
      node.positionMode === "manual"
        ? node.position
        : { x: 0, y: offsets[depth] };
    if (node.positionMode !== "manual") writes.set(nodeId, position);
    return { position, subtreeWidth: width };
  }

  let cursor = 0;
  const childResults: TidyResult[] = [];
  for (const childId of children) {
    const result = layoutSubtree(graph, childId, depth + 1, width, offsets, writes);
    const childNode = graph.nodesById[childId];
    // Each child comes back laid out in its own local frame starting at
    // x = 0 — shift its whole (already-written) subtree over to where it
    // actually belongs next to its siblings before advancing the cursor.
    // A manual child is a fixed anchor (like a manual root in `tidyLayout`)
    // and is left at its real position; its subtree width still reserves
    // room so auto siblings don't land on top of it.
    const shift = cursor - result.position.x;
    if (childNode.positionMode !== "manual") {
      shiftSubtreeWrites(graph, childId, shift, writes);
    }
    const shiftedX = childNode.positionMode !== "manual" ? cursor : result.position.x;
    childResults.push({ position: { x: shiftedX, y: result.position.y }, subtreeWidth: result.subtreeWidth });
    cursor += result.subtreeWidth + H_GAP;
  }
  const subtreeWidth = Math.max(width, cursor - H_GAP);

  // Center children under this node's eventual x, then shift the whole group
  // so it starts at x = 0 for this call's local frame; the caller offsets it.
  const firstChildX = childResults[0].position.x;
  const lastChild = childResults[childResults.length - 1];
  const span = lastChild.position.x + width - firstChildX;
  const centerX = firstChildX + span / 2 - width / 2;

  const position =
    node.positionMode === "manual"
      ? node.position
      : { x: centerX, y: offsets[depth] };
  if (node.positionMode !== "manual") writes.set(nodeId, position);

  return { position, subtreeWidth };
}

/**
 * Re-runs auto-layout over the whole graph and returns the updated graph.
 * Every node keeps its `positionMode` — Tidy does not convert manual nodes to
 * auto; §2.4's "resetting every node to auto" happens via `resetAllToAuto`
 * first, which callers (the `Tidy` action) compose with this.
 */
export function tidyLayout(
  graph: ConversationGraph,
  width: number = NODE_WIDTH_DESKTOP,
  heights: NodeHeights = NO_HEIGHTS,
): ConversationGraph {
  const writes = new Map<string, Point>();
  const offsets = rowOffsets(graph, heights);
  const roots = rootIds(graph).sort(
    (a, b) => graph.nodesById[a].createdAt - graph.nodesById[b].createdAt,
  );

  let cursor = 0;
  for (const rootId of roots) {
    const result = layoutSubtree(graph, rootId, 0, width, offsets, writes);
    // Shift this root's whole subtree so roots never overlap horizontally.
    const shift = cursor - result.position.x;
    if (graph.nodesById[rootId].positionMode !== "manual") {
      shiftSubtreeWrites(graph, rootId, shift, writes);
    }
    cursor += result.subtreeWidth + H_GAP;
  }

  let next = graph;
  for (const [nodeId, position] of writes) {
    next = placeNode(next, nodeId, position);
  }
  return next;
}

function shiftSubtreeWrites(
  graph: ConversationGraph,
  nodeId: string,
  shift: number,
  writes: Map<string, Point>,
): void {
  const current = writes.get(nodeId);
  if (current) writes.set(nodeId, { x: current.x + shift, y: current.y });
  for (const childId of childIds(graph, nodeId)) {
    shiftSubtreeWrites(graph, childId, shift, writes);
  }
}

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** Bounding box of every node's card, for zoom-to-fit. */
export function graphBounds(
  graph: ConversationGraph,
  width: number = NODE_WIDTH_DESKTOP,
): Bounds | null {
  if (graph.nodeIds.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const id of graph.nodeIds) {
    const { x, y } = graph.nodesById[id].position;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + NODE_HEIGHT);
  }

  return { minX, minY, maxX, maxY };
}
