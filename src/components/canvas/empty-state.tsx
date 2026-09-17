"use client";

import { copy } from "@/lib/canvas/copy";

/**
 * §3 Moment 1: a static, non-interactive diagram in the real `<NodeCard>`
 * visual language at ~0.55 scale, so the first real node is a recognition
 * rather than a surprise. Built from the same tokens as the real card rather
 * than reusing `<ConversationGraph>` (the landing page's SVG illustration) —
 * that one predates the canvas and draws in a generic vector language, not
 * this component's actual visual system.
 */
function MiniCard({
  x,
  y,
  label,
  lines,
}: {
  x: number;
  y: number;
  label: string;
  lines: [number, number];
}) {
  const width = 176;
  const height = 88;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        height,
        background: "var(--surface-1)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-2) var(--space-3)",
      }}
    >
      <span style={{ font: "var(--text-2xs)", color: "var(--text-tertiary)" }}>{label}</span>
      <div style={{ marginTop: 6, height: 8, width: `${lines[0]}%`, borderRadius: "var(--radius-full)", background: "var(--text-primary)", opacity: 0.5 }} />
      <div style={{ marginTop: 6, height: 6, width: `${lines[1]}%`, borderRadius: "var(--radius-full)", background: "var(--text-secondary)", opacity: 0.35 }} />
    </div>
  );
}

export function EmptyStateDiagram() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "relative",
        width: 420,
        height: 220,
        maxWidth: "100%",
        margin: "0 auto",
        opacity: 0.72,
        transform: "scale(0.55)",
        transformOrigin: "top center",
      }}
    >
      <svg width={420} height={220} style={{ position: "absolute", inset: 0 }}>
        <path d="M 210 88 C 210 110 90 110 90 132" stroke="var(--edge-default)" strokeWidth={1.5} fill="none" strokeLinecap="round" />
        <path d="M 210 88 C 210 110 330 110 330 132" stroke="var(--edge-default)" strokeWidth={1.5} fill="none" strokeLinecap="round" />
      </svg>
      <MiniCard x={122} y={0} label="your question" lines={[70, 55]} />
      <div
        style={{
          position: "absolute",
          left: 210 - 14,
          top: 88 - 14,
          width: 28,
          height: 28,
          borderRadius: "var(--radius-full)",
          background: "var(--surface-3)",
          border: "1px solid var(--border-strong)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-secondary)",
          font: "var(--text-sm)",
        }}
      >
        +
      </div>
      <MiniCard x={2} y={132} label="or try it another way" lines={[45, 30]} />
      <MiniCard x={242} y={132} label="or try it another way" lines={[60, 40]} />
    </div>
  );
}

const STARTERS = ["starter.1", "starter.2", "starter.3"] as const;

export function StarterChips({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        gap: "var(--space-2)",
        marginTop: "var(--space-3)",
      }}
    >
      {STARTERS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => onPick(copy(key))}
          style={{
            font: "var(--text-xs)",
            color: "var(--text-secondary)",
            background: "var(--surface-2)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-full)",
            padding: "6px 12px",
          }}
        >
          {copy(key)}
        </button>
      ))}
    </div>
  );
}
