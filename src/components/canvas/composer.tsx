"use client";

import { useEffect, useRef, useState } from "react";
import { copy } from "@/lib/canvas/copy";

export type ComposerVariant = "docked" | "centered";

export type ComposerProps = {
  variant: ComposerVariant;
  targetLabel: string | null;
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
        padding: "var(--space-3)",
        opacity: props.disabled ? 0.5 : 1,
        pointerEvents: props.disabled ? "none" : undefined,
      }}
    >
      {!isCentered && props.targetLabel ? (
        <div
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
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
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

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--space-2)" }}>
        <button
          type="button"
          aria-label="Send"
          disabled={props.disabled || value.trim() === ""}
          onClick={submit}
          style={{
            width: 40,
            height: 40,
            borderRadius: "var(--radius-full)",
            background: "var(--accent)",
            color: "var(--accent-fg)",
            opacity: value.trim() === "" ? 0.4 : 1,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 13V3M8 3 4 7M8 3l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
