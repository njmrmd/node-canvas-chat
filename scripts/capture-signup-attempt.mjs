#!/usr/bin/env node
/**
 * Drives the real sign-up form on a *deployed* URL and captures what a
 * first-time visitor actually sees after pressing the button.
 *
 * This exists because the interesting failure is not the API's status code.
 * `POST /api/auth/signup` answering 503 `not_configured` is a perfectly legible
 * JSON body — but nobody signing up reads JSON. The question QA owns is whether
 * that 503 reaches the page as a sentence a stranger can act on, or whether the
 * form just goes quiet. So this types into the shipped inputs, submits, and
 * screenshots the result at both review viewports.
 *
 *   node scripts/capture-signup-attempt.mjs --base https://... --out ./shots/signup
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseArgs, retry, sleep, withPage } from "./lib/cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = args.out ?? "./shots/signup";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

/**
 * A throwaway address on the reserved example.com domain, uniquified per run so
 * a retry never collides with an account an earlier run created.
 */
const EMAIL = `qa-probe-${Date.now()}@example.com`;
const PASSWORD = "correct-horse-battery-staple";

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());

await mkdir(OUT, { recursive: true });

const failures = [];
const check = (viewport, ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${viewport}  ${message}`);
  if (!ok) failures.push(`${viewport}: ${message}`);
};

await withPage(async (page) => {
  for (const viewport of VIEWPORTS) {
    await page.emulate({ ...viewport, scheme: "light" });
    await page.navigate(`${BASE}/sign-up`);

    // Set the values through the native setter so React's onChange sees them;
    // assigning .value directly updates the DOM and leaves state stale.
    await page.eval(`(() => {
      const set = (id, value) => {
        const el = document.querySelector('#' + id);
        const proto = Object.getPrototypeOf(el);
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('email', ${JSON.stringify(EMAIL)});
      set('password', ${JSON.stringify(PASSWORD)});
    })()`);

    await writeFile(
      join(OUT, `signup-filled--${viewport.name}.png`),
      await page.screenshot({ beyondViewport: true }),
    );

    await page.eval(
      `document.querySelector('button[type="submit"]').click()`,
    );

    // Wait for the form to settle: either it navigated away (success) or it
    // re-enabled the button after the request came back.
    await retry(async () => {
      const busy = await page.eval(
        `!!document.querySelector('button[type="submit"]')?.disabled`,
      );
      if (busy) throw new Error("still submitting");
    }, 60);
    await sleep(400);

    const after = await page.eval(`(() => {
      const alerts = [...document.querySelectorAll('[role="alert"]')]
        .map((el) => el.innerText.trim())
        .filter(Boolean);
      return {
        url: location.pathname,
        alerts,
        bodyText: document.body.innerText,
      };
    })()`);

    await writeFile(
      join(OUT, `signup-result--${viewport.name}.png`),
      await page.screenshot({ beyondViewport: true }),
    );

    const shown = after.alerts.join(" ");
    console.log(`\n--- ${viewport.name} @ ${after.url} ---`);
    console.log(`alerts: ${JSON.stringify(after.alerts)}`);

    // The one assertion that matters: the visitor was told *something*.
    check(
      viewport.name,
      after.alerts.length > 0 || after.url !== "/sign-up",
      "pressing the button produces a visible response",
    );
    // And that something must not be raw machine vocabulary.
    check(
      viewport.name,
      !/not_configured|invalid_request|\bat .*\(.*:\d+:\d+\)/.test(shown),
      "the message is a sentence, not an error code or a stack frame",
    );
  }
});

console.log(
  `\n${BASE} reports commit ${health.commit} on ${health.branch} (${health.environment})`,
);
console.log(`renders written to ${OUT}`);

if (failures.length) {
  console.error(`\n${failures.length} failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
