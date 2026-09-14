/**
 * The message that belongs to one input, rendered directly beneath it.
 *
 * It **replaces** the field's hint rather than stacking under it. Two lines of
 * small print where one used to be, only one of which is the problem, is how a
 * field error gets skipped.
 *
 * Deliberately **not** `role="alert"`. The old markup put `role="alert"` on
 * every field message, so a two-field failure announced twice, in an order the
 * person did not choose, before they had reached either input. Instead this is
 * wired to its input through `aria-describedby` and focus moves to the first
 * invalid control — so the message is announced once, on arrival, attached to
 * the thing it is about.
 *
 * There is no `wait` or `ok` variant, and there should never be one: a field
 * error is always the person's next action, so it is always `--danger`.
 */
export function FieldError({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <p
      id={id}
      className="flex items-start gap-1.5 text-sm font-medium text-danger motion-safe:animate-[alert-enter_var(--dur-base)_var(--ease-out)]"
    >
      {/* 4px nudge sits the glyph on the cap height of the first line. */}
      <span className="mt-1 shrink-0">
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="block"
        >
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 4.75v3.75" strokeLinecap="round" />
          <circle cx="8" cy="11.1" r=".85" fill="currentColor" stroke="none" />
        </svg>
      </span>
      <span>{children}</span>
    </p>
  );
}
