#!/usr/bin/env node
/**
 * TES-112 verification: cyanotype must render identically regardless of the
 * visitor's OS `prefers-color-scheme`, now that canvas.css no longer gates
 * it behind `@media (prefers-color-scheme: dark)`.
 *
 * Seeds a small graph, then screenshots the same canvas under `scheme:
 * "light"` and `scheme: "dark"` at both review viewports. Diffs the two
 * PNGs byte-for-byte (rendering is pixel-deterministic here — no timers,
 * network images, or animation left running) rather than eyeballing it.
 *
 *   node scripts/qa-tes112-unconditional-verify.mjs --base http://127.0.0.1:4319
 */
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs, sleep, withPage } from "./lib/cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "http://127.0.0.1:4319").replace(/\/$/, "");
const OUT = args.out ?? "./shots/tes-112";
const PASSWORD = "correct-horse-battery-staple";
const EMAIL = args.email ?? `qa-tes112-${Date.now()}@example.com`;

const note = (line) => console.log(line);

const fillJs = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

const seedGraph = `
  fetch('/api/canvas', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      graph: {
        nodesById: {
          root: {
            id: 'root', parentId: null, prompt: 'What should I name my startup?',
            response: 'Something short, easy to say out loud, and not already taken as a .com.',
            thinking: '', status: 'complete', error: null,
            position: { x: 400, y: 300 }, positionMode: 'auto', size: null,
            collapsed: false, bodyCollapsed: false, usage: null, createdAt: 1, updatedAt: 1,
          },
          c1: {
            id: 'c1', parentId: 'root', prompt: 'What about something food-related?',
            response: 'Sure — a food-themed name could work well if your product has that angle.',
            thinking: '', status: 'complete', error: null,
            position: { x: 400, y: 500 }, positionMode: 'auto', size: null,
            collapsed: false, bodyCollapsed: false, usage: null, createdAt: 2, updatedAt: 2,
          },
        },
        nodeIds: ['root', 'c1'],
      },
      viewport: { x: -250, y: -150, zoom: 1 },
      selectedNodeId: 'root',
      hasBranchedOnce: true,
    }),
  }).then((r) => r.status)
`;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

await mkdir(OUT, { recursive: true });

let failures = 0;

await withPage(async (page) => {
  await page.emulate({ width: 1440, height: 900, mobile: false, scheme: "light" });

  await page.navigate(`${BASE}/sign-up`);
  await sleep(300);
  await page.eval(fillJs("#email", EMAIL));
  await page.eval(fillJs("#password", PASSWORD));
  await page.eval(`document.querySelector('button[type="submit"]').click()`);

  let signedIn = false;
  for (let i = 0; i < 20 && !signedIn; i++) {
    await sleep(300);
    const status = await page.eval(`fetch('/api/canvas').then((r) => r.status)`);
    signedIn = status !== 401;
  }
  if (!signedIn) throw new Error("sign-up never produced a session");

  const seedStatus = await page.eval(seedGraph);
  note(`seed status: ${seedStatus}`);

  for (const viewport of VIEWPORTS) {
    const shots = {};
    for (const scheme of ["light", "dark"]) {
      await page.emulate({ ...viewport, scheme });
      await page.navigate(`${BASE}/canvas`);
      await sleep(400);
      const png = await page.screenshot();
      shots[scheme] = png;
      await writeFile(`${OUT}/${viewport.name}-${scheme}.png`, png);
    }
    const identical = shots.light.equals(shots.dark);
    note(`${viewport.name}: light vs dark identical = ${identical}`);
    if (!identical) failures++;
  }
});

note(failures === 0 ? "\nPASS: canvas is unconditional across OS colour scheme." : `\nFAIL: ${failures} viewport(s) differ.`);
process.exit(failures === 0 ? 0 : 1);
