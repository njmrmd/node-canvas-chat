import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { edgePath, type EdgeRect } from "./edge";

/** Parses the `M x y C ...` path this module emits back into the anchor and
 * control points, so tests can assert on geometry instead of a string
 * literal. */
function points(path: string): {
  from: { x: number; y: number };
  c1: { x: number; y: number };
  c2: { x: number; y: number };
  to: { x: number; y: number };
} {
  const [, moveArgs, curveArgs] = path.match(/^M ([^C]+)C (.+)$/)!;
  const [fx, fy] = moveArgs.trim().split(/\s+/).map(Number);
  const parts = curveArgs.split(",").map((p) => p.trim());
  const [c1x, c1y] = parts[0].split(/\s+/).map(Number);
  const [c2x, c2y] = parts[1].split(/\s+/).map(Number);
  const [tx, ty] = parts[2].split(/\s+/).map(Number);
  return { from: { x: fx, y: fy }, c1: { x: c1x, y: c1y }, c2: { x: c2x, y: c2y }, to: { x: tx, y: ty } };
}

function anchors(path: string): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const { from, to } = points(path);
  return { from, to };
}

describe("edgePath", () => {
  it("anchors bottom-centre to top-centre when the child sits directly under the parent", () => {
    const parent: EdgeRect = { x: 0, y: 0, width: 320, height: 160 };
    const child: EdgeRect = { x: 0, y: 232, width: 320, height: 160 };
    const { from, to } = anchors(edgePath(parent, child));
    assert.deepEqual(from, { x: 160, y: 160 });
    assert.deepEqual(to, { x: 160, y: 232 });
  });

  it("still anchors bottom-to-top when the child only partially overlaps the parent horizontally", () => {
    const parent: EdgeRect = { x: 0, y: 0, width: 320, height: 160 };
    const child: EdgeRect = { x: 200, y: 232, width: 320, height: 160 };
    const { from, to } = anchors(edgePath(parent, child));
    assert.equal(from.y, 160, "still leaves the bottom, not a side");
    assert.equal(to.y, 232, "still arrives at the top, not a side");
  });

  it("still anchors bottom-to-top for a fork placed beside the parent with no horizontal overlap (TES-102, reverses TES-91's side anchors)", () => {
    const parent: EdgeRect = { x: 0, y: 0, width: 320, height: 160 };
    const fork: EdgeRect = { x: 368, y: 232, width: 320, height: 160 };
    const { from, to } = anchors(edgePath(parent, fork));
    assert.deepEqual(from, { x: 160, y: 160 }, "outbound leaves bottom-centre of the parent");
    assert.deepEqual(to, { x: 528, y: 232 }, "inbound arrives top-centre of the fork, not its left edge");
  });

  it("still anchors bottom-to-top however far sideways the child is drawn from its parent", () => {
    const parent: EdgeRect = { x: 0, y: 0, width: 320, height: 160 };
    const farChild: EdgeRect = { x: 1400, y: 232, width: 320, height: 160 };
    const { from, to } = anchors(edgePath(parent, farChild));
    assert.deepEqual(from, { x: 160, y: 160 });
    assert.deepEqual(to, { x: 1560, y: 232 });
  });

  it("keeps both control points within the vertical band between the anchors so a far-sideways child reads as one clean curve, not a bulge or loop", () => {
    const parent: EdgeRect = { x: 0, y: 0, width: 320, height: 160 };
    // A shallow row gap (small dy) paired with a wide sideways placement
    // (large dx) is exactly the shape that broke under the old
    // dy-only control offset (TES-102).
    const farChild: EdgeRect = { x: 1400, y: 200, width: 320, height: 160 };
    const { from, c1, c2, to } = points(edgePath(parent, farChild));

    assert.equal(c1.x, from.x, "control leaving the parent stays directly below its anchor — vertical departure");
    assert.equal(c2.x, to.x, "control entering the child stays directly above its anchor — vertical arrival");
    assert.ok(c1.y >= from.y && c1.y <= to.y, "first control never overshoots past the child's anchor y");
    assert.ok(c2.y >= from.y && c2.y <= to.y, "second control never undershoots past the parent's anchor y");
  });

  it("draws a straight vertical line when the child sits exactly under the parent (control points collapse onto the anchor line)", () => {
    const parent: EdgeRect = { x: 0, y: 0, width: 320, height: 160 };
    const child: EdgeRect = { x: 0, y: 232, width: 320, height: 160 };
    const { from, c1, c2, to } = points(edgePath(parent, child));
    assert.equal(c1.x, from.x);
    assert.equal(c2.x, to.x);
    assert.equal(c1.x, c2.x, "same-x anchors put both controls on that same vertical line");
  });

  it("uses each card's real measured height, not a nominal constant, for the anchor point", () => {
    const tallParent: EdgeRect = { x: 0, y: 0, width: 320, height: 420 };
    const child: EdgeRect = { x: 0, y: 492, width: 320, height: 160 };
    const { from } = anchors(edgePath(tallParent, child));
    assert.equal(from.y, 420);
  });
});
