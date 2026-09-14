import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addNode,
  appendText,
  appendThinking,
  canBranchFrom,
  checkBranchSize,
  childIds,
  completeNode,
  createGraph,
  descendantIds,
  failNode,
  interruptNode,
  isEmpty,
  moveNode,
  pathToRoot,
  removeBranch,
  rootIds,
  settleOrphanedStreams,
  startStreaming,
  toMessages,
  type ConversationGraph,
} from "./graph";

const ORIGIN = { x: 0, y: 0 };

/** A node with an answer, so it can be branched from. */
function answered(
  graph: ConversationGraph,
  id: string,
  prompt: string,
  response: string,
  parentId: string | null = null,
): ConversationGraph {
  const added = addNode(graph, { id, prompt, parentId, position: ORIGIN });
  let next = startStreaming(added.graph, id);
  next = appendText(next, id, response);
  return completeNode(next, id, { inputTokens: 1, outputTokens: 2 });
}

describe("conversation graph", () => {
  it("starts empty", () => {
    const graph = createGraph();
    assert.equal(isEmpty(graph), true);
    assert.deepEqual(rootIds(graph), []);
  });

  it("does not mutate the graph it was given", () => {
    const graph = createGraph();
    const { graph: next } = addNode(graph, { prompt: "hi", position: ORIGIN });

    assert.equal(isEmpty(graph), true, "the original graph was mutated");
    assert.equal(next.nodeIds.length, 1);
  });

  it("shares node references for nodes that did not change", () => {
    let graph = answered(createGraph(), "a", "one", "first");
    const before = graph.nodesById.a;
    graph = addNode(graph, { id: "b", prompt: "two", parentId: "a", position: ORIGIN }).graph;

    assert.equal(graph.nodesById.a, before, "an untouched node was recreated");
  });

  describe("branching", () => {
    it("refuses to branch from a node with no answer yet", () => {
      const { graph } = addNode(createGraph(), { id: "a", prompt: "hi", position: ORIGIN });

      assert.equal(canBranchFrom(graph.nodesById.a), false);
      assert.throws(
        () => addNode(graph, { prompt: "child", parentId: "a", position: ORIGIN }),
        /no answer yet/,
      );
    });

    it("allows branching from an interrupted node that produced text", () => {
      let graph = addNode(createGraph(), { id: "a", prompt: "hi", position: ORIGIN }).graph;
      graph = startStreaming(graph, "a");
      graph = appendText(graph, "a", "half an ans");
      graph = interruptNode(graph, "a");

      assert.equal(canBranchFrom(graph.nodesById.a), true);
      assert.doesNotThrow(() =>
        addNode(graph, { prompt: "child", parentId: "a", position: ORIGIN }),
      );
    });

    it("refuses to branch from a failed node that produced nothing", () => {
      let graph = addNode(createGraph(), { id: "a", prompt: "hi", position: ORIGIN }).graph;
      graph = startStreaming(graph, "a");
      graph = failNode(graph, "a", { code: "provider_unavailable", message: "nope" });

      assert.equal(canBranchFrom(graph.nodesById.a), false);
    });

    it("supports several branches from one parent and several roots", () => {
      let graph = answered(createGraph(), "a", "one", "first");
      graph = addNode(graph, { id: "b", prompt: "left", parentId: "a", position: ORIGIN }).graph;
      graph = addNode(graph, { id: "c", prompt: "right", parentId: "a", position: ORIGIN }).graph;
      graph = addNode(graph, { id: "d", prompt: "other root", position: ORIGIN }).graph;

      assert.deepEqual(childIds(graph, "a").sort(), ["b", "c"]);
      assert.deepEqual(rootIds(graph).sort(), ["a", "d"]);
    });
  });

  describe("toMessages", () => {
    it("sends only the prompt for a root node", () => {
      const { graph } = addNode(createGraph(), { id: "a", prompt: "hello", position: ORIGIN });

      assert.deepEqual(toMessages(graph, "a"), [{ role: "user", content: "hello" }]);
    });

    it("flattens the path from the root, excluding the target's own answer", () => {
      let graph = answered(createGraph(), "a", "one", "first");
      graph = answered(graph, "b", "two", "second", "a");
      graph = addNode(graph, { id: "c", prompt: "three", parentId: "b", position: ORIGIN }).graph;

      assert.deepEqual(toMessages(graph, "c"), [
        { role: "user", content: "one" },
        { role: "assistant", content: "first" },
        { role: "user", content: "two" },
        { role: "assistant", content: "second" },
        { role: "user", content: "three" },
      ]);
    });

    it("sends only its own ancestry for a sibling, not the other branch", () => {
      let graph = answered(createGraph(), "a", "one", "first");
      graph = answered(graph, "b", "left", "went left", "a");
      graph = addNode(graph, { id: "c", prompt: "right", parentId: "a", position: ORIGIN }).graph;

      assert.deepEqual(toMessages(graph, "c"), [
        { role: "user", content: "one" },
        { role: "assistant", content: "first" },
        { role: "user", content: "right" },
      ]);
    });

    it("always alternates and always starts with a user turn", () => {
      let graph = answered(createGraph(), "a", "one", "first");
      graph = answered(graph, "b", "two", "second", "a");
      graph = addNode(graph, { id: "c", prompt: "three", parentId: "b", position: ORIGIN }).graph;

      const messages = toMessages(graph, "c");
      assert.equal(messages[0].role, "user");
      messages.forEach((message, index) => {
        assert.equal(message.role, index % 2 === 0 ? "user" : "assistant");
      });
    });

    it("replaces rather than continues when a node is answered twice", () => {
      let graph = answered(createGraph(), "a", "one", "first");
      graph = startStreaming(graph, "a");

      assert.equal(graph.nodesById.a.response, "", "the old answer was kept");
      assert.equal(graph.nodesById.a.error, null);
    });
  });

  describe("removeBranch", () => {
    it("removes the node and every descendant", () => {
      let graph = answered(createGraph(), "a", "one", "first");
      graph = answered(graph, "b", "two", "second", "a");
      graph = addNode(graph, { id: "c", prompt: "three", parentId: "b", position: ORIGIN }).graph;
      graph = addNode(graph, { id: "d", prompt: "keep", position: ORIGIN }).graph;

      const next = removeBranch(graph, "b");

      assert.deepEqual([...next.nodeIds].sort(), ["a", "d"]);
      assert.equal(next.nodesById.c, undefined);
    });

    it("lists descendants parents-first", () => {
      let graph = answered(createGraph(), "a", "one", "first");
      graph = answered(graph, "b", "two", "second", "a");
      graph = addNode(graph, { id: "c", prompt: "three", parentId: "b", position: ORIGIN }).graph;

      assert.deepEqual(descendantIds(graph, "a"), ["a", "b", "c"]);
    });
  });

  describe("streaming state", () => {
    it("accumulates text and thinking separately", () => {
      let graph = addNode(createGraph(), { id: "a", prompt: "hi", position: ORIGIN }).graph;
      graph = startStreaming(graph, "a");
      graph = appendThinking(graph, "a", "let me ");
      graph = appendThinking(graph, "a", "think");
      graph = appendText(graph, "a", "an ");
      graph = appendText(graph, "a", "answer");

      assert.equal(graph.nodesById.a.thinking, "let me think");
      assert.equal(graph.nodesById.a.response, "an answer");
      assert.equal(graph.nodesById.a.status, "streaming");
    });

    it("keeps partial text when interrupted", () => {
      let graph = addNode(createGraph(), { id: "a", prompt: "hi", position: ORIGIN }).graph;
      graph = startStreaming(graph, "a");
      graph = appendText(graph, "a", "half");
      graph = interruptNode(graph, "a");

      assert.equal(graph.nodesById.a.status, "interrupted");
      assert.equal(graph.nodesById.a.response, "half");
    });

    it("settles nodes left streaming by a reload", () => {
      let graph = addNode(createGraph(), { id: "a", prompt: "hi", position: ORIGIN }).graph;
      graph = startStreaming(graph, "a");
      graph = appendText(graph, "a", "partial");
      graph = answered(graph, "b", "two", "done", null);

      const rehydrated = settleOrphanedStreams(graph);

      assert.equal(rehydrated.nodesById.a.status, "interrupted");
      assert.equal(rehydrated.nodesById.a.response, "partial");
      assert.equal(rehydrated.nodesById.b.status, "complete", "a settled node changed");
    });
  });

  describe("pathToRoot", () => {
    it("throws on a cycle rather than hanging", () => {
      let graph = answered(createGraph(), "a", "one", "first");
      graph = answered(graph, "b", "two", "second", "a");

      // Only reachable from a corrupted persisted graph.
      const corrupted: ConversationGraph = {
        nodeIds: graph.nodeIds,
        nodesById: {
          ...graph.nodesById,
          a: { ...graph.nodesById.a, parentId: "b" },
        },
      };

      assert.throws(() => pathToRoot(corrupted, "b"), /Cycle/);
    });
  });

  it("moves a node without touching anything else", () => {
    let graph = answered(createGraph(), "a", "one", "first");
    graph = answered(graph, "b", "two", "second", "a");
    const next = moveNode(graph, "a", { x: 120, y: 40 });

    assert.deepEqual(next.nodesById.a.position, { x: 120, y: 40 });
    assert.equal(next.nodesById.b, graph.nodesById.b);
  });

  describe("checkBranchSize", () => {
    it("passes an ordinary branch", () => {
      assert.equal(checkBranchSize([{ role: "user", content: "hi" }]), null);
    });

    it("catches too many messages before a round trip", () => {
      const messages = Array.from({ length: 101 }, () => ({
        role: "user" as const,
        content: "x",
      }));

      assert.equal(checkBranchSize(messages)?.reason, "messages");
    });

    it("catches a branch over the total character cap", () => {
      const messages = Array.from({ length: 5 }, () => ({
        role: "user" as const,
        content: "x".repeat(90_000),
      }));

      assert.equal(checkBranchSize(messages)?.reason, "chars");
    });

    it("catches a single message over the per-message cap", () => {
      const messages = [{ role: "user" as const, content: "x".repeat(100_001) }];

      assert.equal(checkBranchSize(messages)?.reason, "message_chars");
    });
  });
});
