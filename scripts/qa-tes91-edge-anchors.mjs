#!/usr/bin/env node
/**
 * TES-91: hand-verification harness for the side-anchored edge fix.
 *
 * Seeds a four-deep chain (node1 -> node2 -> node3 -> node4) plus a fork off
 * node2 (node5), with node2's own card stretched to ~300px so a tall card is
 * present in the canvas per the ticket's acceptance criteria. Screenshots
 * the resting canvas and the post-Tidy canvas at both required viewports so
 * the "can you tell at a glance which card the fork came from" test can be
 * checked visually.
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/qa-tes91-edge-anchors.mjs --base http://localhost:4317
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withPage, sleep, parseArgs } from "./lib/cdp.mjs";
import { saveKey } from "../src/lib/keys.ts";
import { query } from "../src/lib/db.ts";
import { createGraph, addNode, appendText, completeNode } from "../src/lib/conversation/graph.ts";
import { autoPlaceOnCreate } from "../src/lib/canvas/layout.ts";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "http://localhost:4317").replace(/\/$/, "");
const OUT = args.out ?? "./shots/tes-91";
const EMAIL = `qa-tes91-edges+${Date.now()}@example.com`;
const PASSWORD = "Tes91EdgeAnchors!23456";

// ~300px card: long enough to trigger the height defect TES-77 fixed, short
// of TES-80's ~420px tallcard fixture (that gap is already covered).
const TALL_ANSWER = Array.from(
  { length: 90 },
  (_, i) => `Paragraph ${i + 1}: deep sea vents host chemosynthetic ecosystems that do not depend on sunlight.`,
).join("\n\n");

function buildSeedGraph() {
  let graph = createGraph();
  let parentId = null;
  let now = Date.now() - 100000;
  const chainIds = [];
  for (let i = 1; i <= 4; i++) {
    const id = `seed-node-${i}`;
    const position = autoPlaceOnCreate(graph, parentId, 320);
    const { graph: g2 } = addNode(graph, { id, parentId, prompt: `prompt ${i}`, position, now });
    graph = g2;
    const answer = i === 2 ? TALL_ANSWER : `answer ${i}`;
    graph = appendText(graph, id, answer, now + 1);
    graph = completeNode(graph, id, { inputTokens: 10, outputTokens: 10 }, now + 2);
    chainIds.push(id);
    parentId = id;
    now += 10000;
  }
  // Fork off node2, mirroring autoPlaceOnCreate's own placement so the seed
  // matches what a real branch action would produce.
  const forkParent = "seed-node-2";
  const forkPosition = autoPlaceOnCreate(graph, forkParent, 320);
  const { graph: g3 } = addNode(graph, {
    id: "seed-node-5-fork",
    parentId: forkParent,
    prompt: "Tell me about deep sea vents instead.",
    position: forkPosition,
    now,
  });
  graph = g3;
  graph = appendText(graph, "seed-node-5-fork", "Deep sea vents draw energy from mineral-rich water.", now + 1);
  graph = completeNode(graph, "seed-node-5-fork", { inputTokens: 10, outputTokens: 10 }, now + 2);

  return { graph, viewport: { x: 40, y: 40, zoom: 0.8 }, selectedNodeId: null, hasBranchedOnce: true };
}

let userId = null;
try {
  await mkdir(OUT, { recursive: true });

  await withPage(async (p) => {
    const shot = async (name, viewportLabel) => {
      const buf = await p.screenshot();
      await writeFile(join(OUT, `${viewportLabel}-${name}.png`), buf);
      console.log(`  shot: ${viewportLabel}-${name}.png`);
    };

    await p.emulate({ width: 1440, height: 900 });
    await p.navigate(`${BASE}/sign-up`);
    const fillJs = (selector, value) => `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`;
    await p.eval(fillJs("#email", EMAIL));
    await p.eval(fillJs("#password", PASSWORD));
    await p.eval(`document.querySelector('button[type="submit"]').click()`);
    await sleep(1500);

    const rows = await query("select id from users where email = $1", [EMAIL]);
    if (rows.length === 0) throw new Error("user row not found after sign-up: " + EMAIL);
    userId = rows[0].id;
    await saveKey(userId, "anthropic", "sk-ant-fake-testing-key-for-tes91-00000000");

    const seedState = buildSeedGraph();
    await p.eval(`fetch('/api/canvas', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(seedState))},
    })`);

    const VIEWPORTS = [
      { name: "desktop", width: 1440, height: 900, mobile: false },
      { name: "mobile", width: 390, height: 844, mobile: true },
    ];

    for (const viewport of VIEWPORTS) {
      console.log(`\n=== viewport ${viewport.name} (${viewport.width}x${viewport.height}) ===`);
      await p.emulate({ ...viewport, scheme: "light" });
      await p.navigate(`${BASE}/canvas`);
      await sleep(1200);
      await shot("01-resting", viewport.name);

      const rects = await p.eval(`(() => {
        const els = Array.from(document.querySelectorAll('[data-node-id]'));
        return Object.fromEntries(els.map((el) => {
          const r = el.getBoundingClientRect();
          return [el.getAttribute('data-node-id'), { x: r.x, y: r.y, width: r.width, height: r.height }];
        }));
      })()`);
      console.log("  card rects:", JSON.stringify(rects));

      const tidyClicked = await p.eval(`(() => {
        const btn = document.querySelector('[aria-label="Tidy"], button[title*="idy" i]');
        if (btn) { btn.click(); return true; }
        return false;
      })()`);
      if (tidyClicked) {
        await sleep(500);
        await shot("02-after-tidy", viewport.name);
      } else {
        console.log("  (Tidy control not found at this viewport, skipping post-tidy shot)");
      }
    }
  });
} finally {
  if (userId) {
    await query("delete from provider_keys where user_id = $1", [userId]);
    await query("delete from canvas_state where user_id = $1", [userId]).catch(() => {});
    await query("delete from sessions where user_id = $1", [userId]).catch(() => {});
    await query("delete from users where id = $1", [userId]);
  }
}

console.log("\nDone.");
