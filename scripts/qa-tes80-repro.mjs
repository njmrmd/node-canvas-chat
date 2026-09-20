#!/usr/bin/env node
/**
 * TES-80 defect 1: reproduce the exact handler shape from canvas-app.tsx /
 * node-card.tsx to find where "Branch on node 2, click composer, send"
 * still rebinds the target to the most recent leaf (node 4) despite the
 * TES-74 fix (data-canvas-role="chrome" guard on the surface's pointerdown).
 *
 * This mirrors the *current* source faithfully (including startNodeDrag's
 * mouse-button branch and IconButton's stopPropagation-on-pointerdown-and-
 * click-but-not-pointerup shape) rather than a simplified stand-in, since
 * the simplified TES-74 probe already passes and does not reproduce TES-80.
 *
 *   node scripts/qa-tes80-repro.mjs
 */
import { withPage } from "./lib/cdp.mjs";

const page = `<!doctype html>
<html><body style="margin:0">
<main>
<div id="surface" style="position:fixed;inset:0;touch-action:none">
  <div id="card2" data-node-role="card" style="position:absolute;top:40px;left:40px;width:200px;height:80px;background:#eee">
    node 2
    <button id="branch2" data-icon-button>Branch</button>
  </div>
  <div id="card4" data-node-role="card" style="position:absolute;top:200px;left:40px;width:200px;height:80px;background:#eee">
    node 4
  </div>
  <div data-canvas-role="chrome" style="position:absolute;bottom:20px;left:20px;width:300px">
    <textarea id="composer" rows="2" style="width:100%"></textarea>
    <button id="send">Send</button>
  </div>
</div>
<script>
  window.log = { selected: "node-4", events: [] };
  function record(name) { window.log.events.push(name); }

  // ---- mirrors use-canvas-controller.ts ----
  function select(nodeId) { window.log.selected = nodeId; record("select(" + nodeId + ")"); }
  function branch(nodeId) { select(nodeId); }

  // ---- mirrors canvas-app.tsx refs ----
  var panRef = null;
  var dragRef = null;
  var surface = document.getElementById("surface");
  var CHROME = '[data-canvas-role="chrome"]';
  function isOverCanvasChrome(t) { return t instanceof Element && t.closest(CHROME) !== null; }

  // ---- mirrors startNodeDrag (mouse branch only, TES-80 repro uses mouse) ----
  function startNodeDrag(event, nodeId) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    select(nodeId);
    dragRef = { nodeId: nodeId, pointerId: event.pointerId };
  }
  document.getElementById("card2").addEventListener("pointerdown", function (event) {
    // IconButton.stopPropagation on pointerdown means this never fires for
    // a click that lands on #branch2 itself — mirrors real bubbling.
    startNodeDrag(event, "node-2");
  });
  document.getElementById("card4").addEventListener("pointerdown", function (event) {
    startNodeDrag(event, "node-4");
  });

  // ---- mirrors IconButton ----
  var branchBtn = document.getElementById("branch2");
  branchBtn.addEventListener("pointerdown", function (event) { event.stopPropagation(); });
  branchBtn.addEventListener("click", function (event) {
    event.stopPropagation();
    branch("node-2");
    requestAnimationFrame(function () { document.getElementById("composer").focus(); });
  });

  // ---- mirrors handleSurfacePointerDown / handleSurfacePointerUp ----
  surface.addEventListener("pointerdown", function (event) {
    record("surface pointerdown target=" + event.target.id);
    if (isOverCanvasChrome(event.target)) return;
    var overCard = event.target.closest('[data-node-role="card"]') !== null;
    var wantsPan = event.button === 1 || (event.button === 0 && !overCard);
    if (!wantsPan) return;
    event.preventDefault();
    event.target.setPointerCapture(event.pointerId);
    panRef = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  });
  surface.addEventListener("pointerup", function (event) {
    record("surface pointerup target=" + event.target.id);
    var pan = panRef;
    if (!pan || pan.pointerId !== event.pointerId) return;
    var moved = Math.abs(event.clientX - pan.x) > 4 || Math.abs(event.clientY - pan.y) > 4;
    if (!moved) select(null); // fallback to most-recent-leaf downstream
  });

  // ---- mirrors the window-level onMove/onUp effect ----
  window.addEventListener("pointerup", function (event) {
    if (panRef && panRef.pointerId === event.pointerId) panRef = null;
    if (dragRef && dragRef.pointerId === event.pointerId) dragRef = null;
  });

  document.getElementById("send").addEventListener("click", function () {
    window.log.sendTarget = window.log.selected === null ? "node-4 (fallback)" : window.log.selected;
  });
</script>
</main>
</body></html>`;

const pointer = async (p, type, x, y, pointerId = 1) => {
  await p.send("Input.dispatchMouseEvent", {
    type: type === "down" ? "mousePressed" : "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
    buttons: type === "down" ? 1 : 0,
    pointerType: "mouse",
  });
};

const boxOf = async (p, selector) =>
  p.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);

await withPage(async (p) => {
  await p.emulate({ width: 900, height: 600 });
  await p.navigate(`data:text/html,${encodeURIComponent(page)}`);

  const branchBox = await boxOf(p, "#branch2");
  await pointer(p, "down", branchBox.x, branchBox.y);
  await pointer(p, "up", branchBox.x, branchBox.y);

  const afterBranch = await p.eval("({ ...window.log })");

  const composerBox = await boxOf(p, "#composer");
  await pointer(p, "down", composerBox.x, composerBox.y);
  await pointer(p, "up", composerBox.x, composerBox.y);

  const afterComposerClick = await p.eval("({ ...window.log, focused: document.activeElement.id })");

  const sendBox = await boxOf(p, "#send");
  await pointer(p, "down", sendBox.x, sendBox.y);
  await pointer(p, "up", sendBox.x, sendBox.y);

  const afterSend = await p.eval("({ ...window.log })");

  console.log(JSON.stringify({ afterBranch, afterComposerClick, afterSend }, null, 2));
  console.log(
    afterSend.sendTarget === "node-2"
      ? "PASS: send target stayed node-2"
      : `FAIL: send target was ${afterSend.sendTarget}`,
  );
});
