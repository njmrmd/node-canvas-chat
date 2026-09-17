"use client";

import { useEffect, useRef, useState } from "react";
import type { ConversationNode } from "@/lib/conversation/graph";
import { copy } from "@/lib/canvas/copy";

/**
 * §6 `<LinearView>` — "the accessible equivalent of the spatial view", opened
 * by `T`. Renders the root → selected path (already computed by the caller
 * via `pathToRoot`) as a plain transcript, because that path is exactly what
 * gets sent to the model (§1.3) — this panel is that request, made readable.
 */
export function LinearView({
  path,
  onClose,
}: {
  path: ConversationNode[];
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const transcript = path
    .map((node) => `You: ${node.prompt}\n\nAssistant: ${node.response}`)
    .join("\n\n---\n\n");

  const copyAll = () => {
    navigator.clipboard.writeText(transcript).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      ref={panelRef}
      role="region"
      aria-label={copy("linearview.heading")}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "t" || event.key === "T") {
          event.preventDefault();
          onClose();
        }
      }}
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: 480,
        maxWidth: "100%",
        background: "var(--surface-1)",
        borderLeft: "1px solid var(--border-subtle)",
        boxShadow: "var(--shadow-3)",
        zIndex: "var(--z-popover)",
        display: "flex",
        flexDirection: "column",
        outline: "none",
      }}
    >
      <div
        style={{
          height: 56,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          padding: "0 var(--space-5)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <span style={{ font: "var(--text-lg)", letterSpacing: "var(--tracking-lg)", color: "var(--text-primary)" }}>
          {copy("linearview.heading")}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={copyAll}
          className="cv-focus-ring"
          style={{
            height: 36,
            padding: "0 var(--space-3)",
            borderRadius: "var(--radius-md)",
            background: "var(--surface-2)",
            color: "var(--text-secondary)",
            font: "var(--text-xs)",
          }}
        >
          {copied ? "Copied" : copy("linearview.copyAll")}
        </button>
        <button
          type="button"
          aria-label={copy("linearview.close")}
          onClick={onClose}
          className="cv-focus-ring"
          style={{ width: 36, height: 36, borderRadius: "var(--radius-md)", color: "var(--text-secondary)" }}
        >
          ×
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "var(--space-5)" }}>
        {path.map((node, index) => (
          <div key={node.id} style={{ marginTop: index === 0 ? 0 : "var(--space-5)" }}>
            <p style={{ font: "var(--text-sm)", fontWeight: "var(--weight-user-text)", color: "var(--text-primary)", margin: 0, whiteSpace: "pre-wrap" }}>
              {node.prompt}
            </p>
            <p style={{ font: "var(--text-sm)", fontWeight: "var(--weight-assistant-text)", color: "var(--text-secondary)", marginTop: "var(--space-2)", whiteSpace: "pre-wrap" }}>
              {node.response || "…"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
