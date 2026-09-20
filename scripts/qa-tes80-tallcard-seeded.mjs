#!/usr/bin/env node
/**
 * TES-80's last untested variable: the original TES-79 repro branched off a
 * node whose own card was ~420px tall (a long stored reply), not an ordinary
 * short card. qa-tes80-branch-and-layout.mjs (TES-80's own regression check)
 * and qa-tes80-recheck-live.mjs (TES-84) both branched off short cards and
 * found no defect; qa-tes80-tallcard-check.mjs tried to isolate height live
 * but was inconclusive because the long reply hadn't finished streaming
 * within the poll window.
 *
 * This closes that gap the cheap way TES-84 suggested: seed node 2's stored
 * response directly with ~10k characters (matching TES-79's exact card
 * height) instead of a live Anthropic call, then branch off node 2
 * specifically with the same real-click sequence and assert parentId +
 * sibling x-distinctness, auto-placed and after Tidy.
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/qa-tes80-tallcard-seeded.mjs --base http://localhost:4317
 */
import { withPage, sleep, parseArgs } from "./lib/cdp.mjs";
import { saveKey } from "../src/lib/keys.ts";
import { query } from "../src/lib/db.ts";
import { createGraph, addNode, appendText, completeNode } from "../src/lib/conversation/graph.ts";
import { autoPlaceOnCreate } from "../src/lib/canvas/layout.ts";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "http://localhost:4317").replace(/\/$/, "");
const EMAIL = `qa-tes80-tallcard+${Date.now()}@example.com`;
const PASSWORD = "Tes80TallCard!23456";

// ~10.5k chars, matching TES-79's reported card height (420px) for a long reply.
const TALL_ANSWER = Array.from(
  { length: 140 },
  (_, i) => `Paragraph ${i + 1}: deep sea vents host chemosynthetic ecosystems that do not depend on sunlight, instead drawing energy from mineral-rich, superheated water venting from the seafloor.`,
).join("\n\n");

function buildSeedGraph() {
  let graph = createGraph();
  let parentId = null;
  let now = Date.now() - 100000;
  for (let i = 1; i <= 4; i++) {
    const id = `seed-node-${i}`;
    const position = autoPlaceOnCreate(graph, parentId, 320);
    const { graph: g2 } = addNode(graph, { id, parentId, prompt: `prompt ${i}`, position, now });
    graph = g2;
    const answer = i === 2 ? TALL_ANSWER : `answer ${i}`;
    graph = appendText(graph, id, answer, now + 1);
    graph = completeNode(graph, id, { inputTokens: 10, outputTokens: 10 }, now + 2);
    parentId = id;
    now += 10000;
  }
  return { graph, viewport: { x: 0, y: 0, zoom: 1 }, selectedNodeId: null, hasBranchedOnce: false };
}

const fillJs = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

const click = async (p, x, y) => {
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
};

const rectsById = async (p) =>
  p.eval(`(() => {
    const els = Array.from(document.querySelectorAll('[data-node-id]'));
    return Object.fromEntries(els.map((el) => {
      const r = el.getBoundingClientRect();
      return [el.getAttribute('data-node-id'), { x: r.x, y: r.y, height: r.height }];
    }));
  })()`);

let userId = null;
const failures = [];
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failures.push(label);
};

try {
  await withPage(async (p) => {
    await p.emulate({ width: 1440, height: 900 });

    await p.navigate(`${BASE}/sign-up`);
    await p.eval(fillJs("#email", EMAIL));
    await p.eval(fillJs("#password", PASSWORD));
    await p.eval(`document.querySelector('button[type="submit"]').click()`);
    await sleep(1500);

    const rows = await query("select id from users where email = $1", [EMAIL]);
    if (rows.length === 0) throw new Error("user row not found after sign-up: " + EMAIL);
    userId = rows[0].id;
    await saveKey(userId, "anthropic", "sk-ant-fake-testing-key-for-tes80-tallcard-00000000");

    const seedState = buildSeedGraph();
    await p.eval(`fetch('/api/canvas', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(seedState))},
    })`);

    await p.navigate(`${BASE}/canvas`);
    await sleep(1500);

    const preRects = await rectsById(p);
    check(
      "seeded node 2's card is genuinely tall (>= 300px, matching TES-79's ~420px)",
      (preRects["seed-node-2"]?.height ?? 0) >= 300,
    );

    const branchReady = await p.eval(`(() => {
      const groups = Array.from(document.querySelectorAll('[role="group"][aria-label^="Node,"]'));
      const node2 = groups[1];
      if (!node2) return "node-2-not-found";
      const btn = node2.querySelector('button[aria-label="Branch"]');
      if (!btn || btn.disabled) return "branch-button-missing-or-disabled";
      const r = btn.getBoundingClientRect();
      window.__branchBox = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      return "ready";
    })()`);
    if (branchReady !== "ready") throw new Error("cannot branch node 2: " + branchReady);

    const preFork = await p.eval(`fetch('/api/canvas').then(r => r.json())`);
    const preForkIds = preFork.graph.nodeIds.slice();
    const node2Id = preForkIds[1];

    const branchBox = await p.eval(`window.__branchBox`);
    await click(p, branchBox.x, branchBox.y);
    await sleep(500);

    await clickSelector(p, `document.querySelector('textarea')`);
    await sleep(300);
    await p.eval(fillJs("textarea", "Tell me about deep sea vents instead."));
    await clickSelector(p, `document.querySelector('button[aria-label="Send"]')`);
    await sleep(1500);

    const postFork = await p.eval(`fetch('/api/canvas').then(r => r.json())`);
    const newNodeId = postFork.graph.nodeIds.find((id) => !preForkIds.includes(id));
    const newNode = newNodeId ? postFork.graph.nodesById[newNodeId] : null;
    check("branch off the tall-card node parents the new node correctly", newNode?.parentId === node2Id);

    await sleep(500);
    const rectsAuto = await rectsById(p);
    check(
      "auto-placed siblings of the tall-card node land at distinct x",
      rectsAuto["seed-node-3"]?.x !== rectsAuto[newNodeId]?.x,
    );

    const tidyClicked = await p.eval(`(() => {
      const btn = document.querySelector('[aria-label="Tidy"], button[title*="idy" i]');
      if (btn) { btn.click(); return true; }
      return false;
    })()`);
    if (!tidyClicked) throw new Error("Tidy button not found");
    await sleep(500);
    const rectsTidy = await rectsById(p);
    check(
      "Tidy keeps siblings of the tall-card node at distinct x",
      rectsTidy["seed-node-3"]?.x !== rectsTidy[newNodeId]?.x,
    );
  });
} finally {
  if (userId) {
    await query("delete from provider_keys where user_id = $1", [userId]);
    await query("delete from canvas_state where user_id = $1", [userId]).catch(() => {});
    await query("delete from sessions where user_id = $1", [userId]).catch(() => {});
    await query("delete from users where id = $1", [userId]);
  }
}

console.log(failures.length === 0 ? "\nOVERALL: PASS" : `\nOVERALL: FAIL (${failures.length})`);
process.exitCode = failures.length === 0 ? 0 : 1;
