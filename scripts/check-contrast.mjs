/**
 * Re-measures every colour pair that carries meaning, in both schemes.
 *
 * The ratios live in comments in `globals.css`, and a comment cannot fail. This
 * reads the actual token values out of that file and recomputes them, so
 * changing a hex without checking it turns into a non-zero exit rather than a
 * silent accessibility regression six weeks later.
 *
 *   node scripts/check-contrast.mjs
 *
 * The `--*-line` hairlines are asserted to be *below* 3:1 on purpose. They are
 * decorative — the 3px rail is the boundary that identifies a message — and
 * darkening them is exactly how a message starts looking like a control again.
 * Asserting the ceiling keeps someone from "fixing" them.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
const canvasCss = readFileSync(join(root, "src/app/canvas-tokens.css"), "utf8");

/**
 * Pulls the `:root` block and the dark-scheme override out of the stylesheet.
 * Dark inherits from light and overrides what it redefines, exactly as the
 * cascade does at runtime.
 */
function tokensFor(scheme) {
  const darkAt = css.indexOf("prefers-color-scheme: dark");
  if (darkAt === -1) throw new Error("No dark scheme block in globals.css.");

  const declarations = (source) =>
    Object.fromEntries(
      [...source.matchAll(/^\s*(--[\w-]+):\s*(#[0-9a-fA-F]{3,8});/gm)].map(
        (m) => [m[1], m[2]],
      ),
    );

  // The light block must stop at the media query, or its values are silently
  // overwritten by the dark ones and both schemes report the same numbers.
  const light = declarations(css.slice(0, darkAt));
  if (scheme === "light") return light;

  // Dark inherits and overrides, exactly as the cascade does at runtime.
  return { ...light, ...declarations(css.slice(darkAt)) };
}

const channel = (hex) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(hex) {
  const [r, g, b] = channel(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `[label, foreground, background, minimum]`, or a maximum when `max` is set. */
const PAIRS = [
  ["body text on page", "--foreground", "--background", 4.5],
  ["muted text on page", "--muted", "--background", 4.5],
  ["control border on page", "--border-input", "--background", 3],

  ["danger text on its fill", "--danger", "--danger-surface", 4.5],
  ["body text on danger fill", "--foreground", "--danger-surface", 4.5],
  ["danger rail on its fill", "--danger", "--danger-surface", 3],
  ["invalid input border on page", "--danger", "--background", 3],

  ["wait text on its fill", "--warning", "--warning-surface", 4.5],
  ["body text on wait fill", "--foreground", "--warning-surface", 4.5],
  ["wait rail on its fill", "--warning", "--warning-surface", 3],

  ["ok text on its fill", "--success", "--success-surface", 4.5],
  ["body text on ok fill", "--foreground", "--success-surface", 4.5],
  ["ok rail on its fill", "--success", "--success-surface", 3],

  // Decorative by design — see the header comment.
  ["danger hairline on its fill", "--danger-line", "--danger-surface", 3, "max"],
  ["wait hairline on its fill", "--warning-line", "--warning-surface", 3, "max"],
  ["ok hairline on its fill", "--success-line", "--success-surface", 3, "max"],
];

/**
 * The canvas layer (§5.4) keeps both schemes in one `light-dark(light, dark)`
 * declaration, so one parse yields both palettes and a token added with only
 * one value simply does not appear — which shows up as a MISSING row rather
 * than as a scheme that silently reports its twin's numbers.
 *
 * Plain `--token: #hex;` means the value is scheme-independent. Anything else
 * (`rgba()` fills, shadow strings) is not a contrast subject and is skipped.
 */
function canvasTokensFor(scheme) {
  const pick = (light, dark) => (scheme === "light" ? light : dark);
  const tokens = {};

  for (const m of canvasCss.matchAll(
    /^\s*(--[\w-]+):\s*light-dark\(\s*(#[0-9a-fA-F]{3,8})\s*,\s*(#[0-9a-fA-F]{3,8})\s*\)\s*;/gm,
  )) {
    tokens[m[1]] = pick(m[2], m[3]);
  }

  for (const m of canvasCss.matchAll(
    /^\s*(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/gm,
  )) {
    tokens[m[1]] = m[2];
  }

  return tokens;
}

/**
 * `[label, foreground, background, threshold, kind]` again, with two kinds the
 * pre-canvas table does not need:
 *
 * - `info` — reported, never enforced. The two resting borders are decorative
 *   under 1.4.11 (neither identifies a region on its own), but their numbers
 *   are worth printing so a future palette change is a visible decision.
 * - `open` — the spec's value misses a floor the spec itself sets in §7.4. The
 *   value is implemented verbatim rather than quietly corrected, because colour
 *   is the Design Engineer's call. The measured ratio is pinned so it can only
 *   improve: these rows do not fail the build today, but they do fail it the
 *   moment someone makes them worse.
 *
 *   The pin is `{ light, dark }`, per scheme and not a single number, because
 *   both of these rows miss the floor in only *one* scheme. A shared pin would
 *   be the weaker of the two, which would quietly license the passing scheme to
 *   fall below 3:1 — the exact regression this row exists to catch.
 */
const CANVAS_PAIRS = [
  // Text — WCAG 1.4.3 AA, and §7.4 "all body and meta text >= 4.5:1".
  ["node text on card", "--text-primary", "--surface-1", 4.5],
  ["meta text on card", "--text-secondary", "--surface-1", 4.5],
  ["placeholder on card", "--text-tertiary", "--surface-1", 4.5],
  ["status chip text on its fill", "--text-secondary", "--surface-2", 4.5],
  ["count badge text on its fill", "--text-primary", "--surface-2", 4.5],
  ["coach tip text on popover", "--text-primary", "--surface-3", 4.5],

  // Accent is a text colour too — "Show more", the toast's Undo, the chip label.
  ["accent text on card", "--accent", "--surface-1", 4.5],
  ["accent text hovered on card", "--accent-hover", "--surface-1", 4.5],
  ["label on accent fill", "--accent-fg", "--accent", 4.5],

  ["connected text on card", "--success", "--surface-1", 4.5],
  ["usage warning text on card", "--warning", "--surface-1", 4.5],
  ["error text on card", "--danger", "--surface-1", 4.5],

  // Non-text — WCAG 1.4.11, and §7.4 "all meaningful non-text graphics >= 3:1".
  ["focus ring on card", "--focus-ring", "--surface-1", 3],
  ["focus ring on canvas", "--focus-ring", "--canvas-bg", 3],
  ["focus ring on popover", "--focus-ring", "--surface-3", 3],
  ["error card border on canvas", "--danger", "--canvas-bg", 3],
  ["selection ring on card", "--accent", "--surface-1", 3],

  /*
   * §1.2 makes the edge the sole carrier of the ancestry relation — there is no
   * second signal for "B's conversation includes all of A" — so it is squarely
   * meaningful non-text. §7.4 says this hex was "chosen specifically to clear
   * 3:1 against the canvas background"; in light it does not.
   */
  [
    "edge stroke on canvas",
    "--edge-default",
    "--canvas-bg",
    { light: 2.78, dark: 3.08 },
    "open",
  ],

  /*
   * The branch handle is `surface-3` filled with a `border-strong` outline
   * (§6), and §7.4 names "the branch handle outline" in its 3:1 list. It is the
   * product's primary affordance.
   */
  [
    "branch handle outline",
    "--border-strong",
    "--surface-3",
    { light: 2.96, dark: 2.41 },
    "open",
  ],

  // Decorative — reported so a palette change stays a visible decision.
  ["card divider on card", "--border-subtle", "--surface-1", 3, "info"],
  ["resting card border on card", "--border-default", "--surface-1", 3, "info"],
];

let failed = 0;

function run(title, tokens, pairs, scheme) {
  console.log(`\n${title}`);

  for (const [label, fg, bg, bound_, kind] of pairs) {
    // `open` rows carry a per-scheme pin; everything else is one number.
    const threshold = typeof bound_ === "object" ? bound_[scheme] : bound_;
    const a = tokens[fg];
    const b = tokens[bg];

    if (!a || !b) {
      console.log(`  MISSING  ${label} (${!a ? fg : bg} is not defined)`);
      failed += 1;
      continue;
    }

    const measured = ratio(a, b);

    if (kind === "info") {
      console.log(
        `  info  ${measured.toFixed(2).padStart(6)}:1  ${"—".padEnd(7)}  ${label}`,
      );
      continue;
    }

    // Pinned: may improve, may not regress. The 0.01 slack is rounding.
    const ok =
      kind === "max"
        ? measured < threshold
        : kind === "open"
          ? measured >= threshold - 0.01
          : measured >= threshold;
    if (!ok) failed += 1;

    const bound =
      kind === "max"
        ? `< ${threshold}`
        : kind === "open"
          ? `>= ${threshold}`
          : `>= ${threshold}`;
    const verdict = ok ? (kind === "open" ? "OPEN" : "pass") : "FAIL";

    console.log(
      `  ${verdict}  ${measured.toFixed(2).padStart(6)}:1  ${bound.padEnd(7)}  ${label}`,
    );
  }
}

for (const scheme of ["light", "dark"]) {
  run(
    `${scheme.toUpperCase()} — pre-canvas surface`,
    tokensFor(scheme),
    PAIRS,
    scheme,
  );
  run(
    `${scheme.toUpperCase()} — canvas (spec §5.4)`,
    canvasTokensFor(scheme),
    CANVAS_PAIRS,
    scheme,
  );
}

if (failed > 0) {
  console.error(`\n${failed} contrast check(s) failed.`);
  process.exit(1);
}

console.log(
  "\nAll contrast checks passed in both schemes." +
    "\n\nOPEN rows are spec §5.4 values that miss a floor spec §7.4 sets. They are" +
    "\nimplemented verbatim and pinned at their current ratio, so they can improve" +
    "\nbut not regress. Resolution is the Design Engineer's: see the palette" +
    "\ncontrast issue linked from src/app/canvas-tokens.css.",
);
