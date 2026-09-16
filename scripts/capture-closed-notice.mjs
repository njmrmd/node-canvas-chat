#!/usr/bin/env node
/**
 * Checks the closed-sign-up disclosure on the front door (TES-33, refs TES-32).
 *
 * The thing under test is not "is there an alert" — it is *when* a stranger
 * meets it. The cost the notice exists to prevent is somebody walking off to
 * console.anthropic.com to mint a live credential for a deployment that cannot
 * store one. So the assertions are positional: the notice has to land before
 * the "Create an account" button and before the sentence about the API key,
 * and it has to be reachable without hunting for it.
 *
 * It also diffs the rendered `Alert` on `/` against the one on `/sign-up`.
 * Those two say the same sentence about the same fact; if they render at
 * different weights, the page is speaking with two voices about one thing.
 *
 * Runs against a URL, not a local render, and prints the commit `/api/health`
 * reports next to the evidence — a deployed page can be older than the repo.
 *
 *   node scripts/capture-closed-notice.mjs --base https://... --out ./shots/closed-notice
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseArgs, withPage } from "./lib/cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = args.out ?? "./shots/closed-notice";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

/**
 * Read back whatever the alert is actually made of, rather than trusting the
 * class list. Two elements can carry different classes and paint the same, and
 * the same classes and paint differently once a page's cascade gets involved.
 */
const PROBE = `(() => {
  const alert = document.querySelector('main [role="alert"], main [role="status"]');
  if (!alert) return { present: false };

  const style = getComputedStyle(alert);
  const title = alert.querySelector("p");
  const titleStyle = title ? getComputedStyle(title) : null;
  const icon = alert.querySelector("svg");
  const iconStyle = icon ? getComputedStyle(icon.parentElement) : null;

  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top + window.scrollY),
      bottom: Math.round(r.bottom + window.scrollY),
      left: Math.round(r.left),
      width: Math.round(r.width),
    };
  };

  return {
    present: true,
    role: alert.getAttribute("role"),
    title: title ? title.textContent.trim() : null,
    text: alert.innerText.replace(/\\s+/g, " ").trim(),
    box: rect(alert),
    paint: {
      background: style.backgroundColor,
      border: style.borderTopColor,
      railColor: style.borderLeftColor,
      railWidth: style.borderLeftWidth,
      radius: style.borderTopLeftRadius,
      padding: style.paddingTop + " " + style.paddingLeft,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      color: style.color,
      titleWeight: titleStyle ? titleStyle.fontWeight : null,
      titleColor: titleStyle ? titleStyle.color : null,
      titleSize: titleStyle ? titleStyle.fontSize : null,
      iconColor: iconStyle ? iconStyle.color : null,
    },
    viewportHeight: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
    signUpButton: rect(document.querySelector('main a[href="/sign-up"]')),
    signInButton: rect(document.querySelector('main a[href="/sign-in"]')),
    keySentence: (() => {
      const link = document.querySelector('main a[href*="console.anthropic.com"]');
      const p = link ? link.closest("p") : null;
      return p
        ? { text: p.innerText.replace(/\\s+/g, " ").trim(), box: rect(p) }
        : null;
    })(),
    firstStep: (() => {
      const li = document.querySelector("main ol li");
      return li ? li.innerText.replace(/\\s+/g, " ").trim() : null;
    })(),
    lede: (() => {
      const h1 = document.querySelector("main h1");
      return h1 ? h1.innerText.replace(/\\s+/g, " ").trim() : null;
    })(),
    bodyText: document.body.innerText.replace(/\\s+/g, " ").trim(),
  };
})()`;

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());

await mkdir(OUT, { recursive: true });

const failures = [];
const notes = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

await withPage(async (page) => {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ["light", "dark"]) {
      await page.emulate({ ...viewport, scheme });
      await page.navigate(`${BASE}/`);

      const label = `${scheme}--${viewport.name}`;

      // Two frames per state on purpose. The full-page render is the evidence
      // of the copy; the viewport-clipped one is the evidence of what a
      // stranger has actually seen before they decide to click anything.
      await writeFile(
        join(OUT, `front-door--${label}.png`),
        await page.screenshot({ beyondViewport: true }),
      );
      await writeFile(
        join(OUT, `fold--${label}.png`),
        await page.screenshot(),
      );

      const home = await page.eval(PROBE);

      if (scheme === "light") {
        check(home.present, `${label}: a notice renders on /`);
        if (!home.present) continue;

        check(
          home.title === "Accounts are not open yet",
          `${label}: title is "Accounts are not open yet" (got "${home.title}")`,
        );
        check(
          home.box.bottom <= home.signUpButton.top,
          `${label}: notice ends (${home.box.bottom}px) above the "Create an account" button (${home.signUpButton.top}px)`,
        );
        check(
          home.box.bottom <= home.keySentence.box.top,
          `${label}: notice ends above the API-key sentence (${home.keySentence.box.top}px)`,
        );
        check(
          !/takes about a minute to create,/.test(home.keySentence.text),
          `${label}: key sentence no longer nudges ("${home.keySentence.text}")`,
        );
        check(
          /Create an account/.test(home.firstStep),
          `${label}: step 1 still says "Create an account"`,
        );

        // Not a pass/fail — the fold is a soft target — but it is the number
        // the whole change is about, so it goes in the log either way.
        const scrollToSee = Math.max(
          0,
          home.box.bottom - home.viewportHeight,
        );
        notes.push(
          `${viewport.name}: notice occupies ${home.box.top}–${home.box.bottom}px of a ${home.documentHeight}px page; ` +
            (scrollToSee === 0
              ? "fully above the fold"
              : `needs ${scrollToSee}px of scroll to finish reading`) +
            `; button at ${home.signUpButton.top}px`,
        );
        check(
          home.box.top < home.viewportHeight,
          `${label}: notice starts within the first screen (${home.box.top}px < ${home.viewportHeight}px)`,
        );
      }

      // One voice for one fact: the same alert on the page that asks for the
      // password has to look like the one on the page that pitches it.
      await page.navigate(`${BASE}/sign-up`);
      const signUp = await page.eval(PROBE);

      check(signUp.present, `${label}: /sign-up still shows its notice`);
      if (!signUp.present) continue;

      check(
        signUp.title === home.title,
        `${label}: same title on / and /sign-up`,
      );
      for (const [key, value] of Object.entries(home.paint)) {
        check(
          signUp.paint[key] === value,
          `${label}: alert ${key} matches /sign-up (${value} vs ${signUp.paint[key]})`,
        );
      }

      if (scheme === "light" && viewport.name === "desktop") {
        notes.push(`/ notice copy: ${home.text}`);
        notes.push(`/sign-up notice copy: ${signUp.text}`);
        notes.push(`/ key sentence: ${home.keySentence.text}`);
      }

      await writeFile(
        join(OUT, `sign-up--${label}.png`),
        await page.screenshot({ beyondViewport: true }),
      );
    }
  }
});

console.log(
  `\n${BASE} reports commit ${health.commit} on ${health.branch} (${health.environment})`,
);
for (const note of notes) console.log(`note  ${note}`);
console.log(`\nrenders written to ${OUT}`);

if (failures.length) {
  console.error(`\n${failures.length} failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
