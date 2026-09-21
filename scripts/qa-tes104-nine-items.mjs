#!/usr/bin/env node
/**
 * TES-104: the CEO's nine items, walked on deployed production, at both
 * viewports, on a canvas that is at least four nodes deep with the fork off
 * node 2 (not the newest node) and at least one long reply (>232px card).
 *
 * Builds the whole shape with real Send actions (real streamed completions,
 * real keyboard events via CDP so Enter/Shift+Enter/Cmd+Enter are genuine
 * trusted input, not JS-dispatched events a textarea's native newline
 * insertion would ignore), against the already-signed-in-with QA account
 * (sign-up is rate limited and shared across concurrent agent runs).
 *
 *   QA_TEST_ACCOUNT_PASSWORD=... node scripts/qa-tes104-nine-items.mjs \
 *     --base https://node-canvas-chat.vercel.app --out ./shots/tes-104
 */
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, sleep, withPage } from "./lib/cdp.mjs";

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err?.stack ?? err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err?.stack ?? err);
  process.exit(1);
});

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "https://node-canvas-chat.vercel.app").replace(/\/$/, "");
const OUT = args.out ?? "./shots/tes-104";
const EMAIL = "platform-eng-tes67-verify+1789859719@example.com";
const PASSWORD = process.env.QA_TEST_ACCOUNT_PASSWORD;
if (!PASSWORD) {
  console.error("Set QA_TEST_ACCOUNT_PASSWORD in the environment.");
  process.exit(1);
}

// ---------- low-level input helpers ----------

const click = async (p, x, y) => {
  // TES-117: a teleported click with no leading mouseMoved can land while a
  // hover-revealed control (e.g. .cv-node-actions' opacity transition) is
  // still mid-transition, producing an intermittent, desktop-only click
  // delivery miss that no real user hits (a real cursor always arrives with
  // hundreds of ms of lead time). Confirmed by a controlled comparison:
  // 5/5 clean with this lead-in vs. a ~40% miss rate without it, same build.
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await sleep(400);
  const common = { x, y, button: "left", clickCount: 1, buttons: 1 };
  await p.send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
  await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common, buttons: 0 });
};

const clickSelector = async (p, selector) => {
  const box = await p.eval(`(() => {
    const el = ${selector};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`selector not found: ${selector}`);
  await click(p, box.x, box.y);
  return box;
};

const fillJs = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

async function insertText(p, text) {
  await p.send("Input.insertText", { text });
}

async function pressEnter(p, { shift = false, meta = false, ctrl = false } = {}) {
  const modifiers = (shift ? 8 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0);
  // `text: "\r"` is what makes CDP run the browser's native default action
  // (insert a newline into the focused textarea) when the app's own keydown
  // handler does not call preventDefault() — exactly the Shift+Enter case.
  // When the app DOES preventDefault() (plain/Cmd/Ctrl+Enter, no shiftKey),
  // that default action is suppressed same as a real trusted keystroke, so
  // this is safe to include unconditionally.
  const base = { key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers };
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

// Real trusted keystrokes into the composer: click in first (focus), then
// insert the text as one paste-like op, so this stays fast for long prompts.
async function focusComposer(p) {
  await clickSelector(p, `document.querySelector('textarea')`);
  await sleep(150);
}

// ---------- app-state polling ----------

const waitForNodeCount = async (p, n, timeoutMs = 150000) => {
  let elapsed = 0;
  let last = null;
  while (elapsed < timeoutMs) {
    const state = await p.eval(`(() => {
      const groups = Array.from(document.querySelectorAll('[role="group"][aria-label^="Node,"]'));
      return { count: groups.length, all: groups.map((g) => g.getAttribute('aria-label')) };
    })()`);
    last = state;
    const lastLabel = state.all[state.all.length - 1];
    if (state.count >= n && lastLabel && /, (complete|interrupted|error)$/.test(lastLabel)) {
      return { count: state.count, last: lastLabel };
    }
    await sleep(2000);
    elapsed += 2000;
  }
  throw new Error(`timed out waiting for node ${n} to settle; last seen: ${JSON.stringify(last)}`);
};

const waitForStatus = async (p, statusSuffix, timeoutMs = 15000) => {
  let elapsed = 0;
  while (elapsed < timeoutMs) {
    const found = await p.eval(`(() => {
      const groups = Array.from(document.querySelectorAll('[role="group"][aria-label^="Node,"]'));
      const last = groups[groups.length - 1];
      return last ? last.getAttribute('aria-label') : null;
    })()`);
    if (found && found.endsWith(`, ${statusSuffix}`)) return found;
    await sleep(150);
    elapsed += 150;
  }
  return null;
};

// "streaming" covers both the thinking-only phase (no Stop button yet, per
// node-card.tsx) and actual token output (Stop button rendered). Poll for
// the button itself so a slow-to-start model doesn't get us here too early.
const waitForStopButton = async (p, timeoutMs = 30000) => {
  let elapsed = 0;
  while (elapsed < timeoutMs) {
    const found = await p.eval(`!!document.querySelector('button[aria-label="Stop generating"]')`);
    if (found) return true;
    await sleep(200);
    elapsed += 200;
  }
  return false;
};

// ---------- measurement helpers ----------

// DOMRect's fields are prototype getters, not own enumerable properties, so
// CDP's returnByValue serializes a bare getBoundingClientRect() as `{}`.
// Always destructure into a plain object before returning it across eval.
async function rectOf(p, selector) {
  return p.eval(`(() => {
    const el = ${selector};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  })()`);
}

// A `.cv-node-slot`'s own inline `transform: translate(Xpx, Ypx)` IS its raw
// canvas-space position — the pan/zoom lives on the parent world container,
// not here. Reading it directly (instead of getBoundingClientRect(), which
// is screen-space and drifts with any pan/zoom/auto-follow between two
// measurements taken moments apart) is the only way to compare "where the
// skeleton was" against "where the real card landed" without the comparison
// being corrupted by the canvas panning in between.
async function slotCanvasPosition(p, selector) {
  return p.eval(`(() => {
    const el = ${selector};
    if (!el) return null;
    const m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/.exec(el.style.transform || "");
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  })()`);
}

async function readCardRects(p) {
  return p.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-node-id]'));
    return cards.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute('data-node-id'), x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    });
  })()`);
}

function rectsOverlap(a, b) {
  return a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
}

function findOverlaps(rects) {
  const overlaps = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (rectsOverlap(rects[i], rects[j])) overlaps.push([rects[i].id, rects[j].id]);
    }
  }
  return overlaps;
}

async function readEdgePaths(p) {
  return p.eval(`(() => {
    const svg = document.querySelector('svg.cv-world');
    if (!svg) return [];
    const paths = Array.from(svg.querySelectorAll('path'));
    return paths.map((path) => {
      const len = path.getTotalLength();
      const ctm = path.getScreenCTM();
      const toScreen = (pt) => {
        const dp = new DOMPoint(pt.x, pt.y).matrixTransform(ctm);
        return { x: dp.x, y: dp.y };
      };
      const start = path.getPointAtLength(0);
      const end = path.getPointAtLength(len);
      return { d: path.getAttribute('d'), start: toScreen(start), end: toScreen(end) };
    });
  })()`);
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// TES-107: TES-104's item-9 checks (siblings share a row, symmetric about
// the parent's centre, edge lands within 3px of a port) are all *relative*
// and all passed on the build where node2 rendered above node1 — an
// upside-down tree is still internally consistent. This is the absolute
// check that catches that: a child must never render above, or overlapping,
// its own parent, checked two ways —
//   domOk: the rendered card rect (getBoundingClientRect, real measured
//     height, whatever the current layout actually produced).
//   graphOk: the persisted position alone (`GET /api/canvas`), using the
//     same DOM-measured height as the height term — the persisted graph
//     has no reliable height of its own (`node.size` is only set on manual
//     resize; layout.ts sizes everything else from a client-side
//     ResizeObserver map that isn't part of the API response), so this is
//     the closest a script gets to checking the graph's own y without
//     reimplementing that measurement.
function checkDownwardFlow(childRect, parentRect, childPos, parentPos) {
  const domOk = childRect.y >= parentRect.bottom - 1;
  const graphOk = childPos.y >= parentPos.y;
  const graphOkWithHeight = childPos.y >= parentPos.y + parentRect.height - 1;
  return { domOk, graphOk, graphOkWithHeight };
}

function distToRectBoundary(pt, rect) {
  const dx = Math.max(rect.x - pt.x, 0, pt.x - rect.right);
  const dy = Math.max(rect.y - pt.y, 0, pt.y - rect.bottom);
  return Math.hypot(dx, dy);
}

// Item 1: the send button's real glyph bounding box (in screen space, so the
// visual translateY nudge counts) against the button circle's own center.
async function measureSendArrow(p) {
  return p.eval(`(() => {
    const btn = document.querySelector('button[aria-label="Send"]');
    if (!btn) return null;
    const path = btn.querySelector('svg path');
    const bbox = path.getBBox();
    const ctm = path.getScreenCTM();
    const corners = [
      { x: bbox.x, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y },
      { x: bbox.x, y: bbox.y + bbox.height },
      { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
    ].map((pt) => new DOMPoint(pt.x, pt.y).matrixTransform(ctm));
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const glyphCenter = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    const r = btn.getBoundingClientRect();
    const buttonCenter = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    return { glyphCenter, buttonCenter, dx: glyphCenter.x - buttonCenter.x, dy: glyphCenter.y - buttonCenter.y, buttonRect: { width: r.width, height: r.height } };
  })()`);
}

async function getHeaderActionLabels(p, nodeId) {
  return p.eval(`(() => {
    const card = document.querySelector('[data-node-id="${nodeId}"]');
    if (!card) return null;
    const actions = card.querySelector('.cv-node-actions');
    if (!actions) return null;
    return Array.from(actions.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
  })()`);
}

async function getPortCoords(p, nodeId) {
  return p.eval(`(() => {
    const card = document.querySelector('[data-node-id="${nodeId}"]');
    if (!card) return null;
    const ports = Array.from(card.querySelectorAll('.cv-port'));
    const toScreen = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    };
    // Inbound (top) only renders when parentId !== null, and is always
    // first in DOM order when present; outbound (bottom) always renders.
    if (ports.length === 2) return { inbound: toScreen(ports[0]), outbound: toScreen(ports[1]) };
    if (ports.length === 1) return { inbound: null, outbound: toScreen(ports[0]) };
    return { inbound: null, outbound: null };
  })()`);
}

async function panUntilVisible(p, nodeId, viewport) {
  for (let i = 0; i < 30; i += 1) {
    const r = await p.eval(`(() => {
      const el = document.querySelector('[data-node-id="${nodeId}"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { y: rect.y, height: rect.height, bottom: rect.bottom };
    })()`);
    if (r && r.y >= 0 && r.bottom <= viewport.height) return true;
    await p.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.round(viewport.width * 0.9),
      y: Math.round(viewport.height * 0.1),
      deltaX: 0,
      deltaY: r && r.y < 0 ? -120 : 120,
    });
    await sleep(80);
  }
  return false;
}

// ---------- main per-viewport flow ----------

const ALL_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false, nodeWidth: 460 },
  { name: "mobile", width: 390, height: 844, mobile: true, nodeWidth: 344 },
];
const VIEWPORTS = args.viewport ? ALL_VIEWPORTS.filter((v) => v.name === args.viewport) : ALL_VIEWPORTS;

const LONG_PROMPT_PARA2 =
  "Cover the founding, the medieval period, and modern development, in at least six paragraphs, with specific dates and names throughout so the reply is genuinely long.";

await mkdir(OUT, { recursive: true });
const log = [];
const note = (l) => {
  console.log(l);
  log.push(l);
  try {
    appendFileSync(join(OUT, "live.log"), `${l}\n`);
  } catch {
    // OUT may not exist yet on the very first call; harmless to lose one line.
  }
};

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
note(`health: ${JSON.stringify(health)}`);
// TES-107's own non-negotiable: this file's original TES-104 run was against
// `34911f3`, the build the TES-106 fix landed on top of — reusing this file
// for the re-run without updating the guard would silently let it test the
// same known-broken build again. Refuse to proceed against `34911f3` or any
// commit that is not a descendant of the fix (`cdd96c8`).
const TES_106_FIX_COMMIT = "cdd96c8";
if (!args.skipCommitCheck) {
  const { execSync } = await import("node:child_process");
  let isDescendant = false;
  try {
    execSync(`git merge-base --is-ancestor ${TES_106_FIX_COMMIT} ${health.commit}`, { stdio: "ignore" });
    isDescendant = true;
  } catch {
    isDescendant = false;
  }
  if (!isDescendant) {
    note(
      `STOP: production commit ${health.commit} does not contain the TES-106 fix (${TES_106_FIX_COMMIT} is not its ancestor). Per TES-107's non-negotiable, not testing the stale build. File it back at Platform Engineer.`,
    );
    process.exit(1);
  }
  note(`confirmed: ${health.commit} contains the TES-106 fix (${TES_106_FIX_COMMIT} is an ancestor).`);
}

let results = {};
try {
  results = JSON.parse(await readFile(join(OUT, "results.json"), "utf8"));
  note(`loaded existing results.json, keys so far: ${Object.keys(results).join(", ")}`);
} catch {
  // no prior partial run in this OUT dir; start fresh
}

for (const viewport of VIEWPORTS) {
  const r = {};
  results[viewport.name] = r;

  await withPage(async (page) => {
    const shot = async (name) => {
      await writeFile(join(OUT, `${viewport.name}-${name}.png`), await page.screenshot());
      note(`  shot: ${viewport.name}-${name}.png`);
    };
    await page.emulate({ ...viewport, scheme: "light" });

    await page.navigate(`${BASE}/sign-in`);
    await page.eval(fillJs("#email", EMAIL));
    await page.eval(fillJs("#password", PASSWORD));
    await page.eval(`document.querySelector('button[type="submit"]').click()`);
    let landedAt = await page.eval("location.href");
    for (let i = 0; i < 20 && landedAt.includes("/sign-in"); i++) {
      await sleep(500);
      landedAt = await page.eval("location.href");
    }
    note(`[${viewport.name}] post-sign-in: ${landedAt}`);

    // ---- Reset to a truly fresh canvas ----
    await page.eval(`fetch('/api/canvas', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: { nodesById: {}, nodeIds: [] }, viewport: { x: 0, y: 0, zoom: 1 }, selectedNodeId: null, hasBranchedOnce: false }),
    })`);
    await page.navigate(`${BASE}/canvas`);
    await sleep(1000);
    await shot("00-empty-canvas");

    // ---- Item 1a: composer arrow centering, CENTERED variant (no nodes yet) ----
    r.sendArrowCentered = await measureSendArrow(page);
    note(`[${viewport.name}] item1 send-arrow (centered variant): ${JSON.stringify(r.sendArrowCentered)}`);

    // ---- Item 6: bare Enter sends. Node 1 (short, root). ----
    await focusComposer(page);
    await insertText(page, "What is the capital of France?");
    await pressEnter(page);

    // ---- Item 2: first node centered — measured at the moment the card
    // first paints, before streaming/auto-follow gets any chance to pan the
    // viewport. `centeredRootPosition` is a create-time placement, not a
    // standing invariant the app re-enforces later, so this is the fair
    // reading of "is the first node centered": against the plain viewport
    // center, since the composer's docked chrome band doesn't exist yet at
    // the instant of creation (it only mounts once isRootsEmpty flips). ----
    let firstAppear = null;
    for (let i = 0; i < 100; i += 1) {
      const found = await page.eval(`(() => {
        const el = document.querySelector('[data-node-id]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { id: el.getAttribute('data-node-id'), x: r.x, y: r.y, width: r.width, height: r.height, innerWidth: window.innerWidth, innerHeight: window.innerHeight };
      })()`);
      if (found) {
        firstAppear = found;
        break;
      }
      await sleep(50);
    }
    if (!firstAppear) throw new Error(`[${viewport.name}] node 1 never appeared in the DOM`);
    const node1Id = firstAppear.id;
    const cardCenterAtCreate = { x: firstAppear.x + firstAppear.width / 2, y: firstAppear.y + firstAppear.height / 2 };
    const viewportCenterAtCreate = { x: firstAppear.innerWidth / 2, y: firstAppear.innerHeight / 2 };
    r.firstNodeCentering = {
      cardCenterAtCreate,
      viewportCenterAtCreate,
      dx: cardCenterAtCreate.x - viewportCenterAtCreate.x,
      dy: cardCenterAtCreate.y - viewportCenterAtCreate.y,
    };
    note(`[${viewport.name}] item2 first-node centering at first paint: ${JSON.stringify(r.firstNodeCentering)}`);
    await shot("01-first-node-centered");

    let state = await waitForNodeCount(page, 1, 150000);
    note(`[${viewport.name}] node 1 settled via bare Enter: ${state.last}`);

    // ---- Item 1b: composer arrow centering, DOCKED variant ----
    r.sendArrowDocked = await measureSendArrow(page);
    note(`[${viewport.name}] item1 send-arrow (docked variant): ${JSON.stringify(r.sendArrowDocked)}`);
    await shot("01b-docked-composer");

    // ---- Item 4: composer padding, screenshot only (taste, no verdict) ----
    const composerBox = await page.eval(`(() => {
      const ta = document.querySelector('textarea');
      const wrap = ta.closest('div');
      const cs = getComputedStyle(wrap);
      return { padding: cs.padding, borderRadius: cs.borderRadius };
    })()`);
    note(`[${viewport.name}] item4 composer computed padding: ${JSON.stringify(composerBox)}`);

    // ---- Item 6: Shift+Enter inserts a newline, does not send. Node 2 (long, multi-line). ----
    await focusComposer(page);
    await insertText(page, "Give me a detailed, multi-paragraph history of that city, covering its founding.");
    await pressEnter(page, { shift: true });
    await sleep(150);
    await insertText(page, LONG_PROMPT_PARA2);
    const valueAfterShiftEnter = await page.eval(`document.querySelector('textarea').value`);
    const stillOneNode = (await page.eval(`document.querySelectorAll('[role="group"][aria-label^="Node,"]').length`)) === 1;
    r.shiftEnterNoSend = stillOneNode;
    r.shiftEnterInsertedNewline = valueAfterShiftEnter.includes("\n");
    note(`[${viewport.name}] item6 Shift+Enter: newline inserted=${r.shiftEnterInsertedNewline}, no premature send=${stillOneNode}`);
    await pressEnter(page); // plain Enter now sends the multi-line message
    state = await waitForNodeCount(page, 2, 150000);
    note(`[${viewport.name}] node 2 settled (long reply, sent via Enter after Shift+Enter newline): ${state.last}`);

    const graphAfterNode2 = await page.eval(`fetch('/api/canvas').then(r => r.json())`);
    const node2Id = graphAfterNode2.graph.nodeIds[1];
    r.node2PromptHasLineBreak = graphAfterNode2.graph.nodesById[node2Id].prompt.includes("\n");
    note(`[${viewport.name}] item6 persisted prompt keeps line break: ${r.node2PromptHasLineBreak}`);

    // ---- TES-107 Shape A: the trivial two-node conversation, checked
    // absolutely. This is the exact pair (root question, its own first
    // reply) TES-104 found rendering upside down (node1.y=342, node2.y=217)
    // — checked here, before any fork/four-deep shape exists, not after. ----
    const node1RectShapeA = await rectOf(page, `document.querySelector('[data-node-id="${node1Id}"]')`);
    const node2RectShapeA = await rectOf(page, `document.querySelector('[data-node-id="${node2Id}"]')`);
    const node1PosShapeA = graphAfterNode2.graph.nodesById[node1Id].position;
    const node2PosShapeA = graphAfterNode2.graph.nodesById[node2Id].position;
    r.shapeATwoNodeDownwardFlow = checkDownwardFlow(node2RectShapeA, node1RectShapeA, node2PosShapeA, node1PosShapeA);
    note(
      `[${viewport.name}] TES-107 Shape A (node1 -> node2) downward-flow: node1 rect=${JSON.stringify(node1RectShapeA)}, node2 rect=${JSON.stringify(node2RectShapeA)}, node1 pos=${JSON.stringify(node1PosShapeA)}, node2 pos=${JSON.stringify(node2PosShapeA)} -> ${JSON.stringify(r.shapeATwoNodeDownwardFlow)}`,
    );

    // ---- Item 3: node size ----
    const node2Rect = await rectOf(page, `document.querySelector('[data-node-id="${node2Id}"]')`);
    r.node2Size = { width: node2Rect.width, height: node2Rect.height };
    r.node2HeightExceeds232 = node2Rect.height > 232;
    note(`[${viewport.name}] item3 node2 size: ${JSON.stringify(r.node2Size)} (expect width ${viewport.nodeWidth}, height <= 640, > 232)`);
    await shot("02-node2-long-reply");

    // ---- Items 7/8: header actions on a normal complete node — no Edit, no Regenerate ----
    r.node2HeaderActions = await getHeaderActionLabels(page, node2Id);
    note(`[${viewport.name}] items7/8 header actions on node2: ${JSON.stringify(r.node2HeaderActions)}`);

    // ---- Item 6: Cmd+Enter still sends. Node 3. ----
    await focusComposer(page);
    await insertText(page, "Name one famous landmark there.");
    await pressEnter(page, { meta: true });
    state = await waitForNodeCount(page, 3, 150000);
    note(`[${viewport.name}] node 3 settled via Cmd+Enter: ${state.last}`);

    // ---- Item 6: mouse-click Send still works. Node 4. ----
    await focusComposer(page);
    await insertText(page, "What river runs through it?");
    await clickSelector(page, `document.querySelector('button[aria-label="Send"]')`);
    state = await waitForNodeCount(page, 4, 150000);
    note(`[${viewport.name}] node 4 settled via mouse-click Send: ${state.last}`);
    await shot("03-four-nodes-series");

    const preFork = await page.eval(`fetch('/api/canvas').then(r => r.json())`);
    const preForkNodeIds = preFork.graph.nodeIds.slice();
    const node3Id = preForkNodeIds[2];
    const node4Id = preForkNodeIds[3];
    // This account's canvas is shared across concurrent agent QA runs (per
    // repo convention — see other tickets' comments about a shared, rate-
    // limited test account). If something else wrote to it mid-run, that's
    // environmental contamination, not a product bug — fail loudly here
    // instead of silently branching against a graph that isn't the one this
    // run built.
    if (preForkNodeIds.length !== 4 || preForkNodeIds[0] !== node1Id || preForkNodeIds[1] !== node2Id) {
      throw new Error(
        `[${viewport.name}] canvas state changed under us before the fork step — expected exactly [${node1Id}, ${node2Id}, ...], got [${preForkNodeIds.join(", ")}]. Likely a concurrent write to the shared QA account, not a product bug.`,
      );
    }

    // ---- Item 5 + 9: branch off node 2 (not the newest node) ----
    const node2OnScreen = await panUntilVisible(page, node2Id, viewport);
    note(`[${viewport.name}] node2 scrolled into view before branch click: ${node2OnScreen}`);
    if (!node2OnScreen) throw new Error(`could not pan node 2 into view (${viewport.name})`);
    await shot("04-node2-in-view");

    const branchReady = await page.eval(`(() => {
      const groups = Array.from(document.querySelectorAll('[role="group"][aria-label^="Node,"]'));
      const node2 = groups[1];
      if (!node2 || node2.getAttribute('data-node-id') !== ${JSON.stringify(node2Id)}) return 'dom-order-mismatch';
      const btn = node2.querySelector('button[aria-label="Branch"]');
      if (!btn || btn.disabled) return 'branch-button-missing-or-disabled';
      const r = btn.getBoundingClientRect();
      if (r.y < 0 || r.bottom > window.innerHeight || r.x < 0 || r.right > window.innerWidth) return 'branch-button-off-screen';
      window.__branchBtnBox = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      return 'ready';
    })()`);
    note(`[${viewport.name}] branch target check: ${branchReady}`);
    if (branchReady !== "ready") throw new Error(`cannot branch node 2 (${viewport.name}): ${branchReady}`);
    const branchBox = await page.eval(`window.__branchBtnBox`);
    await click(page, branchBox.x, branchBox.y);
    await sleep(400);

    // Item 5: capture the skeleton's position — must appear on Branch, before
    // Send. Canvas-space (the slot's own translate), not screen-space: the
    // canvas can legitimately pan/auto-follow between now and when the real
    // card settles, and a screen-space comparison would mistake that pan for
    // "the card didn't land where the skeleton was".
    const skeletonPos = await slotCanvasPosition(page, `document.querySelector('.cv-node-slot[aria-hidden="true"]')`);
    const skeletonRectForShot = await rectOf(page, `document.querySelector('.cv-node-slot[aria-hidden="true"]')`);
    r.skeletonAppearedOnBranch = !!skeletonPos;
    note(`[${viewport.name}] item5 skeleton on Branch (before Send), canvas-space: ${JSON.stringify(skeletonPos)}, screen rect: ${JSON.stringify(skeletonRectForShot)}`);
    await shot("05-skeleton-before-send");

    // TES-118: a positive check on the Branch click itself, before typing —
    // distinguishes "click never registered" from "target lost between
    // Branch and Send", which the pixel-diff-only evidence in TES-107
    // couldn't tell apart.
    const composerTargetId = await page.eval(
      `document.querySelector('.cv-composer-target')?.getAttribute('data-composer-target-id') ?? null`,
    );
    r.composerBoundToNode2OnBranch = composerTargetId === node2Id;
    note(`[${viewport.name}] composer target after Branch click, before typing: ${composerTargetId} (want ${node2Id}) -> ${r.composerBoundToNode2OnBranch}`);
    if (!r.composerBoundToNode2OnBranch) {
      throw new Error(`[${viewport.name}] composer did not bind to node 2 after Branch click: got ${composerTargetId}, want ${node2Id}`);
    }

    await focusComposer(page);
    const forkText = "Tell me about deep sea vents instead.";
    await insertText(page, forkText);
    // Confirm the skeleton is still exactly where it was (typing shouldn't move it).
    const skeletonPosAfterType = await slotCanvasPosition(page, `document.querySelector('.cv-node-slot[aria-hidden="true"]')`);
    r.skeletonStableWhileTyping = JSON.stringify(skeletonPos) === JSON.stringify(skeletonPosAfterType);
    note(`[${viewport.name}] item5 skeleton stable while typing: ${r.skeletonStableWhileTyping}`);
    await pressEnter(page);
    await sleep(1000);
    await waitForNodeCount(page, 5, 150000);
    await sleep(1500);
    await shot("06-fork-settled");

    const postFork = await page.eval(`fetch('/api/canvas').then(r => r.json())`);
    const node5bId = postFork.graph.nodeIds.find((id) => !preForkNodeIds.includes(id));
    const forkFinalRect = await rectOf(page, `document.querySelector('[data-node-id="${node5bId}"]')`);
    const forkFinalPos = await slotCanvasPosition(page, `document.querySelector('[data-node-id="${node5bId}"]').closest('.cv-node-slot')`);

    // Item 5: the real card lands where the skeleton was — canvas-space, and
    // also cross-checked against the graph's own persisted position.
    const skeletonVsReal = skeletonPos && forkFinalPos ? { dx: forkFinalPos.x - skeletonPos.x, dy: forkFinalPos.y - skeletonPos.y } : null;
    const skeletonVsPersisted = skeletonPos ? { dx: postFork.graph.nodesById[node5bId].position.x - skeletonPos.x, dy: postFork.graph.nodesById[node5bId].position.y - skeletonPos.y } : null;
    r.skeletonVsRealCardOffset = skeletonVsReal;
    r.skeletonVsPersistedPositionOffset = skeletonVsPersisted;
    note(`[${viewport.name}] item5 skeleton vs real card, canvas-space offset: ${JSON.stringify(skeletonVsReal)}; vs persisted graph position: ${JSON.stringify(skeletonVsPersisted)}`);

    // ---- Regression: fork parented to node 2 (persisted, not pixels) ----
    const newNode = postFork.graph.nodesById[node5bId];
    r.forkParentedCorrectly = newNode?.parentId === node2Id;
    note(`[${viewport.name}] regression: fork persisted parentId=${newNode?.parentId} (want ${node2Id}) -> ${r.forkParentedCorrectly}`);

    // ---- Regression: no overlaps, distinct x between node3 and the fork ----
    const rects = await readCardRects(page);
    r.overlaps = findOverlaps(rects);
    const node3Rect = rects.find((x) => x.id === node3Id);
    const forkRect = rects.find((x) => x.id === node5bId);
    r.node3vsForkDistinctX = !!node3Rect && !!forkRect && node3Rect.x !== forkRect.x && !rectsOverlap(node3Rect, forkRect);
    note(`[${viewport.name}] regression: overlaps=${JSON.stringify(r.overlaps)}, node3-vs-fork distinct X=${r.node3vsForkDistinctX}`);

    // ---- Item 9: mindmap invariant — node2's two children (node3, fork) share a row, evenly distributed, node2 centered over them ----
    const node2RectNow = rects.find((x) => x.id === node2Id);
    r.siblingsSameRow = node3Rect.y === forkRect.y;
    const siblingMidX = (node3Rect.x + node3Rect.width / 2 + forkRect.x + forkRect.width / 2) / 2;
    const node2CenterX = node2RectNow.x + node2RectNow.width / 2;
    r.parentCenteredOverSiblings = Math.abs(siblingMidX - node2CenterX) <= 1;
    note(`[${viewport.name}] item9 siblings share row: ${r.siblingsSameRow}; parent centered over siblings (|${siblingMidX.toFixed(1)} - ${node2CenterX.toFixed(1)}| <= 1): ${r.parentCenteredOverSiblings}`);

    // ---- Item 9: every outbound wire leaves the bottom port, every inbound wire arrives at the top port ----
    const edges = await readEdgePaths(page);
    const edgeChecks = [];
    for (const [childId, parentId] of [
      [node2Id, node1Id],
      [node3Id, node2Id],
      [node4Id, node3Id],
      [node5bId, node2Id],
    ]) {
      const childPorts = await getPortCoords(page, childId);
      const parentPorts = await getPortCoords(page, parentId);
      if (!childPorts?.inbound || !parentPorts?.outbound) {
        edgeChecks.push({ childId, parentId, error: "missing port element" });
        continue;
      }
      let best = null;
      let bestScore = Infinity;
      for (const e of edges) {
        const score = dist(e.start, parentPorts.outbound) + dist(e.end, childPorts.inbound);
        if (score < bestScore) {
          bestScore = score;
          best = e;
        }
      }
      const startAtOutbound = best ? dist(best.start, parentPorts.outbound) <= 3 : false;
      const endAtInbound = best ? dist(best.end, childPorts.inbound) <= 3 : false;
      edgeChecks.push({ childId, parentId, startAtOutbound, endAtInbound });
    }
    r.edgeChecks = edgeChecks;
    note(`[${viewport.name}] item9 edge port-legibility: ${JSON.stringify(edgeChecks)}`);

    // ---- TES-107 Shape B: the same absolute downward-flow check across
    // every parent/child pair in the four-deep + fork graph. ----
    const posById = postFork.graph.nodesById;
    const rectById = Object.fromEntries(rects.map((rc) => [rc.id, rc]));
    const downwardFlowPairs = [
      [node1Id, node2Id],
      [node2Id, node3Id],
      [node3Id, node4Id],
      [node2Id, node5bId],
    ];
    r.shapeBDownwardFlow = downwardFlowPairs.map(([parentId, childId]) => ({
      parentId,
      childId,
      ...checkDownwardFlow(rectById[childId], rectById[parentId], posById[childId].position, posById[parentId].position),
    }));
    note(`[${viewport.name}] TES-107 Shape B downward-flow, all pairs: ${JSON.stringify(r.shapeBDownwardFlow)}`);
    r.allDownwardFlowOk =
      r.shapeATwoNodeDownwardFlow.domOk &&
      r.shapeATwoNodeDownwardFlow.graphOk &&
      r.shapeBDownwardFlow.every((p) => p.domOk && p.graphOk);
    note(`[${viewport.name}] TES-107 all downward-flow checks pass (dom + graph, Shape A and B): ${r.allDownwardFlowOk}`);

    // Fork-specific legibility (CEO's literal ask): the fork edge's start is
    // nearer node2's card than node3's or node4's.
    const node4Rect = rects.find((x) => x.id === node4Id);
    let forkEdge = null;
    let bestEndDist = Infinity;
    for (const e of edges) {
      const d = distToRectBoundary(e.end, forkRect);
      if (d < bestEndDist) {
        bestEndDist = d;
        forkEdge = e;
      }
    }
    const startDistToNode2 = forkEdge ? distToRectBoundary(forkEdge.start, node2RectNow) : Infinity;
    const startDistToNode3 = forkEdge ? distToRectBoundary(forkEdge.start, node3Rect) : Infinity;
    const startDistToNode4 = forkEdge ? distToRectBoundary(forkEdge.start, node4Rect) : Infinity;
    r.forkEdgeStartsAtNode2 = startDistToNode2 <= 2 && startDistToNode2 < startDistToNode3 && startDistToNode2 < startDistToNode4;
    note(`[${viewport.name}] item9 fork edge start distances -> node2/3/4: ${startDistToNode2.toFixed(1)}/${startDistToNode3.toFixed(1)}/${startDistToNode4.toFixed(1)}, unambiguous=${r.forkEdgeStartsAtNode2}`);

    // ---- Regression: wheel over a tall card's body scrolls the card, not the canvas ----
    const viewportBefore = await page.eval(`fetch('/api/canvas').then(r=>r.json()).then(s=>s.viewport)`);
    const cardBodyBox = await page.eval(`(() => {
      const card = document.querySelector('[data-node-id="${node2Id}"]');
      const body = card.querySelector('[data-node-role="body"]') || card;
      const r = body.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: cardBodyBox.x, y: cardBodyBox.y, deltaX: 0, deltaY: 200 });
    await sleep(400);
    const viewportAfterWheel = await page.eval(`fetch('/api/canvas').then(r=>r.json()).then(s=>s.viewport)`);
    r.wheelOverCardDidNotPanCanvas = viewportBefore.x === viewportAfterWheel.x && viewportBefore.y === viewportAfterWheel.y;
    note(`[${viewport.name}] regression: wheel-over-card left canvas viewport unchanged: ${r.wheelOverCardDidNotPanCanvas} (${JSON.stringify(viewportBefore)} -> ${JSON.stringify(viewportAfterWheel)})`);

    // ---- Regression: corner-drag resize ----
    const beforeResize = await rectOf(page, `document.querySelector('[data-node-id="${node2Id}"]')`);
    const handle = await page.eval(`(() => {
      const el = document.querySelector('[data-node-id="${node2Id}"] [aria-label="Resize card"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (handle) {
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", buttons: 1, clickCount: 1 });
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x + 60, y: handle.y + 60, button: "left", buttons: 1 });
      await sleep(100);
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x + 60, y: handle.y + 60, button: "left", buttons: 0 });
      await sleep(400);
    }
    const afterResize = await rectOf(page, `document.querySelector('[data-node-id="${node2Id}"]')`);
    r.cornerDragResizeWorked = !!handle && (afterResize.width !== beforeResize.width || afterResize.height !== beforeResize.height);
    note(`[${viewport.name}] regression: corner-drag resize changed size: ${r.cornerDragResizeWorked} (${beforeResize.width}x${beforeResize.height} -> ${afterResize.width}x${afterResize.height})`);
    await shot("07-after-resize");

    // ---- Regression: header chevron collapses a card's own body, not its children ----
    const foldResult = await page.eval(`(() => {
      const card = document.querySelector('[data-node-id="${node2Id}"]');
      const foldBtn = Array.from(card.querySelectorAll('.cv-node-actions button')).find((b) => (b.getAttribute('aria-label') || '').includes('Collapse to one line'));
      if (!foldBtn) return 'fold-button-missing';
      foldBtn.click();
      return 'clicked';
    })()`);
    await sleep(300);
    const childrenStillRendered = await page.eval(`!!document.querySelector('[data-node-id="${node3Id}"]')`);
    r.foldCollapsesOwnBodyOnly = foldResult === "clicked" && childrenStillRendered;
    note(`[${viewport.name}] regression: fold ${foldResult}, children still rendered=${childrenStillRendered}`);
    // undo the fold so later screenshots show full content
    await page.eval(`(() => {
      const card = document.querySelector('[data-node-id="${node2Id}"]');
      const foldBtn = Array.from(card.querySelectorAll('.cv-node-actions button')).find((b) => (b.getAttribute('aria-label') || '').includes('Show full reply'));
      foldBtn?.click();
    })()`);
    await sleep(300);

    await shot("08-four-deep-with-fork-final");

    // ---- Regression: reload preserves ids, parents, text, positions ----
    const preReload = await page.eval(`fetch('/api/canvas').then(r => r.json())`);
    await page.navigate(`${BASE}/canvas`);
    await sleep(1500);
    await shot("09-after-reload");
    const postReload = await page.eval(`fetch('/api/canvas').then(r => r.json())`);
    const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));
    r.reloadPreservesGraph =
      sameSet(preReload.graph.nodeIds, postReload.graph.nodeIds) &&
      preReload.graph.nodeIds.every((id) => {
        const a = preReload.graph.nodesById[id];
        const b = postReload.graph.nodesById[id];
        return a.parentId === b.parentId && a.prompt === b.prompt && a.response === b.response && a.position.x === b.position.x && a.position.y === b.position.y;
      });
    note(`[${viewport.name}] regression: reload preserves ids/parents/text/positions: ${r.reloadPreservesGraph}`);

    // ---- Items 7/8 continued: interrupted-state Continue/Regenerate footer
    // still works. Done last, on its own extra node, so it can't distort the
    // four-deep-plus-fork shape or indices used above. ----
    await focusComposer(page);
    await insertText(page, "Write a long, slow, multi-paragraph explanation of how glaciers carve valleys, in detail.");
    await pressEnter(page);
    const gotStopButton = await waitForStopButton(page, 30000);
    note(`[${viewport.name}] interrupt-test node reached a real Stop-generating button: ${gotStopButton}`);
    // The Stop button itself only requires *thinking* or *response* text to
    // be non-empty; Continue only renders once *response* has something in
    // it. Poll a little further so we interrupt after real response text
    // has started, not just "thinking" — otherwise Continue never has
    // anything to test.
    let stopClicked = false;
    if (gotStopButton) {
      let elapsed = 0;
      let hasResponseText = false;
      while (elapsed < 10000) {
        const g = await page.eval(`fetch('/api/canvas').then(r => r.json())`);
        const lastId = g.graph.nodeIds[g.graph.nodeIds.length - 1];
        hasResponseText = (g.graph.nodesById[lastId]?.response ?? "").trim().length > 0;
        if (hasResponseText) break;
        await sleep(300);
        elapsed += 300;
      }
      note(`[${viewport.name}] interrupt-test node has visible response text before stopping: ${hasResponseText}`);
      stopClicked = await page.eval(`(() => {
        const btn = document.querySelector('button[aria-label="Stop generating"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
    }
    note(`[${viewport.name}] clicked Stop generating: ${stopClicked}`);
    await sleep(800);
    const interruptedLabel = await page.eval(`(() => {
      const groups = Array.from(document.querySelectorAll('[role="group"][aria-label^="Node,"]'));
      return groups[groups.length - 1]?.getAttribute('aria-label');
    })()`);
    r.reachedInterrupted = !!interruptedLabel && interruptedLabel.endsWith(", interrupted");
    note(`[${viewport.name}] interrupt-test node status after Stop: ${interruptedLabel}`);
    const graphAtInterrupt = await page.eval(`fetch('/api/canvas').then(r => r.json())`);
    const interruptNodeId = graphAtInterrupt.graph.nodeIds[graphAtInterrupt.graph.nodeIds.length - 1];
    r.interruptedFooterButtons = await page.eval(`(() => {
      const card = document.querySelector('[data-node-id="${interruptNodeId}"]');
      if (!card) return null;
      return Array.from(card.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean);
    })()`);
    note(`[${viewport.name}] items7/8 interrupted-state footer buttons: ${JSON.stringify(r.interruptedFooterButtons)}`);
    await shot("10-interrupted-node");
    if (r.reachedInterrupted) {
      const continueClicked = await page.eval(`(() => {
        const card = document.querySelector('[data-node-id="${interruptNodeId}"]');
        const btn = Array.from(card.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Continue');
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      note(`[${viewport.name}] clicked Continue on interrupted node: ${continueClicked}`);
      // Continue does not resume streaming into the same node — it calls
      // createAndStream(nodeId, CONTINUE_PROMPT), branching a *new* child
      // with that fixed prompt (use-canvas-controller.ts). So the check is
      // "did that child appear and make progress", not "did this node's own
      // status change" — it never does, by design.
      await sleep(3000);
      const afterContinue = await page.eval(`fetch('/api/canvas').then(r => r.json())`);
      const continuationId = afterContinue.graph.nodeIds[afterContinue.graph.nodeIds.length - 1];
      const continuation = afterContinue.graph.nodesById[continuationId];
      r.continueCreatedContinuationChild = continuation?.parentId === interruptNodeId && continuation?.prompt === "Continue from where you left off.";
      r.continueContinuationStatus = continuation?.status;
      r.continueResumedGeneration = r.continueCreatedContinuationChild && continuation?.status !== "error";
      note(`[${viewport.name}] Continue created a continuation child off the interrupted node: ${r.continueCreatedContinuationChild}, its status: ${r.continueContinuationStatus} (resumed=${r.continueResumedGeneration})`);
    } else {
      note(`[${viewport.name}] (non-fatal) never reached interrupted status — Continue/Regenerate footer not exercised this run.`);
    }

    r.node1Id = node1Id;
    r.node2Id = node2Id;
    r.node3Id = node3Id;
    r.node4Id = node4Id;
    r.forkId = node5bId;
  });
}

let priorLog = "";
try {
  priorLog = (await readFile(join(OUT, "log.txt"), "utf8")) + "\n";
} catch {
  // fresh
}
await writeFile(join(OUT, "log.txt"), priorLog + log.join("\n"));
await writeFile(join(OUT, "results.json"), JSON.stringify(results, null, 2));
note(`\nDone. See ${OUT}`);
note(`\n*** SCREENSHOTS NEED HUMAN/VISUAL JUDGMENT ***`);
note(`Inspect ${OUT}/desktop-08-four-deep-with-fork-final.png and ${OUT}/mobile-08-four-deep-with-fork-final.png:`);
note(`CEO's own test — if it is NOT visually obvious at a glance which card the fork line comes from, item 9 is a FAIL regardless of the coordinate assertions above.`);
