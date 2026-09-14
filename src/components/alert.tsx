/**
 * The form-level message. One per form, at the top of it, above the first
 * field — never two at once.
 *
 * The rule this component exists to enforce: **a message is never shaped like a
 * control.** The old banner was `rounded-md border border-hairline px-3 py-2
 * text-sm` — byte for byte the input treatment minus the value — so three
 * identical rectangles stacked down the column and nothing said which one was
 * the problem. Four signals separate a message from a field here, and they are
 * deliberately redundant, because any one of them read alone still works:
 *
 *   - radius 10px against the controls' 6px,
 *   - a tonal fill where a control has none,
 *   - a 3px tonal rail on the inline-start edge,
 *   - an icon, always, in the tone.
 *
 * Redundancy is the point: it survives greyscale, it survives a squint, and it
 * survives someone scanning rather than reading.
 *
 * Body copy is never set in the tone colour. Red-on-pink paragraphs are the
 * other failure mode — the tone lives in the rail, the icon and the title, and
 * the sentence itself stays `--foreground` so it reads like prose.
 */

/**
 * Three tones, and they answer a question rather than grading a severity.
 *
 * A stranger cannot learn a five-colour severity vocabulary during sign-up and
 * does not need to: the only distinction that changes what they do next is
 * *act* versus *wait*.
 *
 * - `error` — *can I do something about it?* Yes, and the copy says what.
 * - `wait`  — *is it me?* No. Time fixes this; effort does not. Rate limits,
 *   our outages, our misconfiguration. Our fault must never be dressed as the
 *   user's mistake.
 * - `ok`    — *did it work?* Yes, and here is what changed.
 */
export type AlertTone = "error" | "wait" | "ok";

type ToneStyle = {
  container: string;
  accent: string;
  /** The action button's 1px hairline, in the tone but not of it. */
  line: string;
  /** `alert` interrupts; `status` does not. A success is not an interruption. */
  role: "alert" | "status";
};

const TONES: Record<AlertTone, ToneStyle> = {
  error: {
    container: "border-danger-line border-l-danger bg-danger-surface",
    accent: "text-danger",
    line: "border-danger-line hover:border-danger",
    role: "alert",
  },
  wait: {
    container: "border-warning-line border-l-warning bg-warning-surface",
    accent: "text-warning",
    line: "border-warning-line hover:border-warning",
    role: "alert",
  },
  ok: {
    container: "border-success-line border-l-success bg-success-surface",
    accent: "text-success",
    line: "border-success-line hover:border-success",
    role: "status",
  },
};

export function Alert({
  tone,
  title,
  id,
  action,
  children,
}: {
  tone: AlertTone;
  /**
   * Four to six words. Required whenever the body runs past one line — it is
   * the thing that gets read when nothing gets read.
   */
  title?: string;
  id?: string;
  /**
   * At most one, and only where retrying is the literal fix ("Reload the
   * page", "Try again"). An action that is not the fix is just noise on top of
   * a failure.
   */
  action?: { label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  const styles = TONES[tone];

  return (
    <div
      id={id}
      role={styles.role}
      className={[
        "grid grid-cols-[16px_1fr] items-start gap-2.5",
        // 10px, against the 6px on every control. See the note at the top.
        "rounded-md border border-l-[3px] px-3.5 py-3",
        "text-sm leading-relaxed",
        // Enters from -4px with no height animation: animating layout is what
        // makes a form feel like it is collapsing. Exit is instant, and
        // `motion-reduce` drops the transform and the duration together.
        "motion-safe:animate-[alert-enter_var(--dur-base)_var(--ease-out)]",
        styles.container,
      ].join(" ")}
    >
      {/* 3px optical nudge puts the icon on the first line's cap height. */}
      <span className={`mt-[3px] ${styles.accent}`}>
        <AlertIcon tone={tone} />
      </span>

      <div className="min-w-0">
        {title ? (
          <p className={`mb-0.5 font-semibold ${styles.accent}`}>{title}</p>
        ) : null}

        {/* Body stays --foreground. The tone is carried by rail, icon, title. */}
        <div className="text-foreground">{children}</div>

        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            className={[
              // 44px below the tablet breakpoint, 36px above it.
              "mt-2.5 inline-flex min-h-11 items-center justify-center md:min-h-9",
              // Transparent fill: it sits on the tonal surface already, and a
              // filled button here would outrank the form's real primary.
              "rounded-sm border bg-transparent px-3",
              "text-sm font-medium",
              "outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              styles.accent,
              styles.line,
            ].join(" ")}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Three icons, inlined rather than pulled from a dependency — an icon set is a
 * supply-chain decision and this needs exactly three glyphs.
 *
 * `aria-hidden` throughout: the tone is already carried by the role and the
 * words, and a screen reader announcing "image" before the sentence is noise.
 */
function AlertIcon({ tone }: { tone: AlertTone }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="block"
    >
      {tone === "error" ? (
        <>
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 4.75v3.75" strokeLinecap="round" />
          <circle cx="8" cy="11.1" r=".85" fill="currentColor" stroke="none" />
        </>
      ) : tone === "wait" ? (
        <>
          {/* A clock, because the fix is time rather than effort. */}
          <circle cx="8" cy="8" r="6.25" />
          <path
            d="M8 4.6V8l2.4 1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="6.25" />
          <path
            d="M5.4 8.2l1.9 1.9 3.4-3.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}
