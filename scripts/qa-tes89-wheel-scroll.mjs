#!/usr/bin/env node
/**
 * TES-89 manual verification: wheel over an overflowing card body scrolls the
 * card and does not pan the canvas; wheel at the card's scroll limit falls
 * through and pans; ctrl+wheel always zooms. Runs against a local dev server
 * (default localhost:4317) with a seeded long node, at both 1440x900 and
 * 390x844 — screenshots land in the given --out dir.
 *
 *   node scripts/qa-tes89-wheel-scroll.mjs --base http://localhost:4317 --out ./shots/tes-89
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, retry, sleep, withPage } from "./lib/cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "http://localhost:4317").replace(/\/$/, "");
const OUT = args.out ?? "./shots/tes-89";
const EMAIL = `tes89-verify+${Date.now()}@example.com`;
const PASSWORD = "Correct-Horse-Battery-Staple-9!";

const LONG_RESPONSE = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1}: this is a long reply built to force the card body past its max height so the scroll fix has something real to exercise.`,
).join("\n\n");

function fillJs(selector, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`;
}

async function click(p, x, y) {
  const common = { x, y, button: "left", clickCount: 1, buttons: 1 };
  await p.send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
  await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common, buttons: 0 });
}

async function wheelAt(p, x, y, deltaX, deltaY, modifiers = 0) {
  await p.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
    modifiers,
  });
}

async function signUp(p) {
  await p.emulate({ width: 1440, height: 900 });
  await p.navigate(`${BASE}/sign-up`);
  await p.eval(fillJs("#email", EMAIL));
  await p.eval(fillJs("#password", PASSWORD));
  const box = await p.eval(`(() => {
    const el = document.querySelector('button[type="submit"]');
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await click(p, box.x, box.y);
  await retry(async () => {
    const href = await p.eval("location.href");
    if (href.endsWith("/sign-up")) throw new Error("still on /sign-up");
  }, 40);
}

async function seedLongNodeCanvas(p) {
  const now = Date.now();
  const graph = {
    nodesById: {
      n1: {
        id: "n1",
        parentId: null,
        prompt: "Give me a long answer",
        response: LONG_RESPONSE,
        thinking: "",
        status: "complete",
        error: null,
        position: { x: 0, y: 0 },
        positionMode: "auto",
        collapsed: false,
        usage: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    nodeIds: ["n1"],
  };
  const result = await p.eval(`(async () => {
    const res = await fetch("/api/canvas", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        graph: ${JSON.stringify(graph)},
        viewport: { x: 0, y: 0, zoom: 1 },
        selectedNodeId: null,
        hasBranchedOnce: true,
      }),
    });
    return { status: res.status, ok: res.ok };
  })()`);
  if (!result.ok) throw new Error(`seed failed: ${JSON.stringify(result)}`);
}

async function readState(p) {
  return p.eval(`(() => {
    const body = document.querySelector('[data-canvas-role="card-body"]');
    const surface = document.querySelector('[role="application"]');
    return {
      bodyScrollTop: body ? body.scrollTop : null,
      bodyScrollHeight: body ? body.scrollHeight : null,
      bodyClientHeight: body ? body.clientHeight : null,
      surfaceBg: surface ? surface.style.backgroundPosition : null,
    };
  })()`);
}

async function run() {
  await mkdir(OUT, { recursive: true });
  const report = { base: BASE, viewports: {} };

  await withPage(async (p) => {
    await signUp(p);

    for (const viewport of [
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile", width: 390, height: 844 },
    ]) {
      // Fresh graph + origin viewport each pass — the previous pass's
      // 40-tick scroll-to-limit drive pans the canvas hard by design (that
      // is the fix working), and that pan would otherwise carry over and
      // put the card off-screen for the next viewport size.
      await seedLongNodeCanvas(p);
      await p.emulate({ width: viewport.width, height: viewport.height });
      await p.navigate(`${BASE}/canvas`);
      await retry(async () => {
        const found = await p.eval(
          `document.querySelector('[data-canvas-role="card-body"]') !== null`,
        );
        if (!found) throw new Error("card body not rendered yet");
      }, 40);

      let cardBox = null;
      await retry(async () => {
        const box = await p.eval(`(() => {
          const body = document.querySelector('[data-canvas-role="card-body"]');
          const r = body.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, height: r.height, scrollHeight: body.scrollHeight };
        })()`);
        if (box.x < 0 || box.x > viewport.width || box.y < 0 || box.y > viewport.height) {
          throw new Error(`card body not on-screen yet at ${viewport.name}: ${JSON.stringify(box)}`);
        }
        cardBox = box;
      }, 20);

      const before1 = await readState(p);
      // 1) wheel down over the overflowing card body — should scroll the
      //    card, not pan the canvas (background-position must stay put).
      await wheelAt(p, cardBox.x, cardBox.y, 0, 200);
      await sleep(200);
      const afterScrollDown = await readState(p);
      const midScrollShot = await p.screenshot();
      await writeFile(join(OUT, `${viewport.name}-mid-scroll.png`), midScrollShot);

      // 2) keep wheeling down until the card hits its scroll limit, then one
      //    more wheel should fall through and pan the canvas.
      for (let i = 0; i < 40; i++) {
        await wheelAt(p, cardBox.x, cardBox.y, 0, 400);
        await sleep(50);
      }
      const atLimit = await readState(p);
      const bgBeforePanAttempt = atLimit.surfaceBg;
      await wheelAt(p, cardBox.x, cardBox.y, 0, 400);
      await sleep(200);
      const afterLimitWheel = await readState(p);

      // 3) ctrl+wheel over the card should zoom the canvas (background-size
      //    changes with zoom), not scroll the card further.
      const scrollTopBeforeZoom = afterLimitWheel.bodyScrollTop;
      await wheelAt(p, cardBox.x, cardBox.y, 0, -100, 2 /* ctrl */);
      await sleep(200);
      const afterCtrlWheel = await readState(p);

      const shot = await p.screenshot();
      await writeFile(join(OUT, `${viewport.name}.png`), shot);

      report.viewports[viewport.name] = {
        cardOverflowed: cardBox.scrollHeight > cardBox.height + 1,
        scrolledOnWheelOverBody: afterScrollDown.bodyScrollTop > before1.bodyScrollTop,
        // Single wheel tick over a non-limit body: card moves, canvas does not.
        canvasUnchangedOnFirstScroll: afterScrollDown.surfaceBg === before1.surfaceBg,
        canvasPannedAtScrollLimit: afterLimitWheel.surfaceBg !== bgBeforePanAttempt,
        ctrlWheelDidNotScrollBodyFurther: afterCtrlWheel.bodyScrollTop === scrollTopBeforeZoom,
      };
    }
  });

  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
