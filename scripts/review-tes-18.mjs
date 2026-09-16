/**
 * Design review capture for TES-18 — the two states the implementation capture
 * does not produce, rendered at both viewports in both schemes.
 *
 *   pnpm dev -p 4317
 *   PLAYWRIGHT_DIR=/path/to/node_modules node scripts/review-tes-18.mjs
 *
 * `scripts/capture-error-surface.mjs` covers the eighteen routing-table rows.
 * These two are the holes it leaves, and both are things only a render shows:
 *
 *   - `field.invalid.focused` — §8 names it, and §4 sends every field-error
 *     user straight into it, but no scenario screenshots the field *while it
 *     holds focus*, so nobody has seen the focus ring and the danger border in
 *     the same pixels.
 *   - `alert.ok` — `<Alert tone="ok">` is gated on `justSaved`, which the
 *     passive `keys-connected` scenario never sets. One of the three tones
 *     ships unrendered.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "shots-review");
const BASE = process.env.BASE_URL ?? "http://localhost:4317";

function loadPlaywright() {
  const candidates = [import.meta.url];
  if (process.env.PLAYWRIGHT_DIR) {
    candidates.push(`file://${join(process.env.PLAYWRIGHT_DIR, "index.js")}`);
  }
  for (const from of candidates) {
    try {
      return createRequire(from)("playwright");
    } catch {
      /* next */
    }
  }
  console.error("Playwright not resolvable; set PLAYWRIGHT_DIR.");
  process.exit(1);
}

const { chromium } = loadPlaywright();

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

const browser = await chromium.launch();
await mkdir(SHOTS, { recursive: true });
const measured = [];

for (const scheme of ["light", "dark"]) {
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({
      viewport,
      colorScheme: scheme,
      deviceScaleFactor: 2,
    });

    // --- field.invalid.focused -------------------------------------------
    {
      const page = await context.newPage();
      await page.route("**/api/auth/**", (route) =>
        route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "invalid_request",
              message: "Check the form.",
              fields: {
                email: "That does not look like an email address.",
                password: "Use at least 10 characters.",
              },
            },
          }),
        }),
      );
      await page.goto(`${BASE}/dev/screens?screen=sign-up`, {
        waitUntil: "networkidle",
      });
      await page.fill("#email", "stranger@example.com");
      await page.fill("#password", "a-long-enough-password");
      await page.click('button[type="submit"]');
      await page.waitForTimeout(400);

      /*
       * What the ring and the border actually resolve to in the same pixels.
       * The border is the state; the ring is chrome laid on top of it, and
       * whether they are the same hue is the whole question.
       */
      const m = await page.evaluate(() => {
        const input = document.querySelector("#email");
        const s = getComputedStyle(input);
        return {
          focused: document.activeElement?.id ?? null,
          borderWidth: s.borderTopWidth,
          borderColor: s.borderTopColor,
          ringColor: s.getPropertyValue("--tw-ring-color").trim() || null,
          ringOffsetColor:
            s.getPropertyValue("--tw-ring-offset-color").trim() || null,
          boxShadow: s.boxShadow,
        };
      });
      measured.push([`${scheme}/${label} field.invalid.focused`, m]);

      await page.screenshot({
        path: join(SHOTS, `field-invalid-focused--${scheme}--${label}.png`),
      });
      // Tight crop on the field itself — the defect is 2px wide.
      const box = await page.locator("#email").boundingBox();
      if (box) {
        await page.screenshot({
          path: join(SHOTS, `field-invalid-focused-crop--${scheme}--${label}.png`),
          clip: {
            x: Math.max(0, box.x - 14),
            y: Math.max(0, box.y - 14),
            width: Math.min(viewport.width, box.width + 28),
            height: box.height + 56,
          },
        });
      }
      await page.close();
    }

    // --- alert.ok ---------------------------------------------------------
    {
      const page = await context.newPage();
      await page.route("**/api/keys/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            key: { provider: "anthropic", last4: "9f2c" },
          }),
        }),
      );
      await page.goto(`${BASE}/dev/screens?screen=keys`, {
        waitUntil: "networkidle",
      });
      await page.fill("#key-anthropic", "sk-ant-not-a-real-key");
      await page.click('button:has-text("Connect key")');
      await page.waitForTimeout(500);

      const m = await page.evaluate(() => {
        const el = document.querySelector('[role="status"]');
        if (!el) return { present: false };
        const s = getComputedStyle(el);
        return {
          present: true,
          role: el.getAttribute("role"),
          radius: s.borderRadius,
          railWidth: s.borderLeftWidth,
          railColor: s.borderLeftColor,
          fill: s.backgroundColor,
          text: el.textContent?.trim().slice(0, 80),
        };
      });
      measured.push([`${scheme}/${label} alert.ok`, m]);

      await page.screenshot({
        path: join(SHOTS, `alert-ok--${scheme}--${label}.png`),
      });
      await page.close();
    }

    await context.close();
  }
}

await browser.close();

for (const [name, m] of measured) {
  console.log(`${name}\n  ${JSON.stringify(m)}`);
}
