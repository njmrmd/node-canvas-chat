"use client";

import { useEffect, useRef, useState } from "react";
import { copy } from "@/lib/canvas/copy";

export type ComposerVariant = "docked" | "centered";

export type ComposerProps = {
  variant: ComposerVariant;
  targetLabel: string | null;
  /** TES-117 investigation: the real node id `targetLabel` was derived from,
   * exposed as `data-composer-target-id` on the badge below so a script (or
   * a person) can read `effectiveComposerTarget`'s actual value without
   * parsing "Node {n}" back into an id. Debug-only — no product behaviour
   * reads this attribute. */
  targetNodeId?: string | null;
  onUnbindTarget?: () => void;
  disabled: boolean;
  disabledPlaceholder?: string;
  initialValue?: string;
  onSend: (text: string) => void;
  composerRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** §7.2 "Esc (in composer) → Return focus to the bound node". Fires after
   * the field blurs itself, so the caller only has to decide where focus goes. */
  onEscape?: () => void;
};

export function Composer(props: ComposerProps) {
  const [value, setValue] = useState(props.initialValue ?? "");
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = props.composerRef ?? localRef;
  const isCentered = props.variant === "centered";

  // TES-117: a Branch click that never reaches its handler (the confirmed
  // root cause — the composer target silently stays on the old node) used to
  // give a user zero feedback either way. This can't detect that specific
  // failure — there's no click to hook into if it never arrives — but it
  // makes every *successful* target change visibly confirmed, so "I clicked
  // Branch and nothing happened" becomes an obvious, actionable signal
  // instead of a silent one. Comparing against last-seen during render (the
  // React-recommended way to derive state from a prop change, see "Adjusting
  // some state when a prop changes") instead of in an effect skips the
  // mount-time transition (no prior target to have "changed" from) without
  // triggering the no-synchronous-setState-in-effect lint rule.
  // `pulseSeq` (not just `justChanged`) drives the effect below so a second
  // real change arriving before the first pulse finishes still gets its own
  // full window — `justChanged` alone would stay `true` across both changes,
  // never re-triggering the effect, so the *first* change's stale timer would
  // cut the *second* change's pulse short. Exactly the case this exists for:
  // Send moves the target to the newest node, then an immediate Branch click
  // moves it again within that same 600ms.
  const currentTargetId = props.targetNodeId ?? null;
  const [justChanged, setJustChanged] = useState(false);
  const [pulseSeq, setPulseSeq] = useState(0);
  const [lastTargetId, setLastTargetId] = useState(currentTargetId);
  if (lastTargetId !== currentTargetId) {
    setLastTargetId(currentTargetId);
    if (currentTargetId !== null) {
      setJustChanged(true);
      setPulseSeq((n) => n + 1);
    }
  }
  useEffect(() => {
    if (!justChanged) return;
    const timer = setTimeout(() => setJustChanged(false), 600);
    return () => clearTimeout(timer);
  }, [justChanged, pulseSeq]);

  // A starter chip (§3) "fills the composer and focuses it; it does not
  // send" — `initialValue` is how the parent hands over that text after
  // mount, so this has to re-sync on change rather than only seeding state
  // once. Skipped once the field has diverged from what was last filled, so
  // this never fights someone who is mid-edit.
  const lastFilledRef = useRef(props.initialValue ?? "");
  useEffect(() => {
    const next = props.initialValue ?? "";
    if (next !== "" && next !== lastFilledRef.current) {
      lastFilledRef.current = next;
      setValue(next);
      ref.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.initialValue]);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed === "" || props.disabled) return;
    props.onSend(trimmed);
    setValue("");
  };

  return (
    <div
      style={{
        width: "100%",
        maxWidth: isCentered ? 560 : 640,
        background: "var(--surface-1)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-xl)",
        boxShadow: isCentered ? "var(--shadow-2)" : "var(--shadow-3)",
        padding: "var(--space-4)",
        opacity: props.disabled ? 0.5 : 1,
        pointerEvents: props.disabled ? "none" : undefined,
      }}
    >
      {!isCentered && props.targetLabel ? (
        <div
          className="cv-composer-target"
          data-composer-target-id={props.targetNodeId ?? undefined}
          data-changed={justChanged ? "true" : undefined}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 24,
            padding: "0 var(--space-2)",
            marginBottom: "var(--space-2)",
            borderRadius: "var(--radius-full)",
            background: "var(--accent-soft)",
            color: "var(--accent)",
            font: "var(--text-xs)",
          }}
        >
          {copy("composer.target", { label: props.targetLabel })}
          {props.onUnbindTarget ? (
            <button
              type="button"
              aria-label="Unbind target"
              onClick={props.onUnbindTarget}
              style={{ color: "inherit", lineHeight: 1 }}
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}

      <textarea
        ref={ref}
        value={value}
        disabled={props.disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            // Cmd/Ctrl+Enter also lands here — it never carries shiftKey — so
            // the old chord keeps working without a separate check. Guard
            // IME composition: confirming a candidate (Japanese/Chinese/
            // Korean input) fires a plain Enter keydown that must not submit.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            submit();
            return;
          }
          if (event.key === "Escape") {
            // Otherwise this bubbles to the canvas surface's own Escape
            // handler, which reads the *just-focused* node (the one
            // `onEscape` below returns focus to) and, if it happens to be
            // streaming, stops it — turning "leave the composer" into a
            // silent, unintended cancel of the response the user just asked
            // for. §7.2 only promises the former.
            event.stopPropagation();
            (event.target as HTMLTextAreaElement).blur();
            props.onEscape?.();
          }
        }}
        placeholder={
          props.disabled
            ? (props.disabledPlaceholder ?? copy("composer.placeholder"))
            : props.targetLabel && !isCentered
              ? copy("composer.placeholder.reply")
              : copy("composer.placeholder")
        }
        rows={isCentered ? 3 : 1}
        style={{
          width: "100%",
          resize: "none",
          font: "var(--text-base)",
          color: "var(--text-primary)",
          minHeight: isCentered ? 72 : 48,
          maxHeight: 200,
          overflowY: "auto",
        }}
      />

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--space-3)" }}>
        <button
          type="button"
          aria-label="Send"
          disabled={props.disabled || value.trim() === ""}
          onClick={submit}
          style={{
            width: 40,
            height: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "var(--radius-full)",
            background: "var(--accent)",
            color: "var(--accent-fg)",
            opacity: value.trim() === "" ? 0.4 : 1,
          }}
        >
          {/* The path's bounding box (4,3)-(12,13) is already geometric
              centre, but the chevron packs far more stroke into its 4px
              band than the single-line shaft below it, so the glyph reads
              top-heavy. Nudge down a hair to correct the optical centre. */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ transform: "translateY(0.5px)" }}>
            <path d="M8 13V3M8 3 4 7M8 3l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
