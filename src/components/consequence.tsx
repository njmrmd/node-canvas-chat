/**
 * A stated limit: the sentence that should change what someone does, and the
 * detail behind it.
 *
 * Design Engineer owns this. It exists so the three places where the product
 * admits a limit — no password reset at sign-up, no password reset at sign-in,
 * deletion is final at /keys — are one pattern rather than three paragraphs
 * that happen to be near each other.
 *
 * Two rules, and they are the whole component:
 *
 * - `lead` is the sentence that changes behaviour, at foreground weight.
 *   `detail` is the fact behind it, muted. The contrast step between them is
 *   the signal — no icon, no alert colour, no new token. Where both sentences
 *   are consequential (an irreversible action has no incidental clause), use
 *   two lead-only Consequences instead of demoting one of them to `detail`.
 * - `emphasis="region"` adds a tinted common region for a limit that must be
 *   read before an irreversible choice. It is tint-without-border, where the
 *   form error banner is border-without-tint, so a standing warning is never
 *   mistaken for a failure that just happened.
 *
 * Both sizes are `text-sm`, not `text-xs`. `--muted` on `--background` is
 * 4.68:1 — a WCAG AA pass with nothing to spare, and 12px at that ratio is a
 * pass nobody actually reads.
 */
export function Consequence(props: {
  id?: string;
  lead: string;
  detail?: string;
  emphasis?: "plain" | "region";
  className?: string;
}) {
  const region = props.emphasis === "region";

  return (
    <div
      id={props.id}
      className={[
        "text-pretty",
        region ? "rounded-md bg-foreground/[0.045] px-3 py-2.5" : "",
        props.className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <p className="text-sm leading-relaxed">{props.lead}</p>

      {props.detail ? (
        <p className="mt-1 text-sm leading-relaxed text-muted">
          {props.detail}
        </p>
      ) : null}
    </div>
  );
}
