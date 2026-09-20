import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { edgePath, type EdgeRect } from "./edge";

/** Parses the `M x y C ...` path this module emits back into the two anchor
 * points, so tests can assert on geometry instead of a string literal. */
function anchors(path: string): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const [, moveArgs, curveArgs] = path.match(/^M ([^C]+)C (.+)$/)!;
  const [fx, fy] = moveArgs.trim().split(/\s+/).map(Number);
  const parts = curveArgs.split(",").map((p) => p.trim());
  const [tx, ty] = parts[2].split(/\s+/).map(Number);
  return { from: { x: fx, y: fy }, to: { x: tx, y: ty } };
}

describe("edgePath", () => {
  it("anchors bottom-centre to top-centre when the child sits directly under the parent", () => {
    const parent: EdgeRect = { x: 0, y: 0, width: 320, height: 160 };
    const child: EdgeRect = { x: 0, y: 232, width: 320, height: 160 };
    const { from, to } = anchors(edgePath(parent, child));
    assert.deepEqual(from, { x: 160, y: 160 });
    assert.deepEqual(to, { x: 160, y: 232 });
  });

  it("still anchors vertically when the child only partially overlaps the parent horizontally", () => {
    const parent: EdgeRect = { x: 0, y: 0, width: 320, height: 160 };
    const child: EdgeRect = { x: 200, y: 232, width: 320, height: 160 };
    const { from } = anchors(edgePath(parent, child));
    assert.equal(from.y, 160, "still leaves the bottom, not a side");
  });

  it("anchors right-of-parent to left-of-child for a fork placed beside it", () => {
    const parent: EdgeRect = { x: 0, y: 0, width: 320, height: 160 };
    const fork: EdgeRect = { x: 368, y: 0, width: 320, height: 160 };
    const { from, to } = anchors(edgePath(parent, fork));
    assert.deepEqual(from, { x: 320, y: 80 });
    assert.deepEqual(to, { x: 368, y: 80 });
  });

  it("mirrors to left-of-parent to right-of-child when the other card sits to the left", () => {
    const parent: EdgeRect = { x: 368, y: 0, width: 320, height: 160 };
    const sibling: EdgeRect = { x: 0, y: 0, width: 320, height: 160 };
    const { from, to } = anchors(edgePath(parent, sibling));
    assert.deepEqual(from, { x: 368, y: 80 });
    assert.deepEqual(to, { x: 320, y: 80 });
  });

  it("uses each card's real measured height, not a nominal constant, for the anchor point", () => {
    const tallParent: EdgeRect = { x: 0, y: 0, width: 320, height: 420 };
    const child: EdgeRect = { x: 0, y: 492, width: 320, height: 160 };
    const { from } = anchors(edgePath(tallParent, child));
    assert.equal(from.y, 420);
  });
});
