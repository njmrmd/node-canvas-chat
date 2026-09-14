import { defineConfig, devices } from "@playwright/test";

/**
 * Browser test harness.
 *
 * Two rules this file exists to enforce:
 *
 * 1. **The browser is pinned, not borrowed.** The `chromium` project below
 *    deliberately sets no `channel`, so Playwright launches the Chrome for
 *    Testing build it downloaded for this exact `@playwright/test` version.
 *    That version is pinned without a caret in `package.json`, which is what
 *    makes "same repo, same browser build" true on every machine and in CI.
 *    Never add `channel: "chrome"` here — that hands the run to whatever
 *    Google Chrome happens to be installed on the host.
 * 2. **The server under test is the repo's own.** By default Playwright boots
 *    `next dev` itself on `E2E_PORT`, so `pnpm test:e2e` is one command from a
 *    cold clone. Point `E2E_BASE_URL` at an already-running server (a preview
 *    deployment, a `pnpm start`, your own `pnpm dev`) and the managed server
 *    is skipped.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);
const externalBaseURL = process.env.E2E_BASE_URL;
// `localhost`, not `127.0.0.1` — `next dev` treats a mismatched host as a
// cross-origin dev request and refuses to serve HMR to it.
const baseURL = externalBaseURL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // A stray `test.only` should fail the run in CI, not silently skip the rest.
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: externalBaseURL
    ? undefined
    : {
        command: `pnpm dev --port ${PORT}`,
        // `/api/health` is a server function, so a 200 from it proves the app
        // is actually serving and not just holding the port open.
        url: `${baseURL}/api/health`,
        // Locally, reuse a dev server you already have running. In CI there is
        // never one to reuse, and silently attaching to a stale process would
        // make a green run meaningless.
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});
