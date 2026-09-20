#!/usr/bin/env node
/**
 * TES-80 regression: "Branch on a non-newest node, click the composer before
 * typing, then send" must create a child of the branched-from node (not the
 * most recent leaf — the TES-74 failure mode), AND that node's two children
 * must land at distinct x, auto-placed and after Tidy (the TES-77/78 failure
 * mode).
 *
 * Unlike the other qa-tes*.mjs scripts, this one needs no live account, no
 * QA_TEST_ACCOUNT_PASSWORD, and no Anthropic key: it signs up a throwaway
 * local account, seeds a fake `provider_keys` row directly (bypassing the
 * live key-validation `/api/keys` would otherwise require) and a 4-node
 * chain via `PUT /api/canvas`, then drives the real click sequence in a real
 * browser against a real dev server. `send()` sets a new node's `parentId`
 * synchronously from `effectiveComposerTarget`, before the fetch to
 * `/api/chat` is even issued, so a real model response is never needed to
 * check it — only a local dev server (`next dev`) and its own DATABASE_URL /
 * KEY_VAULT_ENCRYPTION_KEY, which is why this only runs locally, not against
 * a deployed base URL.
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/qa-tes80-branch-and-layout.mjs --base http://localhost:4317
 */
import { withPage, sleep, parseArgs } from "./lib/cdp.mjs";
import { saveKey } from "../src/lib/keys.ts";
import { query } from "../src/lib/db.ts";
import { createGraph, addNode, appendText, completeNode } from "../src/lib/conversation/graph.ts";
import { autoPlaceOnCreate } from "../src/lib/canvas/layout.ts";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "http://localhost:4317").replace(/\/$/, "");
const EMAIL = `qa-tes80-regression+${Date.now()}@example.com`;
const PASSWORD = "Tes80Regression!23456";

function buildSeedGraph() {
  let graph = createGraph();
  let parentId = null;
  let now = Date.now() - 100000;
  for (let i = 1; i <= 4; i++) {
    const id = `seed-node-${i}`;
    const position = autoPlaceOnCreate(graph, parentId, 320);
    const { graph: g2 } = addNode(graph, { id, parentId, prompt: `prompt ${i}`, position, now });
    graph = g2;
    graph = appendText(graph, id, `answer ${i}`, now + 1);
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
      return [el.getAttribute('data-node-id'), { x: r.x, y: r.y }];
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
    await saveKey(userId, "anthropic", "sk-ant-fake-testing-key-for-tes80-regression-00000000");

    const seedState = buildSeedGraph();
    await p.eval(`fetch('/api/canvas', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(seedState))},
    })`);

    await p.navigate(`${BASE}/canvas`);
    await sleep(1500);

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
    check("branch from a non-newest node parents the new node correctly", newNode?.parentId === node2Id);

    // node2 now has two children: seed-node-3 (from the seed chain) and the
    // new fork — assert §2.4's real assertion: distinct x, not just "no overlap".
    await sleep(500);
    const rectsAuto = await rectsById(p);
    check(
      "auto-placed siblings land at distinct x",
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
      "Tidy keeps siblings at distinct x",
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
