#!/usr/bin/env node
/**
 * TES-80 final variable: the original TES-79 repro branched from the node
 * that itself had the ~420px tall card (prompt 2's long reply), not just
 * from some earlier node in a chain of short ones. Two prior rechecks this
 * heartbeat (qa-tes80-recheck-live.mjs, real-click-based) branched from
 * ordinary short-card nodes and found nothing broken — that controls for
 * the composer-click trigger but not for card height. This isolates height:
 * create one long-reply node, then branch specifically off it with a real
 * click, and check parentId + Tidy x-positions.
 *
 *   QA_TEST_ACCOUNT_PASSWORD=... node scripts/qa-tes80-tallcard-check.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sleep, withPage } from "./lib/cdp.mjs";

const BASE = "https://node-canvas-chat.vercel.app";
const OUT = "./shots/tes-80-tallcard";
const EMAIL = "platform-eng-tes67-verify+1789859719@example.com";
const PASSWORD = process.env.QA_TEST_ACCOUNT_PASSWORD;
if (!PASSWORD) {
  console.error("Set QA_TEST_ACCOUNT_PASSWORD in the environment.");
  process.exit(1);
}

const fillJs = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

const realClick = async (page, x, y) => {
  const common = { x, y, button: "left", clickCount: 1, buttons: 1 };
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common, buttons: 0 });
};

await mkdir(OUT, { recursive: true });
const log = [];
const note = (l) => {
  console.log(l);
  log.push(l);
};

await withPage(async (page) => {
  const shot = async (name) => writeFile(join(OUT, `${name}.png`), await page.screenshot());

  await page.emulate({ width: 1440, height: 900, scale: 1, mobile: false, scheme: "light" });
  await page.navigate(`${BASE}/sign-in`);
  await page.eval(fillJs("#email", EMAIL));
  await page.eval(fillJs("#password", PASSWORD));
  await page.eval(`document.querySelector('button[type="submit"]').click()`);
  await sleep(2500);

  await page.navigate(`${BASE}/canvas`);
  await sleep(1500);
  await page.eval(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Zoom to fit'); b?.click(); })()`);
  await sleep(800);

  // 1. Send a long-reply prompt off whatever the composer currently targets.
  const longPrompt = "Give me a genuinely detailed, multi-paragraph explanation (at least 8 paragraphs, several headers) of how commercial jet engines work, covering compressor stages, combustion, turbine stages, and bypass ratio.";
  await page.eval(fillJs("textarea", longPrompt));
  await sleep(300);
  const sent1 = await page.eval(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Send'); if (b && !b.disabled) { b.click(); return true; } return false; })()`);
  note(`long-reply send clicked: ${sent1}`);

  let elapsed = 0;
  let status1 = "pending";
  while (elapsed < 90000) {
    await sleep(3000);
    elapsed += 3000;
    const groups = await page.eval(`Array.from(document.querySelectorAll('[role="group"][aria-label^="Node,"]')).map(g => g.getAttribute('aria-label'))`);
    const last = groups[groups.length - 1];
    if (last && /complete|error|interrupted/.test(last)) { status1 = last; break; }
  }
  note(`long-reply node final status: ${status1}`);

  const tallNode = await page.eval(`(() => {
    const groups = Array.from(document.querySelectorAll('[role="group"][aria-label^="Node,"]'));
    const el = groups[groups.length - 1];
    const rect = el.getBoundingClientRect();
    return { id: el.getAttribute('data-node-id'), height: rect.height };
  })()`);
  note(`tall node: ${JSON.stringify(tallNode)}`);
  await shot("01-tall-node-created");

  // 2. Fit view, then Branch specifically off this tall node with a real click.
  await page.eval(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Zoom to fit'); b?.click(); })()`);
  await sleep(800);

  const branchBtnBox = await page.eval(`(() => {
    const el = document.querySelector('[data-node-id="${tallNode.id}"]');
    const btn = el?.querySelector('button[aria-label="Branch"]');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  note(`branch button box on tall node: ${JSON.stringify(branchBtnBox)}`);
  if (!branchBtnBox || branchBtnBox.y < 0 || branchBtnBox.y > 900 || branchBtnBox.x < 0 || branchBtnBox.x > 1440) {
    note("Branch button off-screen even after Zoom to fit — aborting rather than reporting a false result.");
    return;
  }
  await realClick(page, branchBtnBox.x, branchBtnBox.y);
  await sleep(500);

  const composerTargetAfterBranch = await page.eval(`document.querySelector('textarea')?.previousElementSibling?.textContent`);
  note(`composer target right after clicking Branch on the tall node: ${JSON.stringify(composerTargetAfterBranch)}`);
  await shot("02-after-branch-click-on-tall-node");

  // 3. Real click into the textarea (the exact TES-74/80 trigger) before typing.
  const textareaBox = await page.eval(`(() => { const el = document.querySelector('textarea'); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
  await realClick(page, textareaBox.x, textareaBox.y);
  await sleep(300);
  const composerTargetAfterClick = await page.eval(`document.querySelector('textarea')?.previousElementSibling?.textContent`);
  note(`composer target after real click into textarea: ${JSON.stringify(composerTargetAfterClick)}`);

  await page.eval(fillJs("textarea", `Branch from tall card, say OK. (${Date.now()})`));
  await sleep(300);
  const sent2 = await page.eval(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Send'); if (b && !b.disabled) { b.click(); return true; } return false; })()`);
  note(`branch-send clicked: ${sent2}`);

  elapsed = 0;
  let status2 = "pending";
  while (elapsed < 60000) {
    await sleep(3000);
    elapsed += 3000;
    const groups = await page.eval(`Array.from(document.querySelectorAll('[role="group"][aria-label^="Node,"]')).map(g => g.getAttribute('aria-label'))`);
    const last = groups[groups.length - 1];
    if (last && /complete|error|interrupted/.test(last)) { status2 = last; break; }
  }
  note(`branch node final status: ${status2}`);
  await shot("03-after-branch-send");

  const canvasJson = await page.eval(`fetch('/api/canvas').then(r => r.json()).then(j => JSON.stringify(j))`);
  const canvasState = JSON.parse(canvasJson);
  const nodesById = canvasState.graph.nodesById;
  const allNodes = canvasState.graph.nodeIds.map((id) => nodesById[id]);
  const newestNode = allNodes.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).at(-1);
  const parentedCorrectly = newestNode?.parentId === tallNode.id;
  note(`RESULT — branch-from-tall-card new node parentId === tall node id: ${parentedCorrectly}`);

  const siblingsBeforeTidy = allNodes.filter((n) => n.parentId === tallNode.id);
  const xsBefore = siblingsBeforeTidy.map((s) => s.position?.x);
  const distinctBefore = xsBefore.length > 1 && new Set(xsBefore).size === xsBefore.length;
  note(`siblings of tall node before Tidy: ${JSON.stringify(xsBefore)}, distinct: ${distinctBefore}`);

  await page.eval(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Tidy'); b?.click(); })()`);
  await sleep(1500);
  await shot("04-after-tidy");

  const canvasJson2 = await page.eval(`fetch('/api/canvas').then(r => r.json()).then(j => JSON.stringify(j))`);
  const canvasState2 = JSON.parse(canvasJson2);
  const allNodes2 = canvasState2.graph.nodeIds.map((id) => canvasState2.graph.nodesById[id]);
  const siblingsAfterTidy = allNodes2.filter((n) => n.parentId === tallNode.id);
  const xsAfter = siblingsAfterTidy.map((s) => s.position?.x);
  const distinctAfter = xsAfter.length > 1 && new Set(xsAfter).size === xsAfter.length;
  note(`siblings of tall node after Tidy: ${JSON.stringify(xsAfter)}, distinct: ${distinctAfter}`);

  const results = {
    productionCommit: await page.eval(`fetch('/api/health').then(r => r.json()).then(j => j.commit)`),
    tallNodeCardHeight: tallNode.height,
    parentedCorrectly,
    distinctXBeforeTidy: distinctBefore,
    distinctXAfterTidy: distinctAfter,
  };
  note(`\nRESULTS: ${JSON.stringify(results, null, 2)}`);
  await writeFile(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  await writeFile(join(OUT, "log.txt"), log.join("\n"));
});
