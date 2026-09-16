import Link from "next/link";
import { FieldError } from "@/components/field-error";

/**
 * The shared pieces of the pre-canvas surface — the shell, the alert, the
 * field, the button, the spinner.
 *
 * Everything on sign-up, sign-in and the key screen is built from these, so a
 * change to how an error reads, or to how a disabled control looks, happens
 * once here rather than three times across two components. Tokens live in
 * `globals.css`; nothing below hard-codes a colour.
 *
 * No hooks in this file: it is imported by client components, but none of it
 * needs to be one in its own right.
 */

/** Height that keeps every interactive control at or above the 44px tap target. */
const CONTROL_HEIGHT = "min-h-11";

/**
 * The form's primary action gets 48px on a phone rather than the 44px floor.
 *
 * It is the last thing between a stranger and an account, it is pressed with a
 * thumb at the bottom of a reach, and it is the one control on the screen where
 * a miss costs a retry. Above the tablet breakpoint a pointer is precise and
 * 44px is plenty. (Fitts's Law — size the target that is hardest to hit.)
 */
const PRIMARY_HEIGHT = "min-h-12 md:min-h-11";

/**
 * The page frame. Top-anchored on purpose: an error or a rate-limit notice can
 * appear above the form without the whole screen jumping, which is what a
 * vertically-centred layout does at the exact moment the user is trying to read
 * something new. The single `--measure` here is what makes the three screens
 * share one column width.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh px-6 pt-12 pb-24 sm:pt-20">
      <main className="mx-auto w-full max-w-(--measure)">
        <Link
          href="/"
          className="-mx-2 inline-flex min-h-11 items-center rounded-sm px-2 font-mono text-xs uppercase tracking-[0.18em] text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground"
        >
          Node Canvas Chat
        </Link>

        {children}
      </main>
    </div>
  );
}

export function PageHeading({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="mt-4">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children ? (
        <p className="mt-2 text-pretty text-sm leading-relaxed text-muted">
          {children}
        </p>
      ) : null}
    </header>
  );
}

/*
 * `Alert` and `FieldError` are the only two things in the product that render a
 * message, and they live in their own files because the canvas will reuse them
 * without wanting the rest of this module. Re-exported here so the three
 * pre-canvas screens keep importing their whole vocabulary from one place.
 */
export { Alert, type AlertTone } from "@/components/alert";
export { FieldError } from "@/components/field-error";

/**
 * A labelled input. 16px type is not a style choice — anything smaller makes
 * iOS Safari zoom the viewport on focus, which on the key field drops the user
 * into a magnified page mid-paste.
 */
export function Field({
  ref,
  id,
  label,
  labelHidden,
  error,
  hint,
  note,
  mono,
  onChange,
  ...input
}: {
  /** React 19 takes `ref` as an ordinary prop; no `forwardRef` needed. */
  ref?: React.Ref<HTMLInputElement>;
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  error?: React.ReactNode;
  hint?: string;
  /** Standing copy that stays visible alongside an error, unlike `hint`. */
  note?: string;
  placeholder?: string;
  autoComplete: string;
  autoFocus?: boolean;
  mono?: boolean;
  spellCheck?: boolean;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  disabled: boolean;
  labelHidden?: boolean;
}) {
  const describedBy =
    [
      error ? `${id}-error` : hint ? `${id}-hint` : null,
      note ? `${id}-note` : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className={labelHidden ? "sr-only" : "text-sm font-medium tracking-tight"}
      >
        {label}
      </label>

      <input
        {...input}
        ref={ref}
        id={id}
        name={id}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={[
          CONTROL_HEIGHT,
          // 16px. See the note above.
          "rounded-sm border bg-transparent px-3 py-2 text-base outline-none",
          mono ? "font-mono" : "",
          /*
           * Arbitrary variant on purpose: `aria-invalid` is not one of
           * Tailwind's built-in `aria-*` variants.
           *
           * 2px, not the 1.5px the spec asks for, because **Chrome floors
           * border-width to whole CSS pixels**: measured in Chrome for Testing
           * at both DPR 1 and DPR 2, every value from 1px to 1.99px computes
           * back to 1px, inline styles included. `outline-width` floors the
           * same way. So 1.5px is not a thing this property can express, and
           * the choice is 1px or 2px.
           *
           * `box-shadow` *can* hold 1.5px, but an inset ring overwrites the
           * focus ring — measured: the focus indicator disappears entirely on
           * an invalid field — and losing the focus outline to gain half a
           * pixel is a bad trade.
           *
           * The point of the rule is that at 1px in --danger the field reads as
           * slightly warm rather than broken; 2px is the nearest weight the
           * platform will actually draw. It shifts no layout: the outer box
           * measures 448x44 at 1px and at 2px alike.
           */
          "border-border-input aria-[invalid=true]:border-2 aria-[invalid=true]:border-danger",
          "focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          /*
           * An invalid control's focus ring takes the tone.
           *
           * This is not a garnish on an edge case. §4 moves focus to the first
           * invalid control on every field error, so a focused invalid field is
           * the *default* presentation — it is the state the person lands in
           * before they have read a word. Left neutral, the element wears three
           * concentric bands whose outermost and heaviest is the one carrying
           * chrome rather than state: in light a near-black ring outranks the
           * red and the danger border reads as an inner hairline, and in dark it
           * is a white ring around a pale red border on black, which reads
           * "focused" and nothing else. The one field we deliberately sent them
           * to was the one where "invalid" was hardest to see.
           *
           * Toned, the ring and the border agree instead of competing. The 2px
           * offset stays: without it the two rings merge into a 4px slab and the
           * field starts reading as a control again.
           *
           * (Norman: signifiers — the strongest visual signal on an element has
           * to be the one that carries the state.)
           */
          "aria-[invalid=true]:focus-visible:ring-danger",
          "disabled:border-hairline disabled:bg-control-disabled disabled:text-control-disabled-foreground disabled:cursor-not-allowed",
        ].join(" ")}
      />

      {/*
       * The error replaces the hint; it never stacks under it. Two lines of
       * small print where one used to be, only one of which is the problem, is
       * how a field error gets skipped.
       */}
      {error ? (
        <FieldError id={`${id}-error`}>{error}</FieldError>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}

      {note ? (
        <p id={`${id}-note`} className="text-xs leading-relaxed text-muted">
          {note}
        </p>
      ) : null}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "quiet" | "destructive";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-foreground text-background border border-foreground hover:opacity-90",
  secondary:
    "border border-border-input text-foreground hover:border-foreground",
  quiet: "border border-transparent text-muted hover:text-foreground",
  destructive:
    "border border-danger-border text-danger hover:bg-danger-surface",
};

/**
 * Disabled is a state, not a dimmed enabled button. A flat surface, muted text
 * and `cursor-not-allowed` say "not available" from across the room; the old
 * `opacity-50` treatment just looked like the button had lost contrast.
 */
const DISABLED =
  "disabled:border-hairline disabled:bg-control-disabled disabled:text-control-disabled-foreground disabled:cursor-not-allowed disabled:opacity-100 disabled:hover:opacity-100";

export function Button({
  variant = "primary",
  full,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  full?: boolean;
}) {
  return (
    <button
      {...props}
      className={[
        // `full` marks the form's primary submit — see PRIMARY_HEIGHT.
        full ? PRIMARY_HEIGHT : CONTROL_HEIGHT,
        "inline-flex items-center justify-center gap-2 rounded-sm px-4 text-sm font-medium outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        VARIANTS[variant],
        DISABLED,
        full ? "w-full" : "",
        className ?? "",
      ].join(" ")}
    />
  );
}

/** A link that carries the weight of a primary action. */
export function ButtonLink({
  href,
  children,
  variant = "primary",
  full,
}: {
  href: string;
  children: React.ReactNode;
  variant?: ButtonVariant;
  full?: boolean;
}) {
  return (
    <Link
      href={href}
      className={[
        CONTROL_HEIGHT,
        "inline-flex items-center justify-center gap-2 rounded-sm px-4 text-sm font-medium outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        VARIANTS[variant],
        full ? "w-full" : "",
      ].join(" ")}
    >
      {children}
    </Link>
  );
}

/**
 * An inline text link with a 48px-tall hit area and ink that does not move.
 *
 * The padding grows the target and the matching negative margin gives the space
 * back to the layout, so the sentence keeps its baseline and its line spacing
 * while the tappable box around "Sign in" goes from 44×18 to roughly 52×48.
 *
 * The alternative — making the footer link look like a button — would put a
 * second button-shaped thing at the end of the flow competing with the actual
 * primary. Size the target, not the ink. (Fitts's Law again.)
 */
export function TextLink({
  href,
  external,
  children,
}: {
  href: string;
  external?: boolean;
  children: React.ReactNode;
}) {
  const className =
    "-my-[13px] -mx-1 inline-block rounded-sm px-1 py-[13px] underline decoration-hairline underline-offset-4 outline-none hover:decoration-current focus-visible:ring-2 focus-visible:ring-foreground";

  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={className}
      >
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

export function Spinner() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      className="animate-spin"
    >
      <circle
        cx="8"
        cy="8"
        r="6.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.25"
      />
      <path
        d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}


