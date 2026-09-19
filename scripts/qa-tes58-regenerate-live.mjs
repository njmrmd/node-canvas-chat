#!/usr/bin/env node
/**
 * TES-58 live re-verification: every node on the shared test account is a
 * dead-end (content-less error/interrupted), so `effectiveComposerTarget`
 * always binds to one of them and the composer is correctly disabled
 * ("Available when the reply finishes") — the branch-gate fix is doing its
 * job. That means Send can't be exercised on this account anymore. The one
 * remaining way to exercise the real create/stream pipeline is Regenerate,
 * which calls `createAndStream` directly off `parentId` and does not go
 * through `canBranchNow` at all.
 *
 *   node scripts/qa-tes58-regenerate-live.mjs --base <url>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, sleep, withPage } from "./lib/cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = args.out ?? "./shots/tes-58-regenerate";
// TES-67: the TES-4/TES-59 account's password was lost from every agent's
// secret store, so QA now uses this fresh account instead (see TES-67).
const EMAIL = "platform-eng-tes67-verify+1789859719@example.com";
const PASSWORD = process.env.QA_TEST_ACCOUNT_PASSWORD;
if (!PASSWORD) {
  console.error("Set QA_TEST_ACCOUNT_PASSWORD in the environment.");
  process.exit(1);
}

const fillJs = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

await mkdir(OUT, { recursive: true });
const log = [];
const note = (l) => { console.log(l); log.push(l); };

await withPage(async (page) => {
  const shot = async (name) => {
    await writeFile(join(OUT, `${name}.png`), await page.screenshot());
    note(`  shot: ${name}.png`);
  };
  await page.emulate({ width: 1440, height: 900, scale: 1, mobile: false, scheme: "light" });

  await page.navigate(`${BASE}/sign-in`);
  await page.eval(fillJs("#email", EMAIL));
  await page.eval(fillJs("#password", PASSWORD));
  await page.eval(`document.querySelector('button[type="submit"]').click()`);
  await sleep(2000);
  note(`post-sign-in: ${await page.eval("location.href")}`);

  await page.navigate(`${BASE}/canvas`);
  await sleep(1000);
  await shot("00-canvas-loaded");

  const clicked = await page.eval(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Regenerate');
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  note(`regenerate button clicked: ${clicked}`);
  if (!clicked) {
    note("No Regenerate button found — cannot proceed with this check.");
    return;
  }
  await shot("01-regenerate-clicked");

  let elapsedMs = 0;
  let outcome = "still-pending-at-65s";
  while (elapsedMs < 65000) {
    await sleep(3000);
    elapsedMs += 3000;
    const nodeStatus = await page.eval(`(() => {
      const groups = Array.from(document.querySelectorAll('[role="group"][aria-label^="Node,"]'));
      const last = groups[groups.length - 1];
      return last ? last.getAttribute('aria-label') : null;
    })()`);
    if (nodeStatus && /, (complete|interrupted|error)$/.test(nodeStatus)) {
      outcome = nodeStatus;
      break;
    }
  }
  note(`outcome after ${elapsedMs}ms: ${outcome}`);
  await shot("02-after-wait");
  const bodyText = await page.eval(`document.body.innerText.slice(-600)`);
  note(`body tail after wait: ${JSON.stringify(bodyText)}`);
});

await writeFile(join(OUT, "log.txt"), log.join("\n"));
note(`\nDone. See ${OUT}`);
