#!/usr/bin/env node
/**
 * Captures the front door from a running deployment and checks the one thing
 * TES-9 was filed about: a stranger who lands on `/` can see a way in.
 *
 * This points at a URL rather than at `/dev/screens` on purpose. The bug QA
 * found was a *deployed* page being older than the repo, and a local render
 * cannot tell you anything about that. So the assertions run against whatever
 * the URL actually serves, and the commit is read back from `/api/health` and
 * printed next to the evidence.
 *
 *   node scripts/capture-front-door.mjs --base https://... --out ./shots/front-door
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseArgs, withPage } from "./lib/cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = args.out ?? "./shots/front-door";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

/** The minimum comfortable tap target, from the design spec. */
const MIN_TAP = 44;

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());

await mkdir(OUT, { recursive: true });

const failures = [];

await withPage(async (page) => {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ["light", "dark"]) {
      await page.emulate({ ...viewport, scheme });
      await page.navigate(`${BASE}/`);

      const name = `front-door--${scheme}--${viewport.name}.png`;
      await writeFile(
        join(OUT, name),
        await page.screenshot({ beyondViewport: true }),
      );

      // Only measure once per viewport — the two schemes lay out identically,
      // and a second identical measurement is noise in the log.
      if (scheme !== "light") continue;

      const measured = await page.eval(`(() => {
        const primary = document.querySelector('a[href="/sign-up"]');
        const secondary = document.querySelector('a[href="/sign-in"]');
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), label: el.textContent.trim() };
        };
        return {
          primary: box(primary),
          secondary: box(secondary),
          // The sentence the scaffold shipped. If it is still on the page the
          // deployment is older than the fix, whatever the commit claims.
          scaffoldCopy: document.body.innerText.includes("Nothing is built yet"),
          buildTable: /\\bCommit\\b/.test(document.body.innerText),
        };
      })()`);

      const check = (ok, message) => {
        console.log(`${ok ? "ok  " : "FAIL"} ${viewport.name}  ${message}`);
        if (!ok) failures.push(`${viewport.name}: ${message}`);
      };

      check(!!measured.primary, `"Create an account" links to /sign-up`);
      check(!!measured.secondary, `"Sign in" links to /sign-in`);
      check(!measured.scaffoldCopy, `no "Nothing is built yet" copy`);
      check(!measured.buildTable, `no build metadata table`);

      for (const [role, box] of Object.entries(measured)) {
        if (!box || typeof box !== "object") continue;
        check(
          box.h >= MIN_TAP,
          `${role} tap target ${box.w}x${box.h} >= ${MIN_TAP} ("${box.label}")`,
        );
      }
    }
  }
});

console.log(
  `\n${BASE} reports commit ${health.commit} on ${health.branch} (${health.environment})`,
);
console.log(`${VIEWPORTS.length * 2} renders written to ${OUT}`);

if (failures.length) {
  console.error(`\n${failures.length} failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
