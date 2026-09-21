import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addNode,
  appendText,
  createGraph,
  moveNode,
  placeNode,
  resizeNode,
  type ConversationGraph,
} from "@/lib/conversation/graph";
import {
  NODE_WIDTH_DESKTOP,
  autoPlaceOnCreate,
  nodeWidthsFrom,
  reflowChildrenOnCreate,
  tidyLayout,
  type NodeHeights,
  type NodeWidths,
} from "./layout";

const ORIGIN = { x: 0, y: 0 };
const WIDTH = NODE_WIDTH_DESKTOP;
const FALLBACK_HEIGHT = 160;
const NO_WIDTHS: NodeWidths = new Map();

/** Adds a node and immediately gives it an answer, so a later test step can
 * hang a child off it — `addNode` refuses to branch from an empty response. */
function addAnswered(graph: ConversationGraph, id: string, parentId: string | null): ConversationGraph {
  const { graph: withNode } = addNode(graph, { id, parentId, prompt: "hi", position: ORIGIN });
  return appendText(withNode, id, "answer");
}

/** Mirrors the real create flow (TES-103): add the child at a throwaway
 * position, then let `reflowChildrenOnCreate` place the whole row — the
 * provisional position from `addNode` must never matter to the result. */
function addAnsweredAndReflow(
  graph: ConversationGraph,
  id: string,
  parentId: string,
  width: number = WIDTH,
  heights: NodeHeights = new Map(),
  widths: NodeWidths = NO_WIDTHS,
): ConversationGraph {
  const { graph: withNode } = addNode(graph, { id, parentId, prompt: "hi", position: ORIGIN });
  const reflowed = reflowChildrenOnCreate(withNode, parentId, width, heights, widths);
  return appendText(reflowed, id, "answer");
}

function rectFor(
  graph: ConversationGraph,
  nodeId: string,
  defaultWidth: number,
  heights: NodeHeights,
  widths: NodeWidths = NO_WIDTHS,
): { x: number; y: number; width: number; height: number } {
  const { position } = graph.nodesById[nodeId];
  return {
    x: position.x,
    y: position.y,
    width: widths.get(nodeId) ?? defaultWidth,
    height: heights.get(nodeId) ?? FALLBACK_HEIGHT,
  };
}

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** The real regression guard: every card's rect, brute-forced pairwise. */
function assertNoOverlaps(
  graph: ConversationGraph,
  width: number,
  heights: NodeHeights = new Map(),
  widths: NodeWidths = NO_WIDTHS,
): void {
  const ids = graph.nodeIds;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = rectFor(graph, ids[i], width, heights, widths);
      const b = rectFor(graph, ids[j], width, heights, widths);
      assert.equal(rectsOverlap(a, b), false, `${ids[i]} overlaps ${ids[j]}`);
    }
  }
}

describe("tidyLayout", () => {
  it("spreads siblings across distinct, non-overlapping x positions centered under the parent", () => {
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = addAnswered(graph, "c1", "root");
    graph = addAnswered(graph, "c2", "root");
    graph = addAnswered(graph, "c3", "root");

    const tidied = tidyLayout(graph, WIDTH);
    const xs = ["c1", "c2", "c3"].map((id) => tidied.nodesById[id].position.x);

    assert.equal(new Set(xs).size, 3, "siblings must not collapse onto the same x");
    assertNoOverlaps(tidied, WIDTH);

    const rootX = tidied.nodesById.root.position.x;
    assert.ok(
      rootX >= Math.min(...xs) && rootX <= Math.max(...xs),
      "root should be centered within its children's span",
    );
  });

  it("keeps every card non-overlapping across a 3-level tree with uneven branches, using real heights", () => {
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = addAnswered(graph, "a", "root");
    graph = addAnswered(graph, "b", "root");
    graph = addAnswered(graph, "a1", "a");
    graph = addAnswered(graph, "a2", "a");
    graph = addAnswered(graph, "a3", "a");
    graph = addAnswered(graph, "b1", "b");

    const heights: NodeHeights = new Map([
      ["root", 180],
      ["a", 400],
      ["b", 120],
      ["a1", 96],
      ["a2", 420],
      ["a3", 200],
      ["b1", 300],
    ]);

    const tidied = tidyLayout(graph, WIDTH, heights);
    assertNoOverlaps(tidied, WIDTH, heights);
  });

  it("leaves a manual node exactly where it was dragged", () => {
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = addAnswered(graph, "c1", "root");
    graph = addAnswered(graph, "c2", "root");
    graph = moveNode(graph, "c1", { x: 999, y: 999 });

    const tidied = tidyLayout(graph, WIDTH);
    assert.deepEqual(tidied.nodesById.c1.position, { x: 999, y: 999 });
  });

  it("keeps multiple root trees from overlapping each other", () => {
    let graph = createGraph();
    graph = addAnswered(graph, "root1", null);
    graph = addAnswered(graph, "root1c1", "root1");
    graph = addAnswered(graph, "root1c2", "root1");
    graph = addAnswered(graph, "root2", null);
    graph = addAnswered(graph, "root2c1", "root2");

    const tidied = tidyLayout(graph, WIDTH);
    assertNoOverlaps(tidied, WIDTH);
  });

  it("TES-90: keeps every card non-overlapping when one has been manually widened", () => {
    // A resized card is wider than `NODE_WIDTH_DESKTOP` in both directions it
    // matters for: it must not swallow its siblings horizontally, and its
    // parent must not center on top of it.
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = addAnswered(graph, "wide", "root");
    graph = addAnswered(graph, "narrow", "root");
    graph = addAnswered(graph, "wideChild", "wide");

    const heights: NodeHeights = new Map([
      ["root", 180],
      ["wide", 200],
      ["narrow", 150],
      ["wideChild", 160],
    ]);
    const widths: NodeWidths = new Map([["wide", 600]]);

    const tidied = tidyLayout(graph, WIDTH, heights, widths);
    assertNoOverlaps(tidied, WIDTH, heights, widths);
  });

  it("TES-90: keeps every card non-overlapping when one has been collapsed to a one-line height", () => {
    // A body-collapsed card renders at a fraction of its normal height
    // (measured, same as any other height, via `NodeHeights`) — the overlap
    // guard has to hold with a real card that short sitting next to normal
    // ones, not just with uniformly-sized cards.
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = addAnswered(graph, "collapsed", "root");
    graph = addAnswered(graph, "normal", "root");
    graph = addAnswered(graph, "collapsedChild", "collapsed");

    const heights: NodeHeights = new Map([
      ["root", 160],
      ["collapsed", 48],
      ["normal", 220],
      ["collapsedChild", 160],
    ]);

    const tidied = tidyLayout(graph, WIDTH, heights);
    assertNoOverlaps(tidied, WIDTH, heights);
  });
});

describe("autoPlaceOnCreate", () => {
  it("does not overlap a tall parent when placing a new child below it", () => {
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);

    const heights: NodeHeights = new Map([["tall", 340]]);

    const tallPosition = autoPlaceOnCreate(graph, "root", WIDTH, heights);
    const { graph: withTall } = addNode(graph, { id: "tall", parentId: "root", prompt: "hi", position: tallPosition });
    graph = appendText(withTall, "tall", "answer");

    const childPosition = autoPlaceOnCreate(graph, "tall", WIDTH, heights);
    const { graph: withChild } = addNode(graph, { id: "child", parentId: "tall", prompt: "hi", position: childPosition });

    assertNoOverlaps(withChild, WIDTH, heights);
  });

  it("TES-80: branching a second child onto a node that already has one lands at a distinct x, not stacked on the first", () => {
    // Mirrors the reported repro shape: a parent with one existing child (the
    // original reply) gets a second child from a Branch (a fork), and the
    // two must sit side by side — this is the auto-place half of TES-80's
    // ask, independent of Tidy.
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = addAnswered(graph, "parent", "root");

    const firstChildPosition = autoPlaceOnCreate(graph, "parent", WIDTH);
    const { graph: withFirstChild } = addNode(graph, {
      id: "first-child",
      parentId: "parent",
      prompt: "hi",
      position: firstChildPosition,
    });
    graph = appendText(withFirstChild, "first-child", "answer");

    const secondChildPosition = autoPlaceOnCreate(graph, "parent", WIDTH);
    addNode(graph, {
      id: "second-child",
      parentId: "parent",
      prompt: "hi",
      position: secondChildPosition,
    });

    assert.notEqual(
      firstChildPosition.x,
      secondChildPosition.x,
      "the two children of the same parent must not land on the same x",
    );
    assert.equal(
      rectsOverlap(
        { ...firstChildPosition, width: WIDTH, height: FALLBACK_HEIGHT },
        { ...secondChildPosition, width: WIDTH, height: FALLBACK_HEIGHT },
      ),
      false,
      "the two children must not overlap each other",
    );
  });

  it("TES-90: does not overlap a manually-widened parent when placing a new child below it", () => {
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);

    const widths: NodeWidths = new Map([["wide", 600]]);

    const widePosition = autoPlaceOnCreate(graph, "root", WIDTH, new Map(), widths);
    const { graph: withWide } = addNode(graph, { id: "wide", parentId: "root", prompt: "hi", position: widePosition });
    graph = appendText(withWide, "wide", "answer");

    const childPosition = autoPlaceOnCreate(graph, "wide", WIDTH, new Map(), widths);
    const { graph: withChild } = addNode(graph, { id: "child", parentId: "wide", prompt: "hi", position: childPosition });

    assertNoOverlaps(withChild, WIDTH, new Map(), widths);
  });

  it("TES-90: a second sibling lands clear of a manually-widened first sibling", () => {
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);

    const widths: NodeWidths = new Map([["wide", 600]]);

    const widePosition = autoPlaceOnCreate(graph, "root", WIDTH, new Map(), widths);
    const { graph: withWide } = addNode(graph, { id: "wide", parentId: "root", prompt: "hi", position: widePosition });
    graph = appendText(withWide, "wide", "answer");

    const siblingPosition = autoPlaceOnCreate(graph, "root", WIDTH, new Map(), widths);
    const { graph: withSibling } = addNode(graph, {
      id: "sibling",
      parentId: "root",
      prompt: "hi",
      position: siblingPosition,
    });

    assertNoOverlaps(withSibling, WIDTH, new Map(), widths);
  });
});

describe("reflowChildrenOnCreate", () => {
  it("TES-103: re-centers a growing sibling row — same y, evenly spaced, parent centered over the span", () => {
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = addAnsweredAndReflow(graph, "c1", "root");
    graph = addAnsweredAndReflow(graph, "c2", "root");
    graph = addAnsweredAndReflow(graph, "c3", "root");

    const xs = ["c1", "c2", "c3"].map((id) => graph.nodesById[id].position.x).sort((a, b) => a - b);
    const ys = ["c1", "c2", "c3"].map((id) => graph.nodesById[id].position.y);

    assert.equal(new Set(ys).size, 1, "every sibling of the same parent must share one y");
    assert.equal(new Set(xs).size, 3, "siblings must not collapse onto the same x");

    const gapA = xs[1] - xs[0];
    const gapB = xs[2] - xs[1];
    assert.equal(gapA, gapB, "siblings must be distributed evenly, not just non-overlapping");

    const rootCenter = graph.nodesById.root.position.x + WIDTH / 2;
    const spanCenter = (xs[0] + xs[2] + WIDTH) / 2;
    assert.ok(
      Math.abs(rootCenter - spanCenter) < 0.001,
      `parent must be centered over its children's span (root center ${rootCenter}, span center ${spanCenter})`,
    );
  });

  it("TES-103: adding a second child re-centers the pair under the parent instead of landing beside the first", () => {
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = addAnsweredAndReflow(graph, "c1", "root");
    const c1AfterFirst = graph.nodesById.c1.position.x;

    graph = addAnsweredAndReflow(graph, "c2", "root");

    // A single child sits directly under the parent; once it has a sibling,
    // the pair must straddle that same center rather than c1 staying put and
    // c2 simply landing beside it.
    assert.notEqual(
      graph.nodesById.c1.position.x,
      c1AfterFirst,
      "the first child must shift left to make room for its new sibling",
    );
    const rootCenter = graph.nodesById.root.position.x + WIDTH / 2;
    const c1Center = graph.nodesById.c1.position.x + WIDTH / 2;
    const c2Center = graph.nodesById.c2.position.x + WIDTH / 2;
    assert.ok(
      Math.abs(rootCenter - (c1Center + c2Center) / 2) < 0.001,
      "the parent must stay centered over the pair",
    );
  });

  it("TES-103: does not move the parent itself, only the row beneath it", () => {
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = addAnsweredAndReflow(graph, "c1", "root");
    const rootBefore = graph.nodesById.root.position;

    graph = addAnsweredAndReflow(graph, "c2", "root");

    assert.deepEqual(
      graph.nodesById.root.position,
      rootBefore,
      "an unrelated reflow of the children row must not relocate the parent",
    );
  });

  it("TES-103: does not reset the parent's y even when it disagrees with a fresh row-offset computation", () => {
    // Regression: `layoutSubtree` (reused internally) also assigns the
    // parent's own y from `offsets[depth]`, which is only right for a
    // from-scratch Tidy pass. A parent whose real y doesn't happen to match
    // that (any y other than a depth-0 node sitting at 0, which coincidentally
    // matches `offsets[0]`) must keep its real y, not silently snap to it.
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = placeNode(graph, "root", { x: 400, y: 237 });
    graph = addAnsweredAndReflow(graph, "c1", "root");

    assert.deepEqual(graph.nodesById.root.position, { x: 400, y: 237 });

    graph = addAnsweredAndReflow(graph, "c2", "root");

    assert.deepEqual(
      graph.nodesById.root.position,
      { x: 400, y: 237 },
      "the parent's y must survive a second reflow unchanged",
    );
  });

  it("TES-106: a child of a non-zero-y root still renders below its parent", () => {
    // Regression: `centeredRootPosition` (TES-103) can park the very first
    // node anywhere in the viewport, not just y=0. `layoutSubtree` computes
    // every descendant's y as a cumulative offset that assumes the subtree
    // root sits at y=0, and the old code only re-based the *parent's* write
    // back onto its real position afterward — never the children's. That let
    // a first reply render above its own question whenever the root's real y
    // was bigger than the reflow's assumed row-0 offset (e.g. root centered
    // at y=342: child came out at y=217).
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = placeNode(graph, "root", { x: 0, y: 342 });
    graph = addAnsweredAndReflow(graph, "c1", "root", WIDTH, new Map([["root", 160]]));

    assert.ok(
      graph.nodesById.c1.position.y > graph.nodesById.root.position.y,
      `child must render below its parent (root y=${graph.nodesById.root.position.y}, child y=${graph.nodesById.c1.position.y})`,
    );
    assert.equal(
      graph.nodesById.c1.position.y,
      graph.nodesById.root.position.y + 160 + 72,
      "child y must be exactly the parent's real y plus the parent's height plus V_GAP",
    );
  });

  it("TES-103: leaves a manually-dragged sibling exactly where it was", () => {
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = addAnsweredAndReflow(graph, "c1", "root");
    graph = moveNode(graph, "c1", { x: 999, y: 999 });

    graph = addAnsweredAndReflow(graph, "c2", "root");

    assert.deepEqual(graph.nodesById.c1.position, { x: 999, y: 999 });
  });

  it("TES-103: keeps every card non-overlapping across a 4-deep graph with mixed heights, built incrementally", () => {
    let graph = createGraph();
    const heights: NodeHeights = new Map([
      ["root", 180],
      ["a", 220],
      ["b", 140],
      ["a1", 96],
      ["a2", 420],
      ["a3", 200],
      ["b1", 300],
      ["a2x", 160],
    ]);

    graph = addAnswered(graph, "root", null);
    graph = addAnsweredAndReflow(graph, "a", "root", WIDTH, heights);
    graph = addAnsweredAndReflow(graph, "b", "root", WIDTH, heights);
    graph = addAnsweredAndReflow(graph, "a1", "a", WIDTH, heights);
    graph = addAnsweredAndReflow(graph, "a2", "a", WIDTH, heights);
    graph = addAnsweredAndReflow(graph, "a3", "a", WIDTH, heights);
    graph = addAnsweredAndReflow(graph, "b1", "b", WIDTH, heights);
    // Depth 4: a grandchild of a grandchild of root.
    graph = addAnsweredAndReflow(graph, "a2x", "a2", WIDTH, heights);

    assertNoOverlaps(graph, WIDTH, heights);

    const a1y = graph.nodesById.a1.position.y;
    const a2y = graph.nodesById.a2.position.y;
    const a3y = graph.nodesById.a3.position.y;
    assert.equal(a1y, a2y);
    assert.equal(a2y, a3y);
  });

  it("TES-110 regression: resizing a parent without reflowing lets a later preview land on its real children", () => {
    // Documents the bug this ticket fixed: `resizeNode` (graph.ts) only ever
    // patches `size` — on its own it never moves the parent's existing
    // children. A preview computed afterward from the parent's new
    // (post-resize) width, exactly like `previewNodePosition` in
    // canvas-app.tsx, disagrees with where the real siblings actually are.
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = addAnsweredAndReflow(graph, "reply", "root");
    graph = addAnsweredAndReflow(graph, "fork", "root");

    graph = resizeNode(graph, "root", { width: 640, height: 300 });

    // The real siblings' rects, straight off the graph the UI actually
    // renders from — `resizeNode` alone never touched them.
    const heights: NodeHeights = new Map([["root", 300]]);
    const realWidths = nodeWidthsFrom(graph, WIDTH);
    const realReplyRect = rectFor(graph, "reply", WIDTH, heights, realWidths);
    const realForkRect = rectFor(graph, "fork", WIDTH, heights, realWidths);

    // `previewNodePosition` only ever reads the new node's position back out
    // of this hypothetical reflow — it never applies the rest of the reflow's
    // writes (i.e. reply/fork's recomputed positions) to the real graph, so
    // comparing against the real, un-reflowed siblings above is the faithful
    // reproduction of what actually renders on screen.
    const { graph: withPreview } = addNode(graph, {
      id: "__preview__",
      parentId: "root",
      prompt: "",
      position: ORIGIN,
    });
    const reflowed = reflowChildrenOnCreate(
      withPreview,
      "root",
      WIDTH,
      heights,
      nodeWidthsFrom(withPreview, WIDTH),
    );
    const previewRect = rectFor(reflowed, "__preview__", WIDTH, heights, nodeWidthsFrom(reflowed, WIDTH));

    assert.ok(
      rectsOverlap(previewRect, realReplyRect) || rectsOverlap(previewRect, realForkRect),
      "sanity check: an un-reflowed resize must reproduce the reported overlap",
    );
  });

  it("TES-110: reflowing a parent's children on resize keeps a later preview clear of them", () => {
    // The fix: `use-canvas-controller.ts`'s `resizeNode` now reflows the
    // resized node's own children immediately after patching its size, the
    // same reflow `previewNodePosition` runs to compute the skeleton. Once
    // both start from the same post-resize state, they agree.
    let graph = createGraph();
    graph = addAnswered(graph, "root", null);
    graph = addAnsweredAndReflow(graph, "reply", "root");
    graph = addAnsweredAndReflow(graph, "fork", "root");

    graph = resizeNode(graph, "root", { width: 640, height: 300 });
    const heights: NodeHeights = new Map([["root", 300]]);
    graph = reflowChildrenOnCreate(graph, "root", WIDTH, heights, nodeWidthsFrom(graph, WIDTH));

    assertNoOverlaps(graph, WIDTH, heights, nodeWidthsFrom(graph, WIDTH));

    const { graph: withPreview } = addNode(graph, {
      id: "__preview__",
      parentId: "root",
      prompt: "",
      position: ORIGIN,
    });
    const reflowed = reflowChildrenOnCreate(
      withPreview,
      "root",
      WIDTH,
      heights,
      nodeWidthsFrom(withPreview, WIDTH),
    );
    const widths = nodeWidthsFrom(reflowed, WIDTH);
    const previewRect = rectFor(reflowed, "__preview__", WIDTH, heights, widths);
    const replyRect = rectFor(reflowed, "reply", WIDTH, heights, widths);
    const forkRect = rectFor(reflowed, "fork", WIDTH, heights, widths);

    assert.ok(!rectsOverlap(previewRect, replyRect), "preview must not overlap the real reply sibling");
    assert.ok(!rectsOverlap(previewRect, forkRect), "preview must not overlap the real fork sibling");
  });
});
