#!/usr/bin/env node
/**
 * The acceptance test the `--radius-sm` comment in `globals.css` promises
 * (TES-26): strip every colour out of the sign-up error and rate-limit states
 * and check you can still tell the message from the controls stacked with it.
 *
 * Why this is not the same check `capture-error-surface.mjs` already runs.
 * That one asserts the two numbers — input at 6px, alert at 10px — and the
 * numbers were never the point. A rule can be implemented exactly and still
 * fail to signal anything, because 4px of radius difference on a 10px corner
 * is not a distinction the eye makes on its own. What carries the message is
 * the whole redundant stack: radius, the tonal fill, the 3px rail and the
 * icon. Greyscale is the cheapest way to find out how much of that stack
 * survives when the tone is gone, which is the state a colour-blind visitor,
 * a printed page and a screenshot in a bug report are all already in.
 *
 * Colour is removed with CDP's achromatopsia emulation rather than a CSS
 * filter. A filter on the root element creates a containing block and can move
 * fixed and absolute children, so the PNG would be a picture of a layout that
 * does not ship. The emulation is applied at paint and moves nothing.
 *
 *   pnpm dev -p 4317
 *   node scripts/capture-greyscale-shapes.mjs   # -> scripts/shots/greyscale/
 *
 * It drives `/dev/screens` rather than `/sign-up` for the same reason
 * `capture-error-surface.mjs` does: without a `DATABASE_URL` the real page
 * renders `ServiceUnavailable` and there is no form to fail.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, retry, sleep, withPage } from "./lib/cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
/*
 * `localhost`, not `127.0.0.1`. Next 16 blocks cross-origin requests to dev
 * resources, and it counts the literal IP as a different origin from the host
 * it is serving — so `/_next/*` 403s, no client chunk ever runs, and the page
 * sits there unhydrated looking exactly like a page that hydrated fine. The
 * only symptom is that clicking submit navigates instead of fetching.
 */
const BASE = args.base ?? process.env.BASE_URL ?? "http://localhost:4317";
const OUT = args.out ?? join(HERE, "shots", "greyscale");

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

/**
 * The two states the ticket names, and only those.
 *
 * `error` is the one that has to be unmistakable — a stranger can fix it and
 * needs to know that. `wait` is the one most at risk in greyscale, because its
 * whole job is to read as "not your fault" and that is the distinction colour
 * was carrying.
 */
const STATES = [
  {
    name: "signup-error",
    note: "error tone: banner above two inputs and the submit",
    screen: "/dev/screens?screen=sign-up",
    status: 400,
    body: {
      error: {
        code: "invalid_request",
        message: "Request body is not valid JSON.",
      },
    },
  },
  {
    name: "signup-rate-limited",
    note: "wait tone: banner, live countdown, submit disabled",
    screen: "/dev/screens?screen=sign-up",
    status: 429,
    headers: { "Retry-After": "47" },
    body: {
      error: {
        code: "rate_limited",
        message: "Too many attempts from this address.",
      },
    },
  },
];

/**
 * Every corner-drawing element on the page, bucketed by radius.
 *
 * Next's route announcer parks an empty `[role="alert"]` in the document; it
 * draws nothing, but filter it out by hand anyway so a reader of this output
 * is never asked to wonder what the untitled alert is.
 */
const AUDIT = `(() => {
  const rows = [];
  for (const el of document.querySelectorAll("*")) {
    if (el.closest("nextjs-portal")) continue;
    const radius = getComputedStyle(el).borderTopLeftRadius;
    if (radius === "0px" || radius === "") continue;
    const text = (el.textContent || "").trim().replace(/\\s+/g, " ");
    if (el.getAttribute("role") === "alert" && text === "") continue;
    rows.push({
      radius,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      text: text.slice(0, 52),
    });
  }
  return rows;
})()`;

/**
 * Replaces `window.fetch` for the one call the submit makes.
 *
 * Patched after hydration rather than injected on new document, because the
 * only request under test happens on click — and a stub installed before the
 * app loads would also answer Turbopack's HMR traffic.
 */
const stubFetch = (state) => `(() => {
  const body = ${JSON.stringify(JSON.stringify(state.body))};
  const headers = { "Content-Type": "application/json", ...${JSON.stringify(state.headers ?? {})} };
  window.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.includes("/api/")) throw new Error("unexpected fetch " + url);
    return new Response(body, { status: ${state.status}, headers });
  };
  return true;
})()`;

/** React tracks the value on the node, so assigning `.value` is swallowed. */
async function fill(page, selector, value) {
  await page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("no " + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value"
    ).set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await sleep(60);
}

/** A non-empty banner. Next parks an empty one for route announcements. */
const BANNER = `(() => {
  const el = [...document.querySelectorAll('[role="alert"]')]
    .find((n) => (n.textContent || "").trim() !== "");
  return el ? el.textContent.trim().slice(0, 40) : null;
})()`;

/**
 * A click that lands before React has hydrated hits a plain `<form>`, and the
 * browser does what a browser does: submits it and navigates. The page that
 * comes back is the empty form again, so the retry below would fill a document
 * that is already on its way out and report a missing `#email`. Suppressing
 * the default in the capture phase costs nothing when React *is* attached —
 * its own handler calls `preventDefault` anyway — and turns a pre-hydration
 * click into a no-op instead of a navigation.
 */
const SUPPRESS_NATIVE_SUBMIT = `(() => {
  if (window.__submitPinned) return false;
  window.__submitPinned = true;
  window.addEventListener("submit", (e) => e.preventDefault(), true);
  return true;
})()`;

/**
 * Submits, and keeps submitting until the banner is actually on screen.
 *
 * There is no reliable hydration flag to wait on: React 19 stopped exposing
 * its fiber keys as enumerable properties, so the `__reactFiber$` probe the
 * older harnesses use now reports "never hydrated" on a page that is working
 * fine. Waiting on the postcondition is both simpler and harder to fool — the
 * run only proceeds once the thing being photographed is demonstrably there.
 */
async function submitUntilBanner(page, state, label) {
  return retry(async () => {
    const already = await page.eval(BANNER);
    if (already) return already;

    const formReady = await page.eval(
      `!!document.querySelector("#email") && !!document.querySelector('button[type="submit"]')`,
    );
    if (!formReady) throw new Error(`form not on screen yet on ${label}`);

    await page.eval(SUPPRESS_NATIVE_SUBMIT);
    await page.eval(stubFetch(state));
    await fill(page, "#email", "stranger@example.com");
    await fill(page, "#password", "a-long-enough-password");
    await page.eval(`document.querySelector('button[type="submit"]')?.click()`);
    await sleep(400);

    const shown = await page.eval(BANNER);
    if (!shown) throw new Error(`no banner yet on ${label}`);
    return shown;
  }, 30);
}

async function greyscale(page, on) {
  await page.send("Emulation.setEmulatedVisionDeficiency", {
    type: on ? "achromatopsia" : "none",
  });
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const failures = [];
  const report = [];

  await withPage(async (page) => {
    for (const state of STATES) {
      for (const viewport of VIEWPORTS) {
        const label = `${state.name}/${viewport.name}`;

        await greyscale(page, false);
        await page.emulate({ ...viewport, scale: 2, scheme: "dark" });
        await page.navigate(`${BASE}${state.screen}`);
        await submitUntilBanner(page, state, label);
        // The banner animates in over 180ms; let it settle before the shot.
        await sleep(300);

        // Measure in colour: the numbers should not be something the
        // emulation could be blamed for.
        const rows = await page.eval(AUDIT);
        const buckets = new Map();
        for (const row of rows) {
          if (!buckets.has(row.radius)) buckets.set(row.radius, []);
          buckets.get(row.radius).push(row);
          if (row.radius !== "6px" && row.radius !== "10px") {
            failures.push(
              `${label}: ${row.radius} on <${row.tag}> "${row.text}"`,
            );
          }
        }

        const banner = rows.find((r) => r.role === "alert");
        if (!banner) failures.push(`${label}: no alert in the audit`);
        else if (banner.radius !== "10px") {
          failures.push(`${label}: alert is ${banner.radius}, expected 10px`);
        }

        report.push(`\n## ${label} — ${state.note}`);
        for (const [radius, group] of [...buckets].sort()) {
          report.push(`  ${radius}`);
          for (const row of group) {
            const role = row.role ? ` role=${row.role}` : "";
            report.push(`    <${row.tag}${role}> ${row.text || "(no text)"}`);
          }
        }

        const stem = `${state.name}--${viewport.name}`;
        await writeFile(
          join(OUT, `${stem}--colour.png`),
          await page.screenshot(),
        );
        await greyscale(page, true);
        await writeFile(
          join(OUT, `${stem}--grey.png`),
          await page.screenshot(),
        );
      }
    }
  });

  const text = report.join("\n");
  await writeFile(join(OUT, "radius-audit.txt"), `${text}\n`);
  console.log(text);

  console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"}: radius binary`);
  for (const failure of failures) console.log(`  ${failure}`);
  console.log(`\nShots in ${OUT}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
