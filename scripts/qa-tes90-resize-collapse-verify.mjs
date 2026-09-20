#!/usr/bin/env node
/**
 * TES-90 self-verification: resize (Part A) and body-collapse (Part B).
 *
 * Seeds a canvas directly via PUT /api/canvas (no model key needed), then
 * drives a real resize drag and a real body-collapse click through the DOM,
 * and proves persistence by reloading and reading GET /api/canvas back —
 * per the ticket's "read back from GET /api/canvas rather than from pixels".
 *
 *   node scripts/qa-tes90-resize-collapse-verify.mjs --base http://localhost:4317 --out ./shots/tes-90
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, sleep, withPage } from "./lib/cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "http://localhost:4317").replace(/\/$/, "");
const OUT = args.out ?? "./shots/tes-90";
const PASSWORD = "correct-horse-battery-staple";
// Reused rather than a fresh sign-up each run: sign-up is rate-limited per IP
// and this script is re-run often while iterating. First created by an
// earlier pass of this same script.
const EMAIL = args.email ?? "qa-tes90-1789903349170@example.com";

const log = [];
const note = (line) => {
  console.log(line);
  log.push(line);
};

const fillJs = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

const LONG_TEXT = Array.from({ length: 30 }, (_, i) =>
  `Paragraph ${i + 1}. This is a deliberately long answer so the card overflows its default height and gives the resize handle something real to fix. `.repeat(2),
).join("\n\n");

await mkdir(OUT, { recursive: true });

await withPage(async (page) => {
  const shot = async (name) => {
    const buf = await page.screenshot();
    await writeFile(join(OUT, `${name}.png`), buf);
    note(`  shot: ${name}.png`);
  };

  await page.emulate({ width: 1440, height: 900, mobile: false, scheme: "light" });

  // 1. Sign in to the reused test account.
  await page.navigate(`${BASE}/sign-in`);
  await sleep(500);
  await page.eval(fillJs("#email", EMAIL));
  await page.eval(fillJs("#password", PASSWORD));
  await page.eval(`document.querySelector('button[type="submit"]').click()`);
  let landedAt = await page.eval("location.href");
  for (let i = 0; i < 20 && landedAt.includes("/sign-in"); i++) {
    await sleep(500);
    landedAt = await page.eval("location.href");
  }
  note(`signed in as ${EMAIL}, landed at ${landedAt}`);

  // 2. Seed a canvas directly — a long-answer root, an already-resized node,
  // an already body-collapsed leaf, and a plain sibling for overlap contrast.
  const seedResult = await page.eval(`
    fetch('/api/canvas', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        graph: {
          nodesById: {
            root: {
              id: 'root', parentId: null, prompt: 'Tell me something long',
              response: ${JSON.stringify(LONG_TEXT)}, thinking: '', status: 'complete', error: null,
              position: { x: 0, y: 0 }, positionMode: 'auto', size: null,
              collapsed: false, bodyCollapsed: false, usage: null, createdAt: 1, updatedAt: 1,
            },
            resized: {
              id: 'resized', parentId: 'root', prompt: 'A reply I widened to read comfortably',
              response: ${JSON.stringify(LONG_TEXT.slice(0, 400))}, thinking: '', status: 'complete', error: null,
              position: { x: 0, y: 420 }, positionMode: 'auto', size: { width: 520, height: 480 },
              collapsed: false, bodyCollapsed: false, usage: null, createdAt: 2, updatedAt: 2,
            },
            leaf: {
              id: 'leaf', parentId: 'root', prompt: 'A short one to skim',
              response: 'First line of the answer, which should be all that shows.\\nSecond line stays hidden while collapsed.',
              thinking: '', status: 'complete', error: null,
              position: { x: 600, y: 420 }, positionMode: 'auto', size: null,
              collapsed: false, bodyCollapsed: false, usage: null, createdAt: 3, updatedAt: 3,
            },
          },
          nodeIds: ['root', 'resized', 'leaf'],
        },
        viewport: { x: 80, y: 40, zoom: 0.6 },
        selectedNodeId: null,
        hasBranchedOnce: true,
      }),
    }).then(r => r.status)
  `);
  note(`seed PUT /api/canvas -> ${seedResult}`);

  await page.navigate(`${BASE}/canvas`);
  await sleep(1200);
  await shot("01-desktop-seeded");

  const overlapCheck = await page.eval(`
    JSON.stringify(Array.from(document.querySelectorAll('[data-node-id]')).map(el => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.nodeId, x: r.x, y: r.y, w: r.width, h: r.height };
    }))
  `);
  const rects = JSON.parse(overlapCheck);
  note(`rendered rects: ${overlapCheck}`);
  function overlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  let anyOverlap = false;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (overlap(rects[i], rects[j])) {
        anyOverlap = true;
        note(`OVERLAP: ${rects[i].id} x ${rects[j].id}`);
      }
    }
  }
  note(`any rendered overlap: ${anyOverlap}`);

  const resizedNodeWidth = rects.find((r) => r.id === "resized")?.w;
  note(`'resized' node rendered width (viewport px, zoom 0.6): ${resizedNodeWidth} (world px ~${resizedNodeWidth / 0.6})`);


  // 3. Live interaction: toggle body-collapse on the 'root' card via a real
  // click on its icon button (label contains "Collapse to one line").
  const toggledRoot = await page.eval(`
    (() => {
      const card = document.querySelector('[data-node-id="root"]');
      const btn = Array.from(card.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Collapse to one line');
      if (!btn) return 'not-found';
      btn.click();
      return 'clicked';
    })()
  `);
  note(`root body-collapse toggle: ${toggledRoot}`);
  await sleep(200);
  const rootCollapsedText = await page.eval(`
    document.querySelector('[data-node-id="root"] [data-canvas-role="card-body"]').innerText
  `);
  note(`root body-collapsed text shown: ${JSON.stringify(rootCollapsedText)}`);
  await shot("02-desktop-root-collapsed");

  // 4. Live interaction: drag the 'leaf' card's resize handle by +160,+120.
  const dragResult = await page.eval(`
    (() => {
      const card = document.querySelector('[data-node-id="leaf"]');
      const handle = card.querySelector('[aria-label="Resize card"]');
      if (!handle) return 'no-handle';
      const r = handle.getBoundingClientRect();
      const startX = r.x + r.width / 2;
      const startY = r.y + r.height / 2;
      const pointerId = 1;
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId, clientX: startX, clientY: startY, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId, clientX: startX + 160, clientY: startY + 120, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: startX + 160, clientY: startY + 120, bubbles: true }));
      return 'dragged';
    })()
  `);
  note(`leaf resize drag: ${dragResult}`);
  await sleep(200);
  await shot("03-desktop-leaf-resized");

  const leafRectAfterDrag = await page.eval(`
    JSON.stringify(document.querySelector('[data-node-id="leaf"]').getBoundingClientRect())
  `);
  note(`leaf rect after drag: ${leafRectAfterDrag}`);

  // Wait past the 500ms save debounce, then reload and re-check via the API
  // (not pixels) that both mutations persisted.
  await sleep(900);
  await page.navigate(`${BASE}/canvas`);
  await sleep(1200);
  await shot("04-desktop-after-reload");

  const persisted = await page.eval(`fetch('/api/canvas').then(r => r.json())`);
  note(`persisted root.bodyCollapsed: ${persisted.graph.nodesById.root.bodyCollapsed}`);
  note(`persisted leaf.size: ${JSON.stringify(persisted.graph.nodesById.leaf.size)}`);
  note(`persisted resized.size: ${JSON.stringify(persisted.graph.nodesById.resized.size)}`);

  // 5. Mobile viewport.
  await page.emulate({ width: 390, height: 844, mobile: true, scheme: "light" });
  await page.navigate(`${BASE}/canvas`);
  await sleep(1200);
  await shot("05-mobile-after-reload");
});

await writeFile(join(OUT, "log.txt"), log.join("\n"));
console.log(`\nlog written to ${join(OUT, "log.txt")}`);
