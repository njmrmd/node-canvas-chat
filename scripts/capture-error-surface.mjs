/**
 * Renders every row of the error routing table against the real components and
 * screenshots the result, at both viewports in both schemes.
 *
 *   pnpm dev -p 4317
 *   node scripts/capture-error-surface.mjs        # -> scripts/shots/
 *
 * Nothing here is a mock-up. It drives `/sign-up`, `/sign-in` and the dev-only
 * `/dev/screens` harness — the shipped `AuthForm` and `KeyManager` — and only
 * intercepts the API response, so what is in the PNG is what a user would see
 * if the server actually returned that code.
 *
 * It also measures the two radii and the two tap targets out of the live DOM on
 * every run and fails if they regress, because "the banner looks rounder than
 * the input" is not something to check by eye at four in the afternoon.
 *
 * Playwright is not a dependency of this app — it is a screenshot tool, not
 * something that ships — so this resolves it from wherever it is installed and
 * says so plainly if it cannot find it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "shots");
const BASE = process.env.BASE_URL ?? "http://localhost:4317";

/**
 * `createRequire` ignores NODE_PATH, so try this file's own resolution first
 * and then an explicitly pointed-at install. `PLAYWRIGHT_DIR` should be the
 * `node_modules` directory that contains it.
 */
function loadPlaywright() {
  const candidates = [import.meta.url];
  if (process.env.PLAYWRIGHT_DIR) {
    candidates.push(`file://${join(process.env.PLAYWRIGHT_DIR, "index.js")}`);
  }

  for (const from of candidates) {
    try {
      return createRequire(from)("playwright");
    } catch {
      // Try the next one.
    }
  }

  console.error(
    "Playwright is not resolvable from here. It is a screenshot tool, not an\n" +
      "app dependency, so point at an existing install:\n" +
      "  PLAYWRIGHT_DIR=/path/to/node_modules node scripts/capture-error-surface.mjs",
  );
  process.exit(1);
}

const { chromium } = loadPlaywright();

/** `{ code, message, fields? }` -> the envelope `apiFetch` expects. */
const envelope = (code, message, fields) => ({
  error: { code, message, ...(fields ? { fields } : {}) },
});

/**
 * Every row of the routing table, in order.
 *
 * `screen` picks the page, `respond` decides what the server pretends to be,
 * and `act` drives the form. `note` is what the row is supposed to prove.
 */
const SCENARIOS = [
  {
    name: "field-invalid-request",
    note: "invalid_request with fields -> per-field messages, no banner",
    screen: "/sign-up",
    status: 400,
    body: envelope("invalid_request", "Check the form.", {
      email: "That does not look like an email address.",
      password: "Use at least 10 characters.",
    }),
  },
  {
    name: "alert-invalid-request",
    note: "invalid_request without fields -> banner, error tone",
    screen: "/sign-up",
    status: 400,
    body: envelope("invalid_request", "Request body is not valid JSON."),
  },
  {
    name: "alert-invalid-credentials",
    note: "invalid_credentials -> banner, never says which half was wrong",
    screen: "/sign-in",
    status: 401,
    body: envelope("invalid_credentials", "Email or password is incorrect."),
  },
  {
    name: "field-email-taken",
    note: "email_taken -> field message on email with a link to sign in",
    screen: "/sign-up",
    status: 409,
    body: envelope("email_taken", "That email is already registered."),
  },
  {
    name: "alert-rate-limited",
    note: "rate_limited -> wait tone, live countdown, submit disabled",
    screen: "/sign-up",
    status: 429,
    headers: { "Retry-After": "47" },
    body: envelope("rate_limited", "Too many attempts from this address."),
  },
  {
    name: "alert-csrf-failed",
    note: "csrf_failed -> banner with a Reload the page action",
    screen: "/sign-up",
    status: 403,
    body: envelope(
      "csrf_failed",
      "This request did not come from the app. Please reload and try again.",
    ),
  },
  {
    name: "alert-not-configured",
    note: "not_configured -> wait tone, 'This one is on us'",
    screen: "/sign-up",
    status: 503,
    body: envelope("not_configured", "The database is not configured yet."),
  },
  {
    name: "alert-unsupported-provider",
    note: "unsupported_provider -> error tone, no action button",
    screen: "/sign-up",
    status: 400,
    body: envelope("unsupported_provider", "Unknown provider."),
  },
  {
    name: "alert-forbidden",
    note: "forbidden -> banner, no title",
    screen: "/sign-up",
    status: 403,
    body: envelope("forbidden", "Not yours."),
  },
  {
    name: "alert-internal-error",
    note: "internal_error -> banner with a Try again action",
    screen: "/sign-up",
    status: 500,
    body: envelope("internal_error", "Something went wrong on our side."),
  },
  {
    name: "alert-offline",
    note: "transport failure -> banner, submit re-enabled immediately",
    screen: "/sign-up",
    abort: true,
  },
  {
    name: "keys-rejected",
    note: "invalid_api_key -> field message under the key input, value kept",
    screen: "/dev/screens?screen=keys",
    api: "**/api/keys/**",
    status: 400,
    body: envelope("invalid_api_key", "Anthropic rejected that key."),
    fill: { selector: "#key-anthropic", value: "sk-ant-not-a-real-key" },
    submit: 'button:has-text("Connect key")',
  },
  {
    name: "keys-system-down",
    note: "provider_unavailable -> wait tone, key was not changed",
    screen: "/dev/screens?screen=keys",
    api: "**/api/keys/**",
    status: 502,
    body: envelope("provider_unavailable", "Anthropic did not answer in time."),
    fill: { selector: "#key-anthropic", value: "sk-ant-not-a-real-key" },
    submit: 'button:has-text("Connect key")',
  },
  {
    name: "keys-connected",
    note: "the ok tone — a success is role=status, not an interruption",
    screen: "/dev/screens?screen=keys-connected",
    passive: true,
  },
  {
    name: "no-key-empty-state",
    note: "no_key_configured is not an error: no red banner, Connect a key",
    screen: "/dev/screens?screen=keys",
    passive: true,
  },
  {
    name: "session-ended",
    note: "unauthenticated -> redirect to sign-in, wait tone, no red",
    screen: "/sign-in",
    passive: true,
  },
];

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

async function run() {
  await mkdir(SHOTS, { recursive: true });

  /*
   * No `channel`, so this runs Playwright's own pinned Chrome for Testing
   * rather than whatever Chrome the machine happens to have. A screenshot that
   * is evidence for a design verdict has to be reproducible: borrowing the host
   * browser means the renders depend on someone's auto-update schedule, and a
   * 1.5px border is exactly the kind of thing that shifts between versions.
   */
  const browser = await chromium.launch();
  const failures = [];
  const measured = [];

  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        viewport,
        colorScheme: scheme,
        deviceScaleFactor: 2,
        reducedMotion: "no-preference",
      });

      for (const scenario of SCENARIOS) {
        const page = await context.newPage();

        const pattern = scenario.api ?? "**/api/auth/**";
        await page.route(pattern, async (route) => {
          if (scenario.abort) return route.abort("failed");
          if (!scenario.status) return route.continue();
          await route.fulfill({
            status: scenario.status,
            contentType: "application/json",
            headers: scenario.headers ?? {},
            body: JSON.stringify(scenario.body),
          });
        });

        const url = scenario.screen.startsWith("/dev")
          ? `${BASE}${scenario.screen}`
          : `${BASE}${scenario.screen}`;
        await page.goto(url, { waitUntil: "networkidle" });

        if (!scenario.passive) {
          if (scenario.fill) {
            await page.fill(scenario.fill.selector, scenario.fill.value);
          } else {
            await page.fill("#email", "stranger@example.com");
            await page.fill("#password", "a-long-enough-password");
          }
          await page.click(scenario.submit ?? 'button[type="submit"]');
          // The surface renders within a frame; give the enter transition its
          // 180ms and a little slack so the PNG is of the settled state.
          await page.waitForTimeout(400);
        }

        const file = `${scenario.name}--${scheme}--${label}.png`;
        await page.screenshot({ path: join(SHOTS, file), fullPage: false });

        // --- the checks that replace looking at it -----------------------
        if (scenario.name === "field-invalid-request") {
          const m = await page.evaluate(() => {
            const input = document.querySelector("#email");
            const alertEl = document.querySelector('[role="alert"]');
            const err = document.querySelector("#email-error");
            return {
              inputRadius: getComputedStyle(input).borderRadius,
              inputBorder: getComputedStyle(input).borderTopWidth,
              inputColor: getComputedStyle(input).borderTopColor,
              banner: Boolean(alertEl),
              fieldErrorRole: err?.getAttribute("role") ?? null,
              describedBy: input.getAttribute("aria-describedby"),
              focused: document.activeElement?.id ?? null,
            };
          });
          measured.push([`${scheme}/${label} field.invalid`, JSON.stringify(m)]);

          if (m.banner) {
            failures.push(
              `${scenario.name} ${scheme}/${label}: a banner rendered alongside field errors`,
            );
          }
          if (m.fieldErrorRole === "alert") {
            failures.push(
              `${scenario.name} ${scheme}/${label}: field message still has role="alert"`,
            );
          }
          if (m.focused !== "email") {
            failures.push(
              `${scenario.name} ${scheme}/${label}: focus went to ${m.focused}, not the first invalid control`,
            );
          }
          if (parseFloat(m.inputRadius) !== 6) {
            failures.push(
              `${scenario.name} ${scheme}/${label}: control radius is ${m.inputRadius}, expected 6px`,
            );
          }
          if (parseFloat(m.inputBorder) !== 1.5) {
            failures.push(
              `${scenario.name} ${scheme}/${label}: invalid border is ${m.inputBorder}, expected 1.5px`,
            );
          }
        }

        if (scenario.name === "alert-invalid-request") {
          const m = await page.evaluate(() => {
            const el = document.querySelector('[role="alert"]');
            const s = getComputedStyle(el);
            return {
              radius: s.borderRadius,
              railWidth: s.borderLeftWidth,
              fill: s.backgroundColor,
              role: el.getAttribute("role"),
              focused: document.activeElement?.tagName ?? null,
            };
          });
          measured.push([`${scheme}/${label} alert.error`, JSON.stringify(m)]);

          if (parseFloat(m.radius) !== 10) {
            failures.push(
              `${scenario.name} ${scheme}/${label}: alert radius is ${m.radius}, expected 10px`,
            );
          }
          if (parseFloat(m.railWidth) !== 3) {
            failures.push(
              `${scenario.name} ${scheme}/${label}: rail is ${m.railWidth}, expected 3px`,
            );
          }
          if (m.fill === "rgba(0, 0, 0, 0)") {
            failures.push(
              `${scenario.name} ${scheme}/${label}: alert has no tonal fill`,
            );
          }
          if (m.focused === "BUTTON") {
            // Correct: a form-level alert must not steal focus.
          } else if (m.focused === "INPUT") {
            failures.push(
              `${scenario.name} ${scheme}/${label}: a banner moved focus to an input`,
            );
          }
        }

        if (scenario.name === "alert-rate-limited") {
          const m = await page.evaluate(() => {
            const submit = document.querySelector('button[type="submit"]');
            const banner = document.querySelector('[role="alert"]');
            return {
              disabled: submit.disabled,
              opacity: getComputedStyle(submit).opacity,
              cursor: getComputedStyle(submit).cursor,
              buttonText: submit.textContent.trim(),
              bannerText: banner?.textContent.trim() ?? "",
            };
          });
          measured.push([`${scheme}/${label} form.rateLimited`, JSON.stringify(m)]);

          if (!m.disabled) {
            failures.push(
              `${scenario.name} ${scheme}/${label}: submit is not disabled during the wait`,
            );
          }
          if (parseFloat(m.opacity) < 1) {
            failures.push(
              `${scenario.name} ${scheme}/${label}: disabled submit uses opacity ${m.opacity} instead of a disabled style`,
            );
          }
          // The banner and the button must show the same clock.
          const clock = /(\d+:\d\d)/;
          const inButton = m.buttonText.match(clock)?.[1];
          const inBanner = m.bannerText.match(clock)?.[1];
          if (!inButton || !inBanner || inButton !== inBanner) {
            failures.push(
              `${scenario.name} ${scheme}/${label}: button says ${inButton}, banner says ${inBanner}`,
            );
          }
        }

        // Tap targets, measured in the DOM rather than by eye.
        if (scenario.name === "session-ended" && label === "mobile") {
          const m = await page.evaluate(() => {
            const submit = document
              .querySelector('button[type="submit"]')
              .getBoundingClientRect();
            const link = [...document.querySelectorAll("a")]
              .find((a) => /Create one|Sign in/.test(a.textContent))
              ?.getBoundingClientRect();
            return {
              submit: [Math.round(submit.width), Math.round(submit.height)],
              link: link ? [Math.round(link.width), Math.round(link.height)] : null,
            };
          });
          measured.push([`${scheme}/mobile tap targets`, JSON.stringify(m)]);

          if (m.submit[1] < 48) {
            failures.push(
              `tap target ${scheme}: submit is ${m.submit[1]}px tall, expected >= 48`,
            );
          }
          if (!m.link || m.link[0] < 44 || m.link[1] < 44) {
            failures.push(
              `tap target ${scheme}: footer link is ${m.link?.join("x")}, expected >= 44x44`,
            );
          }
        }

        await page.close();
      }

      await context.close();
    }
  }

  // Reduced motion is a separate pass: same DOM, same colours, no transition.
  const reduced = await browser.newContext({
    viewport: VIEWPORTS.desktop,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await reduced.newPage();
  await page.route("**/api/auth/**", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify(envelope("invalid_request", "Nope.")),
    }),
  );
  await page.goto(`${BASE}/sign-up`, { waitUntil: "networkidle" });
  await page.fill("#email", "stranger@example.com");
  await page.fill("#password", "a-long-enough-password");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(50);
  const motion = await page.evaluate(() => {
    const el = document.querySelector('[role="alert"]');
    const s = getComputedStyle(el);
    return { animationName: s.animationName, opacity: s.opacity };
  });
  measured.push(["reduced-motion alert.error", JSON.stringify(motion)]);
  if (motion.animationName !== "none" || parseFloat(motion.opacity) !== 1) {
    failures.push(
      `prefers-reduced-motion: alert still animates (${motion.animationName}, opacity ${motion.opacity})`,
    );
  }
  await page.screenshot({
    path: join(SHOTS, "alert-error--reduced-motion--desktop.png"),
  });
  await reduced.close();

  await browser.close();

  const report = [
    "# Error surface capture",
    "",
    ...measured.map(([k, v]) => `- ${k}: ${v}`),
    "",
    failures.length ? "## Failures" : "## No failures",
    ...failures.map((f) => `- ${f}`),
    "",
  ].join("\n");
  await writeFile(join(SHOTS, "report.md"), report);

  console.log(report);
  if (failures.length) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
