#!/usr/bin/env node
/**
 * TES-80 re-check: Frontend Engineer's local/seeded harness (1b82d92) could
 * not reproduce the composer-click mis-parenting or the single-column Tidy
 * layout on 04cd6f4. This re-runs the same two assertions live, against the
 * QA test account's existing graph (no clean-canvas reset, to avoid burning
 * more real completions), on whatever commit /api/health currently reports.
 *
 *   QA_TEST_ACCOUNT_PASSWORD=... node scripts/qa-tes80-recheck-live.mjs --base https://node-canvas-chat.vercel.app
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, sleep, withPage } from "./lib/cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "https://node-canvas-chat.vercel.app").replace(/\/$/, "");
const OUT = args.out ?? "./shots/tes-80-recheck";
const EMAIL = "platform-eng-tes67-verify+1789859719@example.com";
const PASSWORD = process.env.QA_TEST_ACCOUNT_PASSWORD;
if (!PASSWORD) {
  console.error("Set QA_TEST_ACCOUNT_PASSWORD in the environment (not on the command line).");
  process.exit(1);
}

const fillJs = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

await mkdir(OUT, { recursive: true });
const log = [];
const note = (l) => {
  console.log(l);
  log.push(l);
};

await withPage(async (page) => {
  const shot = async (name) => {
    await writeFile(join(OUT, `${name}.png`), await page.screenshot());
  };

  await page.emulate({ width: 1440, height: 900, scale: 1, mobile: false, scheme: "light" });

  await page.navigate(`${BASE}/sign-in`);
  await page.eval(fillJs("#email", EMAIL));
  await page.eval(fillJs("#password", PASSWORD));
  await page.eval(`document.querySelector('button[type="submit"]').click()`);
  await sleep(2500);

  await page.navigate(`${BASE}/canvas`);
  await sleep(1500);

  // Fit the whole graph in view first — otherwise an early node can sit
  // above/below the viewport (negative getBoundingClientRect y) and a
  // "click" on it is a silent no-op that still returns as if it worked.
  const zoomToFitClicked = await page.eval(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Zoom to fit');
    if (b) { b.click(); return true; }
    return false;
  })()`);
  note(`Zoom to fit clicked: ${zoomToFitClicked}`);
  await sleep(800);

  const groupsBefore = await page.eval(`Array.from(document.querySelectorAll('[role="group"][aria-label^="Node,"]')).map((g, i) => ({ i, label: g.getAttribute('aria-label'), rect: g.getBoundingClientRect() }))`);
  note(`nodes before: ${JSON.stringify(groupsBefore)}`);
  if (groupsBefore.length < 2) {
    note("Need at least 2 existing nodes to branch off a non-newest one. Aborting.");
    return;
  }

  // Branch off an early node (not the newest), matching TES-80's repro shape.
  // Index bumped from the prior (flawed, .focus()-based) run so this targets
  // a node that doesn't already have a branch from that run.
  const targetIndex = Number(args.targetIndex ?? 3);
  const targetInfo = await page.eval(`(() => {
    const groups = Array.from(document.querySelectorAll('[role="group"][aria-label^="Node,"]'));
    const target = groups[${targetIndex}];
    const rect = target.getBoundingClientRect();
    const btn = target.querySelector('button[aria-label="Branch"]');
    if (!btn) return { ok: false, reason: "no-branch-button" };
    const brect = btn.getBoundingClientRect();
    return { ok: true, targetLabel: target.getAttribute("aria-label"), x: brect.x + brect.width / 2, y: brect.y + brect.height / 2 };
  })()`);
  note(`branch target (index ${targetIndex}): ${JSON.stringify(targetInfo)}`);
  if (!targetInfo.ok) {
    note("Target node has no clickable Branch button (likely disabled/dead-end). Aborting.");
    return;
  }
  if (targetInfo.y < 0 || targetInfo.y > 900 || targetInfo.x < 0 || targetInfo.x > 1440) {
    note(`Branch button is outside the viewport (${targetInfo.x}, ${targetInfo.y}) even after Zoom to fit — a click here would silently miss. Aborting rather than reporting a false result.`);
    return;
  }

  const clickPoint = targetInfo.ok ? targetInfo : null;
  if (clickPoint) {
    const common = { x: clickPoint.x, y: clickPoint.y, button: "left", clickCount: 1, buttons: 1 };
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common, buttons: 0 });
  }
  await sleep(500);

  const targetNodeId = await page.eval(`(() => {
    const groups = Array.from(document.querySelectorAll('[role="group"][aria-label^="Node,"]'));
    return groups[${targetIndex}].getAttribute('data-node-id') || null;
  })()`);
  note(`target node's data-node-id (may be null if not exposed): ${targetNodeId}`);

  const composerTargetAfterBranch = await page.eval(`document.querySelector('textarea')?.previousElementSibling?.textContent`);
  note(`composer target right after Branch click: ${JSON.stringify(composerTargetAfterBranch)}`);
  await shot("01-after-branch-click");

  // The TES-80/TES-74 repro is specifically a real mouse *click* on the
  // composer textarea before typing — not a programmatic .focus(). The
  // first run of this script used .focus() and found nothing broken; that
  // is not equivalent and not evidence either way. Dispatch a real click.
  const textareaBox = await page.eval(`(() => {
    const el = document.querySelector('textarea');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  note(`textarea box for real click: ${JSON.stringify(textareaBox)}`);
  if (textareaBox) {
    const common = { x: textareaBox.x, y: textareaBox.y, button: "left", clickCount: 1, buttons: 1 };
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common, buttons: 0 });
  }
  await sleep(300);
  const composerTargetAfterFocus = await page.eval(`document.querySelector('textarea')?.previousElementSibling?.textContent`);
  note(`composer target after the real click on the textarea (this is TES-80's exact trigger): ${JSON.stringify(composerTargetAfterFocus)}`);

  const prompt = `TES-80 recheck, say OK. (${Date.now()})`;
  await page.eval(fillJs("textarea", prompt));
  await sleep(300);
  await shot("02-composer-filled");

  const nodeCountBefore = groupsBefore.length;
  const sendClicked = await page.eval(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Send');
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  })()`);
  note(`Send clicked: ${sendClicked}`);

  let finalStatus = "not-sent";
  if (sendClicked) {
    let elapsedMs = 0;
    finalStatus = "still-pending-at-60s";
    while (elapsedMs < 60000) {
      await sleep(3000);
      elapsedMs += 3000;
      const groups = await page.eval(`Array.from(document.querySelectorAll('[role="group"][aria-label^="Node,"]')).map(g => g.getAttribute('aria-label'))`);
      const last = groups[groups.length - 1];
      if (last && /complete|error|interrupted/.test(last)) {
        finalStatus = last;
        break;
      }
    }
  }
  note(`final status of new node: ${finalStatus}`);
  await shot("03-after-send");

  // Read back the graph via the API to get real parentId, not guessed from DOM order.
  // Shape: { graph: { nodeIds: string[], nodesById: Record<id, Node> } }
  const canvasJson = await page.eval(`fetch('/api/canvas').then(r => r.json()).then(j => JSON.stringify(j))`);
  const canvasState = JSON.parse(canvasJson);
  const nodesById = canvasState.graph.nodesById;
  const allNodes = canvasState.graph.nodeIds.map((id) => nodesById[id]);
  note(`GET /api/canvas node count: ${allNodes.length}`);

  const branchTargetId = targetNodeId;
  const newestNode = allNodes.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).at(-1);
  const newestParentId = newestNode?.parentId;

  note(`branch target id (from DOM data-node-id): ${branchTargetId}`);
  note(`newest node id: ${newestNode?.id}, its parentId: ${newestParentId}`);

  const parentedCorrectly = branchTargetId != null && newestParentId === branchTargetId;
  note(`RESULT — new node's parentId === clicked branch target's id: ${parentedCorrectly}`);

  // Layout check: siblings of the branch target should sit at distinct x.
  const siblings = allNodes.filter((n) => n.parentId === branchTargetId);
  note(`siblings of branch target (${siblings.length}): ${JSON.stringify(siblings.map((s) => ({ id: s.id, x: s.position?.x })))}`);
  const xs = siblings.map((s) => s.position?.x);
  const distinctX = siblings.length > 1 && new Set(xs).size === xs.length;
  note(`RESULT — all siblings of branch target have distinct x (n=${siblings.length}): ${distinctX}`);

  const results = {
    productionCommit: await page.eval(`fetch('/api/health').then(r => r.json()).then(j => j.commit)`),
    branchTargetId,
    parentedCorrectly,
    distinctX,
    siblingCount: siblings.length,
  };
  note(`\nRESULTS: ${JSON.stringify(results, null, 2)}`);
  await writeFile(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  await writeFile(join(OUT, "log.txt"), log.join("\n"));
});
