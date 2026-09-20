#!/usr/bin/env node
/**
 * TES-109 verification: cyanotype canvas surface (paper, grid, grain, cards,
 * connectors) against the TES-108 revision-6 tokens.
 *
 *   node scripts/qa-tes109-cyanotype-verify.mjs --base http://127.0.0.1:4319
 */
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs, sleep, withPage } from "./lib/cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "http://127.0.0.1:4319").replace(/\/$/, "");
const OUT = args.out ?? "./shots/tes-109";
const PASSWORD = "correct-horse-battery-staple";
// Fixed, not `Date.now()`-suffixed: sign-up is rate-limited to 5/hour/IP
// (e2e/README.md), and this script gets re-run several times while
// iterating. Sign-in first (below) and only fall back to sign-up once.
const EMAIL = args.email ?? "qa-tes109-cyanotype@example.com";

const note = (line) => console.log(line);

const fillJs = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

/** A small branch with one of every card status this ticket's card-state
 * rules touch (resting/complete, streaming/pending, error, interrupted) plus
 * a second root so there is a branch point to look at.
 *
 * PUT /api/canvas is a whole-document replace with no partial-update path
 * (`route.ts`: anything not graph-shaped falls back to `emptyCanvasState()`,
 * not the stored graph) — every call here resends the full graph, or a
 * viewport-only PUT silently wipes every node. */
const seedGraph = (zoom = 1) => `
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
            position: { x: 200, y: 0 }, positionMode: 'auto', size: null,
            collapsed: false, bodyCollapsed: false, usage: null, createdAt: 1, updatedAt: 1,
          },
          settled: {
            id: 'settled', parentId: 'root', prompt: 'What about something food-related?',
            response: 'Sure — a food-themed name could work well if your product has that angle.',
            thinking: '', status: 'complete', error: null,
            position: { x: -50, y: 260 }, positionMode: 'auto', size: null,
            collapsed: false, bodyCollapsed: false, usage: null, createdAt: 2, updatedAt: 2,
          },
          streaming: {
            id: 'streaming', parentId: 'root', prompt: 'And something shorter?',
            response: '', thinking: '', status: 'draft', error: null,
            position: { x: 450, y: 260 }, positionMode: 'auto', size: null,
            collapsed: false, bodyCollapsed: false, usage: null, createdAt: 3, updatedAt: 3,
          },
          errored: {
            id: 'errored', parentId: 'settled', prompt: 'One more option?',
            response: '', thinking: '', status: 'error',
            error: { code: 'rate_limit', message: 'The provider is rate-limiting this key right now.' },
            position: { x: -50, y: 520 }, positionMode: 'auto', size: null,
            collapsed: false, bodyCollapsed: false, usage: null, createdAt: 4, updatedAt: 4,
          },
        },
        nodeIds: ['root', 'settled', 'streaming', 'errored'],
      },
      viewport: { x: 300, y: 120, zoom: ${zoom} },
      selectedNodeId: 'settled',
      hasBranchedOnce: true,
    }),
  }).then((r) => r.status)
`;

/** Counts animation frames for ~1.2s while dispatching a steady stream of
 * wheel events at the canvas surface — the same DOM path a two-finger pan
 * takes (canvas-app.tsx's onWheel) — and returns frames-per-second. Run
 * identically in light (today's dot-grid) and dark (cyanotype grid+grain)
 * to get a real before/after, not a guess, per the plan's acceptance
 * criterion. */
const measurePanFps = `(() => new Promise((resolve) => {
  try {
    const surface = document.querySelector('[role="application"]');
    if (!surface) return resolve("NO_SURFACE");
    let frames = 0;
    let running = true;
    const tick = () => {
      frames++;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const wheelInterval = setInterval(() => {
      surface.dispatchEvent(new WheelEvent('wheel', {
        deltaX: 6, deltaY: 4, bubbles: true, cancelable: true,
      }));
    }, 16);
    const start = performance.now();
    setTimeout(() => {
      running = false;
      clearInterval(wheelInterval);
      const elapsed = (performance.now() - start) / 1000;
      resolve(Math.round((frames / elapsed) * 10) / 10);
    }, 1200);
  } catch (e) {
    resolve("ERROR: " + e.message);
  }
}))()`;

await mkdir(OUT, { recursive: true });

await withPage(async (page) => {
  await page.emulate({ width: 1440, height: 900, mobile: false, scheme: "light" });

  await page.navigate(`${BASE}/sign-in`);
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

  if (!signedIn) {
    note("sign-in failed (account probably doesn't exist yet) — signing up once");
    await page.navigate(`${BASE}/sign-up`);
    await sleep(300);
    await page.eval(fillJs("#email", EMAIL));
    await page.eval(fillJs("#password", PASSWORD));
    await page.eval(`document.querySelector('button[type="submit"]').click()`);
    for (let i = 0; i < 20 && !signedIn; i++) {
      await sleep(300);
      const status = await page.eval(`fetch('/api/canvas').then((r) => r.status)`);
      signedIn = status !== 401;
    }
  }
  note(`landed at ${await page.eval("location.href")}, signedIn=${signedIn}`);
  if (!signedIn) throw new Error("could not sign in or sign up");

  const seedStatus = await page.eval(seedGraph(1));
  note(`seed status: ${seedStatus}`);

  // ---- LIGHT chrome: canvas must be pixel-identical to before this ticket
  await page.navigate(`${BASE}/canvas`);
  await sleep(800);
  await page.screenshot({}).then((b) => writeFile(`${OUT}/00-light-unchanged.png`, b));
  const lightBg = await page.eval(`getComputedStyle(document.querySelector('.cv-paper-layer')).display`);
  note(`light mode .cv-paper-layer display: ${lightBg} (want "none")`);
  const lightFps = await page.eval(measurePanFps);
  note(`light-mode (today's dot-grid) pan FPS: ${lightFps}`);

  // ---- DARK chrome: cyanotype should be live
  await page.emulate({ width: 1440, height: 900, mobile: false, scheme: "dark" });
  await sleep(300);

  await page.eval(seedGraph(1));
  await page.navigate(`${BASE}/canvas`);
  await sleep(800);
  await page.screenshot({}).then((b) => writeFile(`${OUT}/01-dark-zoom-1x.png`, b));

  // Zoom via the real TopBar buttons rather than seeding `viewport.zoom`
  // directly: canvas-app.tsx's cold-load "recovery" effect re-fits the
  // viewport on its own read of `graphBounds` whenever it decides nothing is
  // visible, and it doesn't consider a fresh page load "recent user
  // interaction" — so a viewport seeded straight into the API PUT/reload
  // gets silently overridden before the screenshot happens (confirmed via
  // the stored-viewport readback with the seeded-zoom approach: 0.4x/2x
  // seeds came back re-fit to whatever the effect computed, not the
  // seeded value). Clicking the zoom control the way a user would updates
  // `lastUserViewportChangeRef`, which suppresses that effect for the
  // ~2s window this needs.
  const clickZoom = (label) => `document.querySelector('[aria-label="${label}"]').click()`;
  for (let i = 0; i < 5; i++) {
    await page.eval(clickZoom("Zoom out"));
    await sleep(80);
  }
  await sleep(300);
  await page.screenshot({}).then((b) => writeFile(`${OUT}/01-dark-zoom-0.4x.png`, b));

  for (let i = 0; i < 9; i++) {
    await page.eval(clickZoom("Zoom in"));
    await sleep(80);
  }
  await sleep(300);
  const finalZoom = await page.eval(`fetch('/api/canvas').then(r => r.json()).then(d => d.viewport.zoom)`);
  note(`zoom after 5 out + 9 in clicks: ${finalZoom} (target ~2x)`);
  await page.screenshot({}).then((b) => writeFile(`${OUT}/01-dark-zoom-2x.png`, b));

  const darkFps = await page.eval(measurePanFps);
  note(`dark-mode (cyanotype grid+grain) pan FPS: ${darkFps}`);

  const computed = await page.eval(`(() => {
    const settled = document.querySelector('[data-node-id="settled"]');
    const streaming = document.querySelector('[data-node-id="streaming"]');
    const cs = (el) => el ? getComputedStyle(el) : null;
    return JSON.stringify({
      settledBorder: cs(settled)?.borderColor,
      settledBoxShadow: cs(settled)?.boxShadow,
      streamingBg: cs(streaming)?.backgroundColor,
      paperLayerBg: getComputedStyle(document.querySelector('.cv-paper-layer')).backgroundImage.slice(0, 60),
      grainDisplay: getComputedStyle(document.querySelector('.cv-grain-layer')).display,
      mmMinorOpacityAtZoom2: getComputedStyle(document.querySelector('.cv-mm-grid-minor')).opacity,
      radiusLg: getComputedStyle(settled).borderRadius,
      dashedPendingEdge: [...document.querySelectorAll('.cv-edge-path')]
        .map((p) => getComputedStyle(p).strokeDasharray)
        .join(' | '),
    });
  })()`);
  note(`computed styles (dark, ~2x, selected="settled"): ${computed}`);

  // Hover the streaming card with a *real* CDP mouse move — CSS `:hover`
  // does not respond to a synthetic `dispatchEvent(new PointerEvent(...))`,
  // only to actual input-device dispatch — to confirm the hover fill really
  // changes the underlying custom property (inline `style` would otherwise
  // always win a literal `background` set from an external stylesheet; see
  // canvas.css's `--cv-select-ring` comment for the same trap elsewhere).
  await page.eval(`document.querySelector('[aria-label="Zoom to fit"]').click()`);
  await sleep(500);
  const bgBefore = await page.eval(`getComputedStyle(document.querySelector('[data-node-id="streaming"]')).backgroundColor`);
  const streamingBox = await page.eval(`(() => {
    const r = document.querySelector('[data-node-id="streaming"]').getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`);
  const { x: hx, y: hy } = JSON.parse(streamingBox);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hx, y: hy });
  await sleep(300);
  const bgAfter = await page.eval(`getComputedStyle(document.querySelector('[data-node-id="streaming"]')).backgroundColor`);
  const reallyHovering = await page.eval(`document.querySelector('[data-node-id="streaming"]').matches(':hover')`);
  note(`hover fill: before=${bgBefore} after=${bgAfter} matches(:hover)=${reallyHovering}`);
  await page.screenshot({}).then((b) => writeFile(`${OUT}/02-dark-hover-streaming-card.png`, b));

  note("done");
}).catch((error) => {
  console.error("FAILED:", error.message);
  process.exitCode = 1;
});
