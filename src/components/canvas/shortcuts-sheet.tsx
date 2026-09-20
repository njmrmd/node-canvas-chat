"use client";

import { useEffect, useRef } from "react";
import { copy } from "@/lib/canvas/copy";

/**
 * §6 `<ShortcutsSheet>`, opened by `?`. A native `<dialog>` rather than a
 * hand-rolled modal: `showModal()` gives focus-trapping, `Esc`-to-close and
 * `::backdrop` for free, which is exactly `role="dialog"` + the trap the spec
 * asks for without re-implementing either.
 */
const ROWS: Array<[string, string]> = [
  ["↑ / ↓ / ← / →", "Move focus to parent / first child / sibling"],
  ["Home / End", "Focus root / most recent leaf"],
  ["Enter (node focused)", "Focus the composer, bound to the focused node"],
  ["B", "Branch from focused node"],
  ["R", "Regenerate focused node"],
  ["C", "Collapse / expand focused node's subtree"],
  ["M", "Collapse / expand focused node's own body to one line"],
  ["Cmd/Ctrl + Alt + arrows", "Resize focused node"],
  ["Delete / Backspace", "Delete focused node + subtree"],
  ["Esc", "Stop generation (node focused, streaming)"],
  ["Enter (in composer)", "Send (Shift + Enter for a new line)"],
  ["Cmd/Ctrl + Z", "Undo last delete"],
  ["+ / −", "Zoom in / out"],
  ["0", "Zoom to fit"],
  ["1", "Zoom to 100%"],
  ["Alt + arrows", "Move focused node 16px"],
  ["Shift + Alt + arrows", "Move focused node 64px"],
  ["L", "Tidy"],
  ["F", "Toggle focus-path"],
  ["T", "Toggle linear view"],
  ["?", "This sheet"],
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      aria-label={copy("shortcuts.title")}
      style={{
        width: 520,
        maxWidth: "calc(100vw - var(--space-6))",
        maxHeight: "calc(100vh - var(--space-10))",
        background: "var(--surface-1)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-xl)",
        boxShadow: "var(--shadow-3)",
        padding: "var(--space-6)",
      }}
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <h2 style={{ font: "var(--text-lg)", letterSpacing: "var(--tracking-lg)", margin: 0 }}>
          {copy("shortcuts.title")}
        </h2>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="cv-focus-ring"
          onClick={() => ref.current?.close()}
          style={{ font: "var(--text-xs)", color: "var(--text-secondary)" }}
        >
          {copy("shortcuts.close")}
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4) var(--space-5)" }}>
        {ROWS.map(([key, action]) => (
          <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <kbd
              style={{
                alignSelf: "flex-start",
                font: "var(--text-xs)",
                color: "var(--text-primary)",
                background: "var(--surface-2)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-sm)",
                padding: "2px 6px",
              }}
            >
              {key}
            </kbd>
            <span style={{ font: "var(--text-xs)", color: "var(--text-secondary)" }}>{action}</span>
          </div>
        ))}
      </div>
    </dialog>
  );
}
