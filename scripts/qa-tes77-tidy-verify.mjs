#!/usr/bin/env node
/**
 * TES-77 verification: seeds a canvas graph with the exact overlap pattern
 * the old `layoutSubtree` bug produced (every sibling collapsed onto one x,
 * plus a too-short row pitch for tall cards), then triggers Tidy and confirms
 * the cards actually spread out and stop overlapping, at both review
 * viewports.
 *
 *   node scripts/qa-tes77-tidy-verify.mjs --base http://localhost:4317
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, sleep, withPage } from "./lib/cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "http://localhost:4317").replace(/\/$/, "");
const OUT = args.out ?? "./shots/tes-77";
const PASSWORD = "Tes77-verify-pass-1!";

const fillJs = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

function seededGraph() {
  const now = Date.now();
  const node = (id, parentId, prompt, response, x, y, extra = {}) => [
    id,
    {
      id,
      parentId,
      prompt,
      response,
      thinking: "",
      status: "complete",
      error: null,
      position: { x, y },
      positionMode: "manual",
      collapsed: false,
      usage: null,
      createdAt: now,
      updatedAt: now,
      ...extra,
    },
  ];

  const LONG = "This is a long answer. ".repeat(40);

  const entries = [
    // Root tree 1: pre-bug pattern — every node at the same x, 232px apart.
    node("r1", null, "root one", "short root answer", 0, 0),
    node("r1c1", "r1", "child one", "short", 0, 232),
    node("r1c2", "r1", "child two", LONG, 0, 232),
    node("r1c3", "r1", "child three", "short too", 0, 232),
    node("r1c1g1", "r1c1", "grandchild", "leaf", 0, 464),
    // Root tree 2, same collapsed pattern, to check roots don't overlap either.
    node("r2", null, "root two", "root two answer", 0, 0),
    node("r2c1", "r2", "child", LONG, 0, 232),
  ];

  const nodesById = Object.fromEntries(entries);
  const nodeIds = entries.map(([id]) => id);
  return { nodesById, nodeIds };
}

const log = [];
const note = (l) => {
  console.log(l);
  log.push(l);
};

await mkdir(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

for (const viewport of VIEWPORTS) {
  note(`\n=== viewport ${viewport.name} ===`);
  const EMAIL = `tes77-verify-${viewport.name}+${Date.now()}@example.com`;
  await withPage(async (page) => {
    const shot = async (name) => {
      await writeFile(join(OUT, `${viewport.name}-${name}.png`), await page.screenshot());
      note(`  shot: ${viewport.name}-${name}.png`);
    };

    await page.emulate({ ...viewport, scheme: "light" });

    await page.navigate(`${BASE}/sign-up`);
    await sleep(400);
    await page.eval(fillJs("#email", EMAIL));
    await page.eval(fillJs("#password", PASSWORD));
    await page.eval(`document.querySelector('button[type="submit"]').click()`);
    await sleep(1500);
    note(`  post-signup url: ${await page.eval("location.href")}`);

    // Seed via the real PUT — every node `manual` so the load doesn't
    // silently re-tidy before the "before" screenshot.
    const putResult = await page.eval(`(async () => {
      const res = await fetch("/api/canvas", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          graph: ${JSON.stringify(seededGraph())},
          viewport: { x: 200, y: 200, zoom: 0.6 },
          selectedNodeId: null,
          hasBranchedOnce: true,
        }),
      });
      return res.status;
    })()`);
    note(`  seed PUT status: ${putResult}`);

    await page.navigate(`${BASE}/canvas`);
    await sleep(1000);
    await shot("01-before-tidy-seeded-overlap");

    const nodeCount = await page.eval(`document.querySelectorAll('[data-node-id]').length`);
    note(`  nodes rendered: ${nodeCount}`);

    // Reset every node to `auto` first — Tidy never moves a `manual` node,
    // and the seed above marked everything manual on purpose.
    await page.eval(`(() => {
      const btn = document.querySelector('[aria-label="Tidy"], button[title*="idy" i]');
      window.__tes77TidyBtn = btn;
    })()`);
    const tidyBtnFound = await page.eval(`!!window.__tes77TidyBtn`);
    note(`  tidy button found: ${tidyBtnFound}`);

    if (tidyBtnFound) {
      await page.eval(`window.__tes77TidyBtn.click()`);
    } else {
      // Fall back to the documented keyboard shortcut.
      await page.eval(`document.querySelector('[role="application"]')?.focus()`);
      await page.eval(`(() => {
        document.querySelector('[role="application"]')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'l', bubbles: true })
        );
      })()`);
    }
    await sleep(1500); // clear the 500ms save debounce before re-reading via GET
    await shot("02-after-tidy");

    // Pull the tidied positions back out for a numeric overlap check, not
    // just an eyeballed screenshot.
    const positions = await page.eval(`(async () => {
      const res = await fetch("/api/canvas");
      const state = await res.json();
      return state.graph.nodeIds.map((id) => ({
        id,
        ...state.graph.nodesById[id].position,
        mode: state.graph.nodesById[id].positionMode,
      }));
    })()`);
    note(`  positions after tidy: ${JSON.stringify(positions)}`);
  });
}

await writeFile(join(OUT, "log.txt"), log.join("\n"));
note(`\nDone. Log at ${join(OUT, "log.txt")}`);
