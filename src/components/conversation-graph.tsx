/**
 * The picture of the product, drawn rather than described.
 *
 * The landing page makes a spatial claim — "a conversation is a graph, not a
 * list" — and prose is the weakest medium available for that claim. This is the
 * smallest drawing that carries it: one card, one fork, two cards. A branch
 * that leaves its parent on the canvas is the entire product thesis, and it
 * takes three rectangles to show it.
 *
 * Deliberate choices:
 *
 * - **No text.** Every line inside a card is a rounded rect standing in for a
 *   line of type. Nothing here has to be translated, nothing here can be read
 *   out of context by a screen reader, and nothing here claims to be a
 *   screenshot of a build that does not exist yet. The `<h1>` and the lede are
 *   this drawing's text equivalent, which is why the whole thing is
 *   `aria-hidden` rather than carrying a `<title>`.
 * - **No colour of its own.** Card fills, rules and edges come from
 *   `--background`, `--hairline`, `--muted` and `--foreground`, so light and
 *   dark both work with no second copy of the artwork and no `<picture>`.
 * - **Nothing moves.** An animated hero would have to earn a
 *   `prefers-reduced-motion` fallback, and on a first-run screen the reader is
 *   trying to understand a novel idea, not watch something. Static in v1.
 *
 * The contrast minimums in `globals.css` do not apply to any of this: it is
 * decorative by WCAG 1.4.11, since removing it removes no information the page
 * does not also state in words. It still has to be *seen*, which is why the
 * edges are drawn in `--muted` at full strength rather than in `--hairline` —
 * the edges are what make the three cards read as one graph (uniform
 * connectedness), so they are the one part that cannot be faint.
 *
 * Geometry is in a 360x200 user-space grid and scales with the container. Do
 * not add a fixed height: the aspect ratio is what keeps the fork centred over
 * the two children at every width.
 */

/** Card geometry, shared by the three nodes so they stay identical. */
const CARD = { width: 132, height: 56, radius: 10 } as const;

/** Padding from the card's edge to its content, matching on all four sides. */
const PAD = 14;

/**
 * One node: a prompt line and two reply lines. The widths differ per card so
 * the drawing reads as three different exchanges rather than three copies of a
 * placeholder — the same reason a wireframe varies its greeking.
 */
function NodeCard({
  x,
  y,
  lines,
}: {
  x: number;
  y: number;
  lines: readonly [number, number, number];
}) {
  const [prompt, replyA, replyB] = lines;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={CARD.width}
        height={CARD.height}
        rx={CARD.radius}
        className="fill-background stroke-hairline"
        strokeWidth={1}
      />
      {/* The prompt: shorter, heavier, the line you typed. */}
      <rect
        x={x + PAD}
        y={y + PAD}
        width={prompt}
        height={6}
        rx={3}
        className="fill-foreground"
        fillOpacity={0.8}
      />
      {/* The reply: longer, quieter, the part you did not write. */}
      <rect
        x={x + PAD}
        y={y + 30}
        width={replyA}
        height={5}
        rx={2.5}
        className="fill-muted"
        fillOpacity={0.45}
      />
      <rect
        x={x + PAD}
        y={y + 41}
        width={replyB}
        height={5}
        rx={2.5}
        className="fill-muted"
        fillOpacity={0.45}
      />
    </g>
  );
}

export function ConversationGraph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 360 200"
      className={className}
      // Decorative: the lede above it says the same thing in words, so a
      // screen reader that announced this twice would be announcing it twice.
      aria-hidden="true"
      focusable="false"
      role="presentation"
    >
      {/* The trunk leaving the parent, and the branch handle sitting on it. */}
      <path
        d="M180 60 V72"
        className="stroke-muted"
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />

      {/*
       * Both branches leave the same point. That shared origin is the whole
       * argument — the fork is an event on the parent, not a new thread that
       * replaced it (Gestalt: common region, and the parent stays put).
       */}
      <path
        d="M180 84 C180 112 80 108 80 140"
        className="stroke-muted"
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M180 84 C180 112 280 108 280 140"
        className="stroke-muted"
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />

      {/* Parent. */}
      <NodeCard x={114} y={4} lines={[58, 104, 72]} />

      {/*
       * The branch handle, drawn last so it sits above the edges it joins.
       * A plus in a ring is the one signifier on the page that names the verb:
       * this is where a conversation is allowed to go two ways.
       */}
      <circle
        cx={180}
        cy={78}
        r={6}
        className="fill-background stroke-foreground"
        strokeWidth={1.5}
      />
      <path
        d="M176.5 78 H183.5 M180 74.5 V81.5"
        className="stroke-foreground"
        strokeWidth={1.5}
        strokeLinecap="round"
      />

      {/* The version you started with, and the one you branched into. Equal
          weight on purpose: neither is a draft of the other. */}
      <NodeCard x={14} y={140} lines={[44, 96, 62]} />
      <NodeCard x={214} y={140} lines={[66, 104, 48]} />
    </svg>
  );
}
