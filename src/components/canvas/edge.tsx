"use client";

/**
 * §6 `<Edge>`: parent bottom-centre → child top-centre, one cubic bezier.
 *
 * The two arrowhead markers this needs are defined once, by
 * `<EdgeMarkerDefs>`, in the parent SVG's own `<defs>` — an per-edge `<defs>`
 * would repeat the same `id` on every edge in the document, which is invalid
 * SVG and makes every marker after the first resolve to nothing predictable.
 */
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
  from: { x: number; y: number };
  to: { x: number; y: number };
  state: "default" | "active" | "dimmed";
}) {
  const gap = to.y - from.y;
  const controlOffset = gap * 0.4;
  const path = `M ${from.x} ${from.y} C ${from.x} ${from.y + controlOffset}, ${to.x} ${to.y - controlOffset}, ${to.x} ${to.y}`;

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
