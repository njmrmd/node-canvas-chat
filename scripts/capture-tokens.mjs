#!/usr/bin/env node
/**
 * Resolves the §5 token layer in a real browser and checks it against the spec.
 *
 * Why this exists rather than a stylesheet review: every colour in
 * `canvas-tokens.css` is a `light-dark(light, dark)` pair, so the file says what
 * a token *might* be and only `getComputedStyle` says what it is. Three things
 * can go wrong silently and none are visible in the source —
 * `color-scheme` not reaching the element, Tailwind's `@import` pipeline
 * dropping the file, or `light-dark()` resolving to the wrong half.
 *
 * The expectations below are typed out from the spec rather than parsed out of
 * the CSS on purpose. A check that reads its answer from the thing it is
 * checking only proves the file is internally consistent, which was never in
 * doubt. Duplication is the point.
 *
 * It also proves the theme matrix, which is the part the CEO is being asked to
 * rule on (§11.1): `dark` stays dark under a light OS, `light` stays light
 * under a dark OS, and `system` follows the OS in both directions.
 *
 *   node scripts/capture-tokens.mjs --base http://127.0.0.1:3000 --out ./shots/tokens
 *
 * The `/dev/tokens` route it drives only exists under `next dev`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseArgs, withPage } from "./lib/cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = args.out ?? "./shots/tokens";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

/** §5.4, transcribed from the spec tables. */
const PALETTE = {
  light: {
    "canvas-bg": "#F7F8FA",
    "canvas-dot": "#DDE2E9",
    "surface-1": "#FFFFFF",
    "surface-2": "#F2F4F7",
    "surface-3": "#FFFFFF",
    "border-subtle": "#E9ECF1",
    "border-default": "#D5DAE2",
    "border-strong": "#87919E",
    "edge-default": "#87919E",
    "text-primary": "#10141A",
    "text-secondary": "#4A5563",
    "text-tertiary": "#6B7683",
    accent: "#3B5BDB",
    "accent-hover": "#2F4BC4",
    "accent-fg": "#FFFFFF",
    success: "#0F7A4E",
    warning: "#B45309",
    danger: "#C92A2A",
    "focus-ring": "#2F4BC4",
  },
  dark: {
    "canvas-bg": "#0B0D10",
    "canvas-dot": "#1A1F26",
    "surface-1": "#14181D",
    "surface-2": "#1A1F26",
    "surface-3": "#20262E",
    "border-subtle": "#242B33",
    "border-default": "#2E3742",
    "border-strong": "#637181",
    "edge-default": "#55616F",
    "text-primary": "#E8ECF1",
    "text-secondary": "#A3ADBA",
    "text-tertiary": "#7C8795",
    accent: "#6E8BFF",
    "accent-hover": "#8AA1FF",
    "accent-fg": "#0B0D10",
    success: "#3FCF8E",
    warning: "#F5A524",
    danger: "#FF6B6B",
    "focus-ring": "#8AA1FF",
  },
};

/** §5.1 — `size / line-height / weight`, as the computed style reports them. */
const TYPE = {
  "text-2xs": { size: "11px", line: "14px", weight: "500" },
  "text-xs": { size: "12px", line: "16px", weight: "500" },
  "text-sm": { size: "14px", line: "21px", weight: "400" },
  "text-base": { size: "16px", line: "25px", weight: "400" },
  "text-lg": { size: "18px", line: "26px", weight: "600" },
  "text-2xl": { size: "32px", line: "38px", weight: "600" },
};

/** §5.2 / §5.3 — lengths, which survive the build as authored. */
const LENGTHS = {
  "space-1": "4px",
  "space-2": "8px",
  "space-3": "12px",
  "space-4": "16px",
  "space-5": "24px",
  "space-6": "32px",
  "space-8": "48px",
  "space-10": "64px",
  "space-12": "96px",
  "radius-sm": "6px",
  "radius-md": "10px",
  "radius-lg": "14px",
  "radius-xl": "20px",
  "radius-full": "9999px",
};

/**
 * §5.6 — compared as durations, not as strings.
 *
 * Lightning CSS (Tailwind v4's minifier) rewrites `120ms` to `.12s` on the way
 * out, so the computed custom property never matches the authored text. The two
 * are the same duration, and a string comparison here fails on a difference
 * that does not exist — so both sides go through `toMs` first.
 */
const DURATIONS = {
  "dur-fast": 120,
  "dur-base": 180,
  "dur-mid": 240,
  "dur-slow": 320,
  "dur-xslow": 380,
};

/** `"120ms"` and `".12s"` both become `120`. Anything else becomes `NaN`. */
function toMs(value) {
  const match = /^\s*(-?[\d.]+)\s*(ms|s)\s*$/.exec(value ?? "");
  if (!match) return NaN;
  return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}

/**
 * The matrix that decides §11.1. `expect` is the palette the canvas must
 * actually render, given the page's `data-theme` and the OS preference.
 */
const THEME_CASES = [
  /*
   * The two rows that actually decide §11.1: no `data-theme` at all, which is
   * what a stranger's first paint looks like. A stranger on a light OS must
   * still land in dark.
   *
   * These exist because the obvious matrix — one row per explicit theme — is
   * vacuous. `[data-theme="dark"]` sets `color-scheme` itself, so every such
   * row passes whatever the base declaration says, and flipping the default to
   * `light dark` provably did not fail the suite until these were added.
   */
  { theme: "default", os: "light", expect: "dark" },
  { theme: "default", os: "dark", expect: "dark" },

  // The toggle's explicit dark position.
  { theme: "dark", os: "light", expect: "dark" },
  { theme: "dark", os: "dark", expect: "dark" },
  // The toggle's other position, which must beat a dark OS.
  { theme: "light", os: "dark", expect: "light" },
  { theme: "light", os: "light", expect: "light" },
  // §5.4's reading, offered as a third mode rather than as the default.
  { theme: "system", os: "light", expect: "light" },
  { theme: "system", os: "dark", expect: "dark" },
];

const hexToRgb = (hex) =>
  `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

await mkdir(OUT, { recursive: true });

const failures = [];
const fail = (message) => failures.push(message);

await withPage(async (page) => {
  /* ---- The theme matrix, at one viewport: it is not a layout question. ---- */

  for (const { theme, os, expect } of THEME_CASES) {
    await page.emulate({ ...VIEWPORTS[0], scheme: os });
    await page.navigate(`${BASE}/dev/tokens?theme=${theme}`);

    const resolved = await page.eval(`(() => {
      const root = document.querySelector(".canvas-surface");
      if (!root) return { error: "no .canvas-surface on the page" };
      const read = (name) =>
        getComputedStyle(document.querySelector(\`[data-token="\${name}"]\`))
          .backgroundColor;
      return {
        colorScheme: getComputedStyle(root).colorScheme,
        colours: Object.fromEntries(
          ${JSON.stringify(Object.keys(PALETTE.light))}.map((n) => [n, read(n)]),
        ),
      };
    })()`);

    if (resolved.error) {
      fail(`theme=${theme} os=${os}: ${resolved.error}`);
      continue;
    }

    for (const [name, hex] of Object.entries(PALETTE[expect])) {
      const want = hexToRgb(hex);
      const got = resolved.colours[name];
      if (got !== want) {
        fail(
          `theme=${theme} os=${os}: --${name} resolved to ${got}, expected ${want} (${expect} ${hex})`,
        );
      }
    }
  }

  /* ---- Scalars and type, read once in the default theme. ---- */

  await page.emulate({ ...VIEWPORTS[0], scheme: "dark" });
  await page.navigate(`${BASE}/dev/tokens?theme=dark`);

  const scalars = await page.eval(`(() => {
    const root = document.querySelector(".canvas-surface");
    const style = getComputedStyle(root);
    return Object.fromEntries(
      ${JSON.stringify([...Object.keys(LENGTHS), ...Object.keys(DURATIONS)])}.map(
        (n) => [n, style.getPropertyValue("--" + n).trim()],
      ),
    );
  })()`);

  for (const [name, want] of Object.entries(LENGTHS)) {
    if (scalars[name] !== want) {
      fail(`--${name} is "${scalars[name] || "(undefined)"}", expected "${want}"`);
    }
  }

  for (const [name, wantMs] of Object.entries(DURATIONS)) {
    const got = toMs(scalars[name]);
    if (got !== wantMs) {
      fail(
        `--${name} is "${scalars[name] || "(undefined)"}" (${got}ms), expected ${wantMs}ms`,
      );
    }
  }

  const type = await page.eval(`(() => {
    const read = (name) => {
      const el = document.querySelector(\`[data-type-token="\${name}"]\`);
      if (!el) return null;
      const s = getComputedStyle(el);
      return { size: s.fontSize, line: s.lineHeight, weight: s.fontWeight };
    };
    return Object.fromEntries(
      ${JSON.stringify(Object.keys(TYPE))}.map((n) => [n, read(n)]),
    );
  })()`);

  for (const [name, want] of Object.entries(TYPE)) {
    const got = type[name];
    if (!got) {
      fail(`--${name} has no specimen on the page`);
      continue;
    }
    for (const field of ["size", "line", "weight"]) {
      if (got[field] !== want[field]) {
        fail(
          `--${name} ${field} is ${got[field]}, expected ${want[field]} (spec §5.1)`,
        );
      }
    }
  }

  /* ---- Evidence, at both review viewports in both themes. ---- */

  for (const viewport of VIEWPORTS) {
    for (const theme of ["dark", "light"]) {
      await page.emulate({ ...viewport, scheme: theme });
      await page.navigate(`${BASE}/dev/tokens?theme=${theme}`);

      const name = `tokens--${theme}--${viewport.name}.png`;
      await writeFile(
        join(OUT, name),
        await page.screenshot({ beyondViewport: true }),
      );
      console.log(`wrote ${join(OUT, name)}`);
    }
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} token check(s) failed:`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(
  `\nAll token checks passed: ${Object.keys(PALETTE.light).length} colours across ` +
    `${THEME_CASES.length} theme/OS combinations, ` +
    `${Object.keys(LENGTHS).length} lengths, ${Object.keys(DURATIONS).length} durations, ` +
    `${Object.keys(TYPE).length} type tokens.`,
);
