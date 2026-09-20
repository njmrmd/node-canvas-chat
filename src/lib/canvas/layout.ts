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

/** TES-90: real per-node card widths, the same idea as `NodeHeights` but for
 * the width a card has been manually resized to. A node with no entry (never
 * resized) falls back to the caller's default (viewport) width. */
export type NodeWidths = ReadonlyMap<string, number>;

const NO_HEIGHTS: NodeHeights = new Map();
const NO_WIDTHS: NodeWidths = new Map();

/** TES-90: sensible min/max for a manual resize — small enough that a card
 * can't be dragged into unreadable uselessness, large enough that "read a
 * long answer comfortably" is actually possible. */
export const NODE_WIDTH_MIN = 240;
export const NODE_WIDTH_MAX = 640;
export const NODE_HEIGHT_MIN = 120;
export const NODE_HEIGHT_MAX = 900;

/** Builds a `NodeWidths` map straight from the graph's own per-node `size` —
 * unlike height, width is never content-driven, so it never needs to be
 * measured off the DOM; the graph already knows it. */
export function nodeWidthsFrom(
  graph: ConversationGraph,
  defaultWidth: number = NODE_WIDTH_DESKTOP,
): NodeWidths {
  const widths = new Map<string, number>();
  for (const id of graph.nodeIds) {
    widths.set(id, graph.nodesById[id].size?.width ?? defaultWidth);
  }
  return widths;
}

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

/** TES-101: "2x bigger" taken literally (640/576) either pins every card at
 * `NODE_WIDTH_MAX` with no manual-resize headroom left, or doesn't fit a
 * 390px phone at all. The actual complaint — long replies need squinting —
 * is an area problem, and column width past ~75 characters gets harder to
 * read, not easier, so width alone is the wrong lever. Desktop gets a
 * moderate bump (content width ~53–59 characters/line, mid-range instead of
 * the previous ~36–41); mobile gets a smaller, independent bump sized to
 * still leave real margin on a 390px viewport rather than inheriting
 * whatever a doubling clamp would produce. The rest of the "2x" is carried
 * by a taller default auto-size ceiling (`node-card.tsx`), since that's
 * what actually shows more of a long reply without scrolling. */
export const NODE_WIDTH_DESKTOP = 460;
export const NODE_WIDTH_MOBILE = 344;
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

function widthOf(widths: NodeWidths, nodeId: string, defaultWidth: number): number {
  return widths.get(nodeId) ?? defaultWidth;
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
  widths: NodeWidths = NO_WIDTHS,
): Point {
  if (parentId === null) {
    // A root with no parent: place clear of every existing root, using each
    // root's own real width rather than assuming the default.
    const existingRoots = rootIds(graph);
    const maxX = existingRoots.reduce(
      (max, id) => Math.max(max, graph.nodesById[id].position.x + widthOf(widths, id, width)),
      -Infinity,
    );
    return { x: Number.isFinite(maxX) ? maxX + H_GAP : 0, y: 0 };
  }

  const parent = graph.nodesById[parentId];
  const siblingIndex = childIds(graph, parentId).length;
  let x = parent.position.x + (widthOf(widths, parentId, width) + H_GAP) * siblingIndex;
  const y = parent.position.y + heightOf(heights, parentId) + V_GAP;

  // Includes the parent: a parent taller or wider than the nominal defaults
  // can reach into a naively-offset child's rect, and only the parent's real
  // height/width (above and below) rules that out — the overlap loop must
  // still be able to see it.
  const occupied = graph.nodeIds.map((id) => ({
    position: graph.nodesById[id].position,
    height: heightOf(heights, id),
    width: widthOf(widths, id, width),
  }));

  const candidate = () => ({ x, y, width, height: NODE_HEIGHT });
  while (
    occupied.some((o) =>
      rectsOverlap(candidate(), { x: o.position.x, y: o.position.y, width: o.width, height: o.height }),
    )
  ) {
    x += width + H_GAP;
  }

  return { x, y };
}

/**
 * TES-103 item 2: centers the very first node in the visible content area
 * rather than leaving it at `autoPlaceOnCreate`'s `{x: 0, y: 0}` default,
 * which has no relationship to what's actually on screen. `visibleCenter` is
 * a canvas-space point — the caller converts its own screen-space visible
 * rect (the same one auto-follow already computes) via `screenToCanvas`
 * before calling this, so this function stays free of viewport concerns.
 */
export function centeredRootPosition(
  visibleCenter: Point,
  width: number = NODE_WIDTH_DESKTOP,
  height: number = NODE_HEIGHT,
): Point {
  return { x: visibleCenter.x - width / 2, y: visibleCenter.y - height / 2 };
}

/**
 * TES-103: the mindmap invariant — "siblings of one parent sit at the same
 * `y`, distributed evenly across that row, with the parent centered over
 * them" — applied as the *default* on every new child, not just on an
 * explicit Tidy. `autoPlaceOnCreate` above only ever finds the new card a
 * clear spot; it never moves what already exists, so a second child landed
 * beside the first instead of the pair re-centring under the parent.
 *
 * Two ways to get the invariant: re-run the full Tidy pass over the whole
 * graph on every create, or reflow just the affected row and what hangs
 * below it. Full Tidy is simpler but wrong here — it would shift unrelated
 * branches (other root conversations, cousins the user isn't looking at)
 * out from under the user mid-conversation. This takes the local option:
 * call this *after* the new node has been added as a child of `parentId`,
 * and it repositions only `parentId`'s own subtree.
 */
export function reflowChildrenOnCreate(
  graph: ConversationGraph,
  parentId: string,
  width: number = NODE_WIDTH_DESKTOP,
  heights: NodeHeights = NO_HEIGHTS,
  widths: NodeWidths = NO_WIDTHS,
): ConversationGraph {
  const parent = graph.nodesById[parentId];
  if (!parent) return graph;

  const parentDepth = depthsByNode(graph).get(parentId) ?? 0;
  const offsets = rowOffsets(graph, heights);
  const writes = new Map<string, Point>();
  const result = layoutSubtree(graph, parentId, parentDepth, width, offsets, writes, widths);

  // `layoutSubtree` lays the subtree out in its own local frame, starting
  // near x = 0 — shift the whole thing so the parent stays exactly where it
  // already was. Only the children (and their subtrees) move; the parent
  // itself, and everything outside this subtree, does not jump around the
  // canvas just because one of its descendants gained a sibling.
  const anchorShift = parent.position.x - result.position.x;
  shiftSubtreeWrites(graph, parentId, anchorShift, writes);
  // `shiftSubtreeWrites` only corrects x. `layoutSubtree` also assigns the
  // parent's own y from `offsets[parentDepth]` — correct for a fresh
  // whole-tree Tidy, but here the parent already has a real y that may not
  // match a row offset recomputed from scratch (a manually-placed parent, or
  // one whose row's tallest card changed since it was placed). Force the
  // parent's write back to its exact current position on both axes: this
  // reflow's contract is that only children move.
  writes.set(parentId, parent.position);

  // Safety net: this reflow only ever spaces the row against itself, so it
  // has no idea whether an unrelated branch elsewhere in the graph now sits
  // under it — the same blind spot `autoPlaceOnCreate`'s old collision loop
  // existed for. Slide the whole reflowed group sideways as one rigid block
  // (preserving the even spacing / centering just computed) until it clears
  // every node outside the group.
  const reflowedIds = new Set(writes.keys());
  const outside = graph.nodeIds
    .filter((id) => !reflowedIds.has(id))
    .map((id) => ({
      position: graph.nodesById[id].position,
      height: heightOf(heights, id),
      width: widthOf(widths, id, width),
    }));

  const overlapsOutsideAt = (extraShift: number): boolean =>
    outside.some((o) =>
      Array.from(writes.entries()).some(([id, position]) =>
        rectsOverlap(
          {
            x: position.x + extraShift,
            y: position.y,
            width: widthOf(widths, id, width),
            height: heightOf(heights, id),
          },
          { x: o.position.x, y: o.position.y, width: o.width, height: o.height },
        ),
      ),
    );

  let extraShift = 0;
  while (overlapsOutsideAt(extraShift)) {
    extraShift += width + H_GAP;
  }
  if (extraShift !== 0) {
    for (const [id, position] of writes) {
      writes.set(id, { x: position.x + extraShift, y: position.y });
    }
  }

  let next = graph;
  for (const [nodeId, position] of writes) {
    next = placeNode(next, nodeId, position);
  }
  return next;
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
  widths: NodeWidths,
): TidyResult {
  const node = graph.nodesById[nodeId];
  const ownWidth = widthOf(widths, nodeId, width);
  const children = childIds(graph, nodeId).sort(
    (a, b) => graph.nodesById[a].createdAt - graph.nodesById[b].createdAt,
  );

  if (children.length === 0) {
    const position =
      node.positionMode === "manual"
        ? node.position
        : { x: 0, y: offsets[depth] };
    if (node.positionMode !== "manual") writes.set(nodeId, position);
    return { position, subtreeWidth: ownWidth };
  }

  let cursor = 0;
  const childResults: TidyResult[] = [];
  for (const childId of children) {
    const result = layoutSubtree(graph, childId, depth + 1, width, offsets, writes, widths);
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
  const subtreeWidth = Math.max(ownWidth, cursor - H_GAP);

  // Center children under this node's eventual x, then shift the whole group
  // so it starts at x = 0 for this call's local frame; the caller offsets it.
  const firstChildX = childResults[0].position.x;
  const lastChild = childResults[childResults.length - 1];
  const lastChildId = children[children.length - 1];
  const span = lastChild.position.x + widthOf(widths, lastChildId, width) - firstChildX;
  const centerX = firstChildX + span / 2 - ownWidth / 2;

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
  widths: NodeWidths = NO_WIDTHS,
): ConversationGraph {
  const writes = new Map<string, Point>();
  const offsets = rowOffsets(graph, heights);
  const roots = rootIds(graph).sort(
    (a, b) => graph.nodesById[a].createdAt - graph.nodesById[b].createdAt,
  );

  let cursor = 0;
  for (const rootId of roots) {
    const result = layoutSubtree(graph, rootId, 0, width, offsets, writes, widths);
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
    const node = graph.nodesById[id];
    const { x, y } = node.position;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (node.size?.width ?? width));
    maxY = Math.max(maxY, y + (node.size?.height ?? NODE_HEIGHT));
  }

  return { minX, minY, maxX, maxY };
}
