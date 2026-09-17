import {
  childIds,
  placeNode,
  rootIds,
  type ConversationGraph,
  type Point,
} from "@/lib/conversation/graph";

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

/**
 * §2.4 "Auto-place on create": directly below the parent, shifted right by
 * `(width + gap) × siblingIndex`; if that overlaps an existing card, shift
 * right by another `width + gap` until it does not.
 */
export function autoPlaceOnCreate(
  graph: ConversationGraph,
  parentId: string | null,
  width: number = NODE_WIDTH_DESKTOP,
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
  const y = parent.position.y + NODE_HEIGHT + V_GAP;

  const occupied = graph.nodeIds
    .filter((id) => id !== parentId)
    .map((id) => graph.nodesById[id].position);

  const candidate = () => ({ x, y, width, height: NODE_HEIGHT });
  while (
    occupied.some((p) =>
      rectsOverlap(candidate(), { x: p.x, y: p.y, width, height: NODE_HEIGHT }),
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
        : { x: 0, y: depth * (NODE_HEIGHT + V_GAP) };
    if (node.positionMode !== "manual") writes.set(nodeId, position);
    return { position, subtreeWidth: width };
  }

  let cursor = 0;
  const childResults: TidyResult[] = [];
  for (const childId of children) {
    const result = layoutSubtree(graph, childId, depth + 1, width, writes);
    childResults.push(result);
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
      : { x: centerX, y: depth * (NODE_HEIGHT + V_GAP) };
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
): ConversationGraph {
  const writes = new Map<string, Point>();
  const roots = rootIds(graph).sort(
    (a, b) => graph.nodesById[a].createdAt - graph.nodesById[b].createdAt,
  );

  let cursor = 0;
  for (const rootId of roots) {
    const result = layoutSubtree(graph, rootId, 0, width, writes);
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
