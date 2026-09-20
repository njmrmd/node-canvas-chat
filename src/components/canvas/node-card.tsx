"use client";

import { useEffect, useRef, useState } from "react";
import type { ConversationNode } from "@/lib/conversation/graph";
import { presentError } from "@/lib/canvas/errors";
import { CONTINUE_PROMPT } from "@/lib/canvas/use-canvas-controller";
import { copy } from "@/lib/canvas/copy";
import { renderMarkdown } from "@/lib/canvas/markdown";

/** §6 `<NodeCard>`. */
export const NODE_WIDTH_DESKTOP = 320;
export const NODE_WIDTH_MOBILE = 288;

const FIRST_TOKEN_SLOW_MS = 8000;

function StatusChip({
  tone,
  children,
  spinner,
}: {
  tone: "neutral" | "danger";
  children: React.ReactNode;
  spinner?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 20,
        padding: "0 var(--space-2)",
        borderRadius: "var(--radius-full)",
        font: "var(--text-xs)",
        letterSpacing: "var(--tracking-xs)",
        background: tone === "danger" ? "rgba(255,107,107,0.12)" : "var(--surface-2)",
        color: tone === "danger" ? "var(--danger)" : "var(--text-secondary)",
      }}
    >
      {spinner ? (
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="cv-spin">
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
          <path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : null}
      {children}
    </span>
  );
}

function IconButton({
  label,
  onClick,
  tone,
  children,
}: {
  label: string;
  onClick: (event: React.MouseEvent) => void;
  tone?: "delete";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`cv-icon-button cv-action-button${tone === "delete" ? " cv-action-delete" : ""} cv-focus-ring`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick(event);
      }}
      style={{
        width: 32,
        height: 32,
        position: "relative",
        borderRadius: "var(--radius-sm)",
        color: "var(--text-secondary)",
      }}
    >
      {/* 44×44 hit area via an invisible overlay, per §7.4. */}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: -6,
        }}
      />
      {children}
    </button>
  );
}

export type NodeCardProps = {
  node: ConversationNode;
  width: number;
  /** TES-90: an explicit, user-resized height — `null` means "size to
   * content", the pre-resize behaviour (`minHeight`/`maxHeight` below). */
  height: number | null;
  isSelected: boolean;
  tabIndex: number;
  childCount: number;
  depth: number;
  siblingIndex: number;
  siblingCount: number;
  queueAhead: number | null;
  streamStartedAt: number | null;
  canBranch: boolean;
  branchDisabledReason: string | null;
  onSelect: () => void;
  onFocusNode: () => void;
  onBranch: () => void;
  onRegenerate: () => void;
  onEditSubmit: (text: string) => void;
  onDelete: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onContinue: () => void;
  onStop: () => void;
  onToggleCollapsed: () => void;
  onToggleBodyCollapsed: () => void;
  onPointerDownCard: (event: React.PointerEvent) => void;
  onPointerDownResizeHandle: (event: React.PointerEvent) => void;
  onRegisterRef: (id: string, element: HTMLDivElement | null) => void;
  showFirstRunPulse: boolean;
};

export function NodeCard(props: NodeCardProps) {
  const { node, onRegisterRef } = props;
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(node.prompt);
  const [now, setNow] = useState(() => Date.now());

  // `onRegisterRef` arrives as a prop, so it cannot be handed straight to the
  // JSX `ref` attribute — the element itself is the only thing that may read
  // a ref during render. A locally-owned ref attaches cleanly, and an effect
  // reports it (and its removal) to the parent's registry outside render.
  //
  // Takes `node.id` rather than closing over it so the parent can hand every
  // card the same function reference (TES-99): a per-card closure built fresh
  // each render would change identity every time, re-running this effect
  // (unobserve + re-observe) on every unrelated re-render of the canvas.
  const elementRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    onRegisterRef(node.id, elementRef.current);
    return () => onRegisterRef(node.id, null);
  }, [onRegisterRef, node.id]);

  const isQueued = node.status === "draft";
  const isStreaming = node.status === "streaming";
  const isThinkingOnly = isStreaming && node.response === "" && node.thinking === "";

  useEffect(() => {
    if (!isThinkingOnly) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isThinkingOnly]);

  const isContinuation = node.prompt === CONTINUE_PROMPT;
  const errorPresentation = node.error ? presentError(node.error) : null;

  // TES-90: the card's own body collapsed to one line, independent of
  // `node.collapsed` (which hides descendants instead — see `onToggleCollapsed`).
  const isBodyCollapsed = node.bodyCollapsed;
  const collapsedSummary = (() => {
    const firstLine = node.response.split("\n").find((line) => line.trim() !== "");
    if (firstLine) return firstLine.trim();
    if (node.status === "error" && errorPresentation) return errorPresentation.message;
    if (isQueued || isStreaming) return copy("node.status.thinking");
    return node.prompt;
  })();

  const statusChip = (() => {
    if (isQueued) {
      return (
        <StatusChip tone="neutral">
          {props.queueAhead && props.queueAhead > 0
            ? copy("node.status.queued", { n: props.queueAhead })
            : copy("node.status.thinking")}
        </StatusChip>
      );
    }
    if (isStreaming) {
      if (isThinkingOnly) {
        const elapsed = props.streamStartedAt ? now - props.streamStartedAt : 0;
        return (
          <StatusChip tone="neutral" spinner>
            {elapsed > FIRST_TOKEN_SLOW_MS
              ? copy("node.status.thinkingLong")
              : copy("node.status.thinking")}
          </StatusChip>
        );
      }
      return (
        <button
          type="button"
          className="cv-focus-ring"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            props.onStop();
          }}
          aria-label="Stop generating"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 44,
            height: 24,
            borderRadius: "var(--radius-full)",
            background: "var(--surface-2)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            font: "var(--text-2xs)",
          }}
        >
          Stop
        </button>
      );
    }
    if (node.status === "interrupted") {
      return <StatusChip tone="neutral">{copy("node.status.stopped")}</StatusChip>;
    }
    if (node.status === "error" && errorPresentation) {
      return <StatusChip tone="danger">{errorPresentation.category}</StatusChip>;
    }
    return null;
  })();

  const ariaLabel = `Node, ${props.depth} deep, ${props.childCount} branch${props.childCount === 1 ? "" : "es"}, ${node.status}`;

  return (
    <div
      ref={elementRef}
      data-node-id={node.id}
      data-node-role="card"
      role="group"
      aria-label={ariaLabel}
      aria-current={props.isSelected ? "true" : undefined}
      tabIndex={props.tabIndex}
      onFocus={props.onFocusNode}
      onPointerDown={(event) => {
        // Interactive descendants stop propagation themselves; anything else
        // over the card body is a select-and-maybe-drag (§2.2).
        props.onPointerDownCard(event);
      }}
      onClick={() => props.onSelect()}
      className="cv-node cv-focus-ring"
      style={{
        position: "relative",
        width: props.width,
        minHeight: 96,
        // TES-90: a body-collapsed card always sizes to its one line,
        // regardless of any manual resize — showing a tall, mostly-empty
        // card would defeat the point of collapsing it.
        height: isBodyCollapsed ? undefined : (props.height ?? undefined),
        maxHeight: isBodyCollapsed ? undefined : (props.height ?? 420),
        display: "flex",
        flexDirection: "column",
        background: "var(--surface-1)",
        border: `1px solid ${node.status === "error" ? "var(--danger)" : "var(--border-default)"}`,
        borderRadius: "var(--radius-lg)",
        boxShadow: props.isSelected ? "var(--shadow-2), inset 0 0 0 2px var(--accent)" : "var(--shadow-1)",
        padding: "var(--space-4)",
        cursor: "pointer",
        // Not `overflow: hidden` — the branch handle overhangs the bottom
        // edge by design (§6) and would be clipped. The body region below
        // handles its own overflow instead (`minHeight: 0` is the flexbox
        // trick that lets it actually shrink and scroll rather than pushing
        // the card taller than `maxHeight`).
      }}
    >
      {/* Header */}
      <div style={{ height: 24, display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        {statusChip}
        <div style={{ flex: 1 }} />
        <div className="cv-node-actions" style={{ display: "flex", gap: "var(--space-1)" }}>
          {node.status === "error" ? (
            <>
              <IconButton label={copy("node.action.retry")} onClick={props.onRetry}>
                <RetryIcon />
              </IconButton>
              <IconButton
                label={isBodyCollapsed ? "Show full reply" : "Collapse to one line"}
                onClick={props.onToggleBodyCollapsed}
              >
                <FoldIcon collapsed={isBodyCollapsed} />
              </IconButton>
              <IconButton label={copy("node.action.remove")} onClick={props.onRemove} tone="delete">
                <TrashIcon />
              </IconButton>
            </>
          ) : (
            <>
              <IconButton label={copy("node.action.branch")} onClick={props.onBranch}>
                <BranchIcon />
              </IconButton>
              {node.status === "complete" ? (
                <IconButton label={copy("node.action.regenerate")} onClick={props.onRegenerate}>
                  <RegenerateIcon />
                </IconButton>
              ) : null}
              {node.status !== "streaming" && node.status !== "draft" ? (
                <IconButton
                  label="Edit"
                  onClick={() => {
                    setEditText(node.prompt);
                    setEditing(true);
                  }}
                >
                  <EditIcon />
                </IconButton>
              ) : null}
              {/* TES-90: collapses this card's own body to one line — every
               * card gets this, unlike the subtree-collapse chevron below,
               * which only appears once there is a subtree to hide. A
               * distinct icon (arrows meeting vs. a single chevron) so the
               * two aren't mistaken for the same control. Design Engineer
               * to confirm the affordance and icon language. */}
              <IconButton
                label={isBodyCollapsed ? "Show full reply" : "Collapse to one line"}
                onClick={props.onToggleBodyCollapsed}
              >
                <FoldIcon collapsed={isBodyCollapsed} />
              </IconButton>
              {props.childCount > 0 ? (
                <IconButton
                  label={node.collapsed ? `Expand (${props.childCount})` : "Collapse"}
                  onClick={props.onToggleCollapsed}
                >
                  <ChevronIcon down={!node.collapsed} />
                </IconButton>
              ) : null}
              <IconButton label="Delete" onClick={props.onDelete} tone="delete">
                <TrashIcon />
              </IconButton>
            </>
          )}
        </div>
      </div>

      {/* Body — TES-89: `data-canvas-role="card-body"` lets the canvas
       * surface's wheel handler tell "scroll this" from "pan the canvas"
       * apart, and `touchAction: "pan-y"` overrides the surface's
       * `touchAction: "none"` (canvas-app.tsx) so a touch scroll that starts
       * here is native, not the surface's own pan/drag simulation. */}
      <div
        data-canvas-role="card-body"
        style={{
          marginTop: "var(--space-3)",
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          borderRadius: "var(--radius-lg)",
          touchAction: "pan-y",
        }}
      >
        {editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <textarea
              autoFocus
              value={editText}
              onChange={(event) => setEditText(event.target.value)}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") setEditing(false);
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  props.onEditSubmit(editText);
                  setEditing(false);
                }
              }}
              style={{
                font: "var(--text-sm)",
                color: "var(--text-primary)",
                background: "var(--surface-2)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-sm)",
                padding: "var(--space-2)",
                resize: "vertical",
                minHeight: 60,
              }}
            />
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onEditSubmit(editText);
                  setEditing(false);
                }}
                style={{
                  font: "var(--text-xs)",
                  color: "var(--accent-fg)",
                  background: "var(--accent)",
                  borderRadius: "var(--radius-sm)",
                  padding: "4px 10px",
                }}
              >
                Save as new
              </button>
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setEditing(false);
                }}
                style={{ font: "var(--text-xs)", color: "var(--text-secondary)" }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : isBodyCollapsed ? (
          <p
            style={{
              font: "var(--text-sm)",
              fontWeight: "var(--weight-assistant-text)",
              color: "var(--text-primary)",
              margin: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {collapsedSummary}
          </p>
        ) : (
          <>
            <p
              style={{
                font: "var(--text-sm)",
                fontWeight: "var(--weight-user-text)",
                color: "var(--text-primary)",
                margin: 0,
                display: "-webkit-box",
                WebkitLineClamp: 4,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {isContinuation ? (
                <span style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>
                  {copy("node.continuedFrom")}
                </span>
              ) : (
                node.prompt
              )}
            </p>

            <div
              style={{
                margin: "var(--space-3) 0",
                borderTop: "1px solid var(--border-subtle)",
              }}
            />

            {isQueued || (isStreaming && isThinkingOnly) ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="cv-skeleton-bar" style={{ height: 10, width: "100%", borderRadius: "var(--radius-full)" }} />
                <div className="cv-skeleton-bar" style={{ height: 10, width: "92%", borderRadius: "var(--radius-full)" }} />
                <div className="cv-skeleton-bar" style={{ height: 10, width: "64%", borderRadius: "var(--radius-full)" }} />
              </div>
            ) : node.status === "error" ? (
              <p style={{ font: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
                {errorPresentation?.message}
                {errorPresentation?.errorCode === "auth" ? (
                  <>
                    {" "}
                    <a href="/keys" style={{ color: "var(--accent)" }}>
                      {copy("node.action.openSettings")}
                    </a>
                  </>
                ) : null}
              </p>
            ) : (
              <div
                style={{
                  font: "var(--text-sm)",
                  fontWeight: "var(--weight-assistant-text)",
                  color: "var(--text-primary)",
                }}
              >
                {renderMarkdown(
                  node.response,
                  isStreaming ? (
                    <span
                      className="cv-caret"
                      style={{
                        display: "inline-block",
                        width: 2,
                        height: "1.1em",
                        background: "var(--accent)",
                        verticalAlign: "text-bottom",
                        marginLeft: 1,
                      }}
                    />
                  ) : undefined,
                )}
              </div>
            )}
          </>
        )}
      </div>

      {node.status === "interrupted" ? (
        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
          {node.response.trim() !== "" ? (
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                props.onContinue();
              }}
              style={{
                font: "var(--text-xs)",
                fontWeight: 500,
                color: "var(--accent-fg)",
                background: "var(--accent)",
                borderRadius: "var(--radius-sm)",
                padding: "6px 10px",
              }}
            >
              {copy("node.action.continue")}
            </button>
          ) : null}
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              props.onRegenerate();
            }}
            style={{
              font: "var(--text-xs)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-sm)",
              padding: "6px 10px",
            }}
          >
            {copy("node.action.regenerate")}
          </button>
        </div>
      ) : null}

      {/* Branch handle: bottom edge, 50% overhanging. */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: -14,
          transform: "translateX(-50%)",
        }}
      >
        <button
          type="button"
          className={`cv-branch-handle cv-focus-ring`}
          data-pulse={props.showFirstRunPulse ? "true" : undefined}
          data-force-visible={props.showFirstRunPulse ? "true" : undefined}
          disabled={!props.canBranch}
          title={props.canBranch ? copy("node.action.branch") : props.branchDisabledReason ?? undefined}
          aria-label={copy("node.action.branch")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (props.canBranch) props.onBranch();
          }}
          style={{
            width: 28,
            height: 28,
            borderRadius: "var(--radius-full)",
            background: "var(--surface-3)",
            border: "1px solid var(--border-strong)",
            color: "var(--text-secondary)",
            opacity: props.canBranch ? undefined : 0.4,
            cursor: props.canBranch ? "pointer" : "not-allowed",
          }}
        >
          +
        </button>
      </div>

      {/* TES-90: corner resize handle, bottom-right, overhanging like the
       * branch handle. Drag math (pointer capture, zoom-adjusted delta,
       * min/max clamping) lives in canvas-app.tsx next to the equivalent
       * node-drag handling; this is just the affordance. */}
      {!isBodyCollapsed ? (
        <button
          type="button"
          className="cv-resize-handle cv-focus-ring"
          aria-label="Resize card"
          title="Drag to resize"
          onPointerDown={(event) => {
            event.stopPropagation();
            props.onPointerDownResizeHandle(event);
          }}
          style={{
            position: "absolute",
            right: -6,
            bottom: -6,
            width: 20,
            height: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "var(--radius-sm)",
            background: "transparent",
            color: "var(--text-tertiary)",
            cursor: "nwse-resize",
            touchAction: "none",
          }}
        >
          <ResizeIcon />
        </button>
      ) : null}
    </div>
  );
}

// Small inline icon set — 16px glyphs, currentColor, no external asset.
function BranchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5 3v4a2 2 0 0 0 2 2h2a2 2 0 0 1 2 2v2M5 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM11 11a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
function RegenerateIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13 4.5V7h-2.5M3 11.5V9h2.5M4 7a4 4 0 0 1 7-2.5l2 1.5M12 9a4 4 0 0 1-7 2.5l-2-1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function EditIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M11.5 2.5 13.5 4.5 5 13H3v-2L11.5 2.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5 5 13a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function RetryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.6-3.65M13 2.5V5h-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
/** TES-90: this card's own body, collapsed to one line — arrows meeting
 * (collapsed) or pulling apart (expanded). Deliberately not `ChevronIcon`,
 * which already means "hide my children" elsewhere on this card. */
function FoldIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {collapsed ? (
        <path
          d="M4 6.5 8 3l4 3.5M4 12.5l4-3.5 4 3.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M4 4 8 7.5 12 4M4 15l4-3.5 4 3.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
function ResizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M12 12 8 12M12 12 12 8M12 12 5 5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
function ChevronIcon({ down }: { down: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ transform: down ? undefined : "rotate(-90deg)" }}
    >
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
