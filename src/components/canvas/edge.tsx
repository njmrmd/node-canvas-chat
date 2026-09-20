"use client";

/**
 * §6 `<Edge>`: one cubic bezier, anchored to whichever sides actually face
 * each other (TES-91).
 *
 * A child whose card horizontally overlaps its parent's — the common single-
 * thread continuation — still reads top-to-bottom: bottom-centre → top-
 * centre. Every other case (a fork: the first branch stays under the parent
 * but every later sibling is auto-placed beside it, per `autoPlaceOnCreate`)
 * has no horizontal overlap, so the edge leaves the side of the parent that
 * actually faces the child and enters the facing side of the child. That is
 * what makes a fork's line touch the exact card it came from instead of
 * sweeping down past whatever else sits between the two columns.
 *
 * The two arrowhead markers this needs are defined once, by
 * `<EdgeMarkerDefs>`, in the parent SVG's own `<defs>` — an per-edge `<defs>`
 * would repeat the same `id` on every edge in the document, which is invalid
 * SVG and makes every marker after the first resolve to nothing predictable.
 */

export type EdgeRect = { x: number; y: number; width: number; height: number };

function horizontallyOverlaps(a: EdgeRect, b: EdgeRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x;
}

/** Pure geometry, exported for `edge.test.ts` — no anchor decision belongs
 * only inside JSX where it can't be unit-tested. */
export function edgePath(from: EdgeRect, to: EdgeRect): string {
  if (horizontallyOverlaps(from, to)) {
    const fromPoint = { x: from.x + from.width / 2, y: from.y + from.height };
    const toPoint = { x: to.x + to.width / 2, y: to.y };
    const controlOffset = (toPoint.y - fromPoint.y) * 0.4;
    return `M ${fromPoint.x} ${fromPoint.y} C ${fromPoint.x} ${fromPoint.y + controlOffset}, ${toPoint.x} ${toPoint.y - controlOffset}, ${toPoint.x} ${toPoint.y}`;
  }

  const toIsRight = to.x >= from.x + from.width;
  const fromPoint = { x: toIsRight ? from.x + from.width : from.x, y: from.y + from.height / 2 };
  const toPoint = { x: toIsRight ? to.x : to.x + to.width, y: to.y + to.height / 2 };
  const controlOffset = (toPoint.x - fromPoint.x) * 0.5;
  return `M ${fromPoint.x} ${fromPoint.y} C ${fromPoint.x + controlOffset} ${fromPoint.y}, ${toPoint.x - controlOffset} ${toPoint.y}, ${toPoint.x} ${toPoint.y}`;
}

export function EdgeMarkerDefs() {
  return (
    <defs>
      <marker id="cv-arrow-default" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0,0 L8,4 L0,8 Z" fill="var(--edge-default)" />
      </marker>
      <marker id="cv-arrow-active" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0,0 L8,4 L0,8 Z" fill="var(--accent)" />
      </marker>
    </defs>
  );
}

export function Edge({
  from,
  to,
  state,
}: {
  from: EdgeRect;
  to: EdgeRect;
  state: "default" | "active" | "dimmed";
}) {
  const path = edgePath(from, to);

  const active = state === "active";
  const stroke = active ? "var(--accent)" : "var(--edge-default)";
  const strokeWidth = active ? 2 : 1.5;
  const opacity = state === "dimmed" ? 0.35 : 1;

  return (
    <g className="cv-edge-highlight" style={{ opacity }}>
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        markerEnd={active ? "url(#cv-arrow-active)" : "url(#cv-arrow-default)"}
      />
    </g>
  );
}
