import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addNode,
  appendText,
  canBranchFrom,
  createGraph,
  failNode,
  getNode,
  interruptNode,
  startStreaming,
} from "@/lib/conversation/graph";
import { canBranchNow } from "./use-canvas-controller";

const ORIGIN = { x: 0, y: 0 };

describe("canBranchNow", () => {
  it("allows branching from a complete node regardless of content", () => {
    const { graph } = addNode(createGraph(), { id: "a", prompt: "hi", parentId: null, position: ORIGIN });
    const node = getNode(startStreaming(graph, "a"), "a")!;
    assert.equal(canBranchNow(node), false, "sanity: streaming is not branchable");
  });

  it("refuses a content-less interrupted node — the TES-58 gate mismatch", () => {
    const { graph } = addNode(createGraph(), { id: "a", prompt: "hi", parentId: null, position: ORIGIN });
    const streaming = startStreaming(graph, "a");
    const interrupted = interruptNode(streaming, "a");
    const node = getNode(interrupted, "a")!;

    // The UI gate and the data-layer gate must agree, or the composer renders
    // enabled for a node `addNode` will then throw on.
    assert.equal(canBranchNow(node), canBranchFrom(node));
    assert.equal(canBranchNow(node), false);
  });

  it("allows an interrupted node that kept partial text", () => {
    const { graph } = addNode(createGraph(), { id: "a", prompt: "hi", parentId: null, position: ORIGIN });
    let next = startStreaming(graph, "a");
    next = appendText(next, "a", "partial answer");
    next = interruptNode(next, "a");
    const node = getNode(next, "a")!;

    assert.equal(canBranchNow(node), canBranchFrom(node));
    assert.equal(canBranchNow(node), true);
  });

  it("refuses a content-less error node, same as before", () => {
    const { graph } = addNode(createGraph(), { id: "a", prompt: "hi", parentId: null, position: ORIGIN });
    const streaming = startStreaming(graph, "a");
    const errored = failNode(streaming, "a", { code: "internal_error", message: "boom" });
    const node = getNode(errored, "a")!;

    assert.equal(canBranchNow(node), false);
  });
});
