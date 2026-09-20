#!/usr/bin/env node
/**
 * TES-74: "fork from node 2 continues the series instead of branching."
 *
 * The suspect is not the graph layer — it is the canvas surface's pointer
 * handling. The composer is rendered *inside* the surface element, so a click
 * on it bubbles to `handleSurfacePointerDown` / `handleSurfacePointerUp`,
 * which read it as a click on empty canvas and call `select(null)`. That drops
 * the branch target the Reply button just set, and §2.2's fallback rebinds the
 * composer to the most recent leaf — the end of the series.
 *
 * Reproducing that in the real app needs a signed-in account with a four-node
 * canvas and a live model key. This probe instead isolates the two browser
 * behaviours the diagnosis rests on, using the *same handler shape* as
 * `canvas-app.tsx`, before and after the `data-canvas-role="chrome"` guard:
 *
 *   1. an ancestor calling `preventDefault()` on `pointerdown` suppresses the
 *      click's focus (so clicking into the composer does not even focus it), and
 *   2. the ancestor's `pointerup` still runs, firing the deselect.
 *
 *   node scripts/qa-tes74-composer-deselect.mjs
 */
import { withPage } from "./lib/cdp.mjs";

/** Mirrors canvas-app.tsx: surface with pan/deselect handlers, composer inside it. */
const page = (guarded) => `<!doctype html>
<html><body style="margin:0">
<!-- \`navigate\` waits on a <main>, same as every page in the app. -->
<main>
<div id="surface" style="position:fixed;inset:0;touch-action:none">
  <div id="card" data-node-role="card" style="position:absolute;top:40px;left:40px;width:200px;height:80px;background:#eee">node 2</div>
  <div ${guarded ? 'data-canvas-role="chrome"' : ""} style="position:absolute;bottom:20px;left:20px;width:300px">
    <textarea id="composer" rows="2" style="width:100%"></textarea>
    <button id="send">Send</button>
  </div>
</div>
<script>
  window.log = { selected: "node-2", deselects: 0, sends: [] };
  var pan = null;
  var surface = document.getElementById("surface");
  var CHROME = '[data-canvas-role="chrome"]';
  function overChrome(t) { return ${guarded} && t instanceof Element && t.closest(CHROME) !== null; }

  surface.addEventListener("pointerdown", function (event) {
    if (overChrome(event.target)) return;
    var overCard = event.target.closest('[data-node-role="card"]') !== null;
    var wantsPan = event.button === 1 || (event.button === 0 && !overCard);
    if (!wantsPan) return;
    event.preventDefault();
    event.target.setPointerCapture(event.pointerId);
    pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  });
  surface.addEventListener("pointerup", function (event) {
    if (!pan || pan.pointerId !== event.pointerId) return;
    var moved = Math.abs(event.clientX - pan.x) > 4 || Math.abs(event.clientY - pan.y) > 4;
    pan = null;
    if (!moved) { window.log.deselects += 1; window.log.selected = null; }
  });

  // The composer's own send: reads the binding at click time, exactly as
  // React hands the freshly-rendered \`controller.send\` to the click handler.
  document.getElementById("send").addEventListener("click", function () {
    window.log.sends.push(window.log.selected === null ? "most-recent-leaf (node 4)" : window.log.selected);
  });
</script>
</main>
</body></html>`;

const click = async (p, x, y) => {
  const common = { x, y, button: "left", clickCount: 1, buttons: 1 };
  await p.send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
  await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common, buttons: 0 });
};

const run = async (p, guarded) => {
  await p.navigate(`data:text/html,${encodeURIComponent(page(guarded))}`);
  const box = await p.eval(`(() => {
    const r = document.getElementById("composer").getBoundingClientRect();
    const s = document.getElementById("send").getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, sx: s.x + s.width / 2, sy: s.y + s.height / 2 };
  })()`);

  await click(p, box.cx, box.cy); // user clicks into the composer to type
  const afterClickIn = await p.eval(
    `({ focused: document.activeElement.id, ...window.log })`,
  );

  await click(p, box.sx, box.sy); // user clicks Send
  const afterSend = await p.eval(`({ ...window.log })`);

  return { afterClickIn, afterSend };
};

await withPage(async (p) => {
  await p.emulate({ width: 900, height: 600 });

  const before = await run(p, false);
  const after = await run(p, true);

  const report = {
    "pre-fix": {
      "composer focused by its own click": before.afterClickIn.focused === "composer",
      "deselects fired": before.afterSend.deselects,
      "reply went to": before.afterSend.sends,
    },
    "post-fix": {
      "composer focused by its own click": after.afterClickIn.focused === "composer",
      "deselects fired": after.afterSend.deselects,
      "reply went to": after.afterSend.sends,
    },
  };
  console.log(JSON.stringify(report, null, 2));

  const ok =
    before.afterClickIn.focused !== "composer" &&
    before.afterSend.deselects > 0 &&
    before.afterSend.sends[0] === "most-recent-leaf (node 4)" &&
    after.afterClickIn.focused === "composer" &&
    after.afterSend.deselects === 0 &&
    after.afterSend.sends[0] === "node-2";
  console.log(ok ? "PASS: repro before, fixed after" : "FAIL: see report above");
  if (!ok) process.exitCode = 1;
});
