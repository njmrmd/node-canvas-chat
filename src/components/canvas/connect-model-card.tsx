"use client";

import { copy } from "@/lib/canvas/copy";

/**
 * §4.8 `<ConnectModelCard>`.
 *
 * Links out to `/keys` rather than embedding key entry inline: that screen is
 * the real, already-built connection flow (Platform Engineer's — see
 * `KeyManager`), and duplicating a second copy of key-entry UI inside the
 * canvas would be the parallel-design-language mistake the brief warns
 * against. §4.8 itself says the connection screen is "not in this document";
 * this card is only the canvas-side entry point, which a link satisfies.
 */
export function ConnectModelCard() {
  return (
    <div
      style={{
        width: 560,
        maxWidth: "100%",
        background: "var(--surface-1)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-2)",
        padding: "var(--space-5)",
      }}
    >
      <h2 style={{ font: "var(--text-lg)", letterSpacing: "var(--tracking-lg)", color: "var(--text-primary)", margin: 0 }}>
        {copy("provider.headline")}
      </h2>
      <p style={{ font: "var(--text-sm)", color: "var(--text-secondary)", marginTop: "var(--space-2)" }}>
        {copy("provider.sub")}
      </p>
      <a
        href="/keys"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          height: 44,
          padding: "0 var(--space-4)",
          marginTop: "var(--space-4)",
          borderRadius: "var(--radius-md)",
          background: "var(--accent)",
          color: "var(--accent-fg)",
          font: "var(--text-sm)",
          fontWeight: 500,
        }}
      >
        {copy("provider.cta")}
      </a>
    </div>
  );
}
