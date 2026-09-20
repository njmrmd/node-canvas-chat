import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addNode,
  appendText,
  createGraph,
  moveNode,
  type ConversationGraph,
} from "@/lib/conversation/graph";
import { NODE_WIDTH_DESKTOP, autoPlaceOnCreate, tidyLayout, type NodeHeights } from "./layout";

const ORIGIN = { x: 0, y: 0 };
const WIDTH = NODE_WIDTH_DESKTOP;
const FALLBACK_HEIGHT = 160;

/** Adds a node and immediately gives it an answer, so a later test step can
 * hang a child off it — `addNode` refuses to branch from an empty response. */
function addAnswered(graph: ConversationGraph, id: string, parentId: string | null): ConversationGraph {
  const { graph: withNode } = addNode(graph, { id, parentId, prompt: "hi", position: ORIGIN });
  return appendText(withNode, id, "answer");
}

function rectFor(
  graph: ConversationGraph,
  nodeId: string,
  width: number,
  heights: NodeHeights,
): { x: number; y: number; width: number; height: number } {
  const { position } = graph.nodesById[nodeId];
  return { x: position.x, y: position.y, width, height: heights.get(nodeId) ?? FALLBACK_HEIGHT };
}

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** The real regression guard: every card's rect, brute-forced pairwise. */
function assertNoOverlaps(graph: ConversationGraph, width: number, heights: NodeHeights = new Map()): void {
  const ids = graph.nodeIds;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = rectFor(graph, ids[i], width, heights);
      const b = rectFor(graph, ids[j], width, heights);
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
});
