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

let failed = 0;

for (const scheme of ["light", "dark"]) {
  const tokens = tokensFor(scheme);
  console.log(`\n${scheme.toUpperCase()}`);

  for (const [label, fg, bg, threshold, kind] of PAIRS) {
    const a = tokens[fg];
    const b = tokens[bg];

    if (!a || !b) {
      console.log(`  MISSING  ${label} (${!a ? fg : bg} is not defined)`);
      failed += 1;
      continue;
    }

    const measured = ratio(a, b);
    const ok = kind === "max" ? measured < threshold : measured >= threshold;
    if (!ok) failed += 1;

    const bound = kind === "max" ? `< ${threshold}` : `>= ${threshold}`;
    console.log(
      `  ${ok ? "pass" : "FAIL"}  ${measured.toFixed(2).padStart(6)}:1  ${bound.padEnd(7)}  ${label}`,
    );
  }
}

if (failed > 0) {
  console.error(`\n${failed} contrast check(s) failed.`);
  process.exit(1);
}

console.log("\nAll contrast checks passed in both schemes.");
