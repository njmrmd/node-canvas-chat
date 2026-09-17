"use client";

import { copy } from "@/lib/canvas/copy";
import type { RateLimitSnapshot } from "@/lib/api-client";
import type { ModelSpec } from "@/lib/providers/registry";

export type TopBarProps = {
  showCanvasControls: boolean;
  rateLimit: RateLimitSnapshot | null;
  models: ModelSpec[];
  model: string;
  onModelChange: (id: string) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomToFit: () => void;
  onTidy: () => void;
  zoomPercent: number;
  email: string;
};

function usageTone(percentUsed: number): string {
  if (percentUsed >= 100) return "var(--danger)";
  if (percentUsed >= 80) return "var(--warning)";
  return "var(--accent)";
}

export function TopBar(props: TopBarProps) {
  const { rateLimit } = props;
  const percentUsed = rateLimit
    ? ((rateLimit.limit - rateLimit.remaining) / Math.max(1, rateLimit.limit)) * 100
    : 0;
  const showUsageChip = rateLimit !== null && percentUsed >= 60;

  return (
    <header
      style={{
        height: 56,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "0 var(--space-5)",
        background: "color-mix(in srgb, var(--surface-1) 86%, transparent)",
        backdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--border-subtle)",
        position: "relative",
        zIndex: "var(--z-chrome)",
      }}
    >
      {/*
       * §6.1 specs a distinct 48px mobile top bar (wordmark, usage chip,
       * overflow menu; model selector moves into the overflow) that this
       * component does not yet build — flagged to Design Engineer as a
       * follow-up rather than approximated here. This truncation is the
       * narrower fix: at 390px the four siblings after the wordmark already
       * do not fit, and a flex child needs an explicit `minWidth: 0` to be
       * allowed to shrink below its text's natural width at all — without it
       * the wordmark wraps to three lines and blows out the fixed 56px
       * height instead of eliding.
       */}
      <span
        style={{
          font: "var(--text-xs)",
          letterSpacing: "var(--tracking-xs)",
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        Node Canvas Chat
      </span>

      <div style={{ flex: 1 }} />

      {showUsageChip ? (
        <div
          title={copy("limit.chip", { used: rateLimit!.limit - rateLimit!.remaining, total: rateLimit!.limit })}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 28,
            padding: "0 var(--space-3)",
            borderRadius: "var(--radius-full)",
            background: "var(--surface-2)",
            color: usageTone(percentUsed),
            font: "var(--text-xs)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="var(--border-default)" strokeWidth="2" />
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={`${(Math.min(100, percentUsed) / 100) * 37.7} 37.7`}
              strokeLinecap="round"
              transform="rotate(-90 8 8)"
            />
          </svg>
          {copy("limit.chip", { used: rateLimit!.limit - rateLimit!.remaining, total: rateLimit!.limit })}
        </div>
      ) : null}

      {props.showCanvasControls && props.models.length > 1 ? (
        <select
          value={props.model}
          onChange={(event) => props.onModelChange(event.target.value)}
          aria-label="Model"
          style={{
            height: 36,
            borderRadius: "var(--radius-md)",
            background: "var(--surface-1)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            font: "var(--text-xs)",
            padding: "0 var(--space-2)",
          }}
        >
          {props.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      ) : null}

      {props.showCanvasControls ? (
        <button
          type="button"
          onClick={props.onTidy}
          title="Tidy (L)"
          style={{
            height: 36,
            padding: "0 var(--space-3)",
            borderRadius: "var(--radius-md)",
            background: "var(--surface-1)",
            border: "1px solid var(--border-default)",
            color: "var(--text-secondary)",
            font: "var(--text-xs)",
          }}
        >
          Tidy
        </button>
      ) : null}

      {props.showCanvasControls ? (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={props.onZoomOut}
            style={{ width: 36, height: 36, borderRadius: "var(--radius-md)", background: "var(--surface-1)", border: "1px solid var(--border-default)", color: "var(--text-secondary)" }}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Zoom to fit"
            onClick={props.onZoomToFit}
            title="Zoom to fit (0)"
            style={{ width: 36, height: 36, borderRadius: "var(--radius-md)", background: "var(--surface-1)", border: "1px solid var(--border-default)", color: "var(--text-secondary)", font: "var(--text-2xs)" }}
          >
            {props.zoomPercent}%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={props.onZoomIn}
            style={{ width: 36, height: 36, borderRadius: "var(--radius-md)", background: "var(--surface-1)", border: "1px solid var(--border-default)", color: "var(--text-secondary)" }}
          >
            +
          </button>
        </div>
      ) : null}

      {/* §6.1's real answer is an account-menu icon, not a printed address —
       * flagged alongside the mobile top-bar gap above. This truncates the
       * placeholder in the meantime so a long email cannot repeat the
       * wordmark's 3-line overflow. */}
      <span
        style={{
          font: "var(--text-xs)",
          color: "var(--text-tertiary)",
          minWidth: 0,
          maxWidth: 160,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {props.email}
      </span>
    </header>
  );
}
