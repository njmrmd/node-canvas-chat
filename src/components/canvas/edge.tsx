"use client";

/**
 * §6 `<Edge>`: one cubic bezier, anchored the same way at every distance
 * (TES-102, reverses the side-anchor branch shipped in TES-91). Outbound is
 * always bottom-centre of the parent; inbound is always top-centre of the
 * child — never a side, no matter how far sideways the child sits. That
 * consistency is what makes the materialised port on `<NodeCard>` mean
 * something: it is one point, always the same point, and every wire this
 * card ever sends out is seen leaving from it.
 *
 * The hard part TES-91 got right: a child placed far sideways from its
 * parent, drawn with control points offset only vertically from their own
 * anchor, still needs to read as one clean curve rather than bulge or loop.
 * The fix is the control points D3's `linkVertical` uses — both sit at the
 * vertical midpoint between the two anchors (`fromPoint.x` paired with
 * `midY`, `toPoint.x` paired with the same `midY`). Because each control
 * point shares its anchor's x, the curve's tangent at both ends is exactly
 * vertical regardless of how large the horizontal gap is — that is what
 * "leaves the bottom" and "arrives at the top" require. And because neither
 * control point can cross past the other anchor's y (they're pinned to the
 * midpoint, never past it), the curve can't double back on itself: no
 * overshoot, no loop, at any dx.
 *
 * The two arrowhead markers this needs are defined once, by
 * `<EdgeMarkerDefs>`, in the parent SVG's own `<defs>` — an per-edge `<defs>`
 * would repeat the same `id` on every edge in the document, which is invalid
 * SVG and makes every marker after the first resolve to nothing predictable.
 */

export type EdgeRect = { x: number; y: number; width: number; height: number };

/** Pure geometry, exported for `edge.test.ts` — no anchor decision belongs
 * only inside JSX where it can't be unit-tested. */
export function edgePath(from: EdgeRect, to: EdgeRect): string {
  const fromPoint = { x: from.x + from.width / 2, y: from.y + from.height };
  const toPoint = { x: to.x + to.width / 2, y: to.y };
  const midY = (fromPoint.y + toPoint.y) / 2;
  return `M ${fromPoint.x} ${fromPoint.y} C ${fromPoint.x} ${midY}, ${toPoint.x} ${midY}, ${toPoint.x} ${toPoint.y}`;
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
  pending,
}: {
  from: EdgeRect;
  to: EdgeRect;
  state: "default" | "active" | "dimmed";
  /** §5.8: the cyanotype canvas draws a wire dashed while the child it feeds
   * is still pending/streaming and solid once it settles — `undefined`
   * outside the cyanotype surface, where `canvas.css` never reads
   * `data-pending` and every wire stays solid as it does today. */
  pending?: boolean;
}) {
  const path = edgePath(from, to);

  const active = state === "active";
  const stroke = active ? "var(--accent)" : "var(--edge-default)";
  const strokeWidth = active ? 2 : 1.5;
  const opacity = state === "dimmed" ? 0.35 : 1;

  return (
    <g className="cv-edge-highlight" style={{ opacity }}>
      <path
        className="cv-edge-path"
        data-pending={pending ? "true" : undefined}
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
