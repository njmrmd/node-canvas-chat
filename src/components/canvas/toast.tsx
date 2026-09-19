"use client";

/**
 * §6 `<Toast>`. Auto-dismiss is the caller's job, not this component's — for
 * the one toast the canvas currently raises (§1.5's delete undo), the
 * controller already runs the 8s `deletedToast` timer that this component's
 * lifetime is bound to, so a second timer in here would just be a second
 * clock to keep in sync with the first.
 */
export function Toast({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      role="status"
      className="cv-toast"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        background: "var(--surface-3)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-3)",
        padding: "var(--space-3) var(--space-4)",
        font: "var(--text-sm)",
        color: "var(--text-primary)",
      }}
    >
      <span>{message}</span>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="cv-focus-ring"
          style={{ font: "var(--text-sm)", fontWeight: 500, color: "var(--accent)" }}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
