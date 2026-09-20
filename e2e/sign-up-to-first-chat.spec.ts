import { expect, test } from "@playwright/test";

/**
 * TES-22: the critical path — land, sign up, connect a key, get a first
 * streamed reply — re-run by hand on every shareable build. This is that
 * path as a spec, at the two viewports QA has been checking (1440x900 and
 * 390x844).
 *
 * Every test creates its own throwaway account with a timestamp+random
 * email, so runs never share state and never need hand cleanup.
 *
 * This needs a real database and key vault (`DATABASE_URL`,
 * `KEY_VAULT_ENCRYPTION_KEY`) to get past sign-up at all — see
 * e2e/README.md. It skips, rather than fails, without them. When pointed at
 * a deployment via `E2E_BASE_URL`, that deployment's own environment is
 * assumed to have both.
 *
 * The last leg of the path — an actual streamed model reply — needs a real,
 * billable Anthropic key, which nothing in this repo provisions for free.
 * Set `E2E_ANTHROPIC_API_KEY` to exercise it. Without it, everything up to
 * and including key *validation* still runs (using a deliberately invalid
 * key, which costs nothing and is deterministic), and only the final
 * streamed-reply assertion is skipped.
 */

const hasDb = Boolean(process.env.DATABASE_URL || process.env.E2E_BASE_URL);
const REAL_KEY = process.env.E2E_ANTHROPIC_API_KEY;

test.skip(
  !hasDb,
  "needs DATABASE_URL/KEY_VAULT_ENCRYPTION_KEY (or E2E_BASE_URL pointing at a deployment that has them) — see e2e/README.md",
);

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

function freshAccount(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    email: `e2e-tes22-${label}-${stamp}@example.com`,
    password: "correct horse battery staple",
  };
}

async function signUp(
  page: import("@playwright/test").Page,
  account: { email: string; password: string },
) {
  await page.goto("/sign-up");
  await page.locator("#email").fill(account.email);
  await page.locator("#password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  // A fresh account has no key yet, so the default post-sign-up destination
  // is /keys, not /canvas — see DEFAULT_SIGNED_IN_PATH in
  // src/lib/auth/next-path.ts.
  await page.waitForURL("**/keys");
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} (${viewport.width}x${viewport.height})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("lands, signs up, and a bad key is rejected without being stored", async ({
      page,
    }) => {
      const account = freshAccount(`${viewport.name}-badkey`);

      // 1. Land.
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      // 2. Sign up. A fresh account has no key yet, so it lands on /keys.
      await signUp(page, account);

      // 3. An invalid key is rejected server-side and never stored — the
      // route validates against the real provider before writing anything
      // (src/app/api/keys/[provider]/route.ts). This costs nothing and is
      // deterministic, unlike a real key round trip.
      await page.locator("#key-anthropic").fill("sk-ant-e2e-invalid-key-00000000000000");
      await page.getByRole("button", { name: "Connect key" }).click();
      await expect(page.getByText(/rejected that key/i)).toBeVisible();

      // 4. Confirm it really was not stored: the canvas still asks to
      // connect a model, it does not let the rejected key through.
      await page.goto("/canvas");
      await expect(
        page.getByRole("link", { name: "Connect model access" }),
      ).toBeVisible();
    });

    test("connects a real key and gets a first streamed reply", async ({
      page,
    }) => {
      test.skip(
        !REAL_KEY,
        "set E2E_ANTHROPIC_API_KEY to exercise a real streamed model reply",
      );
      test.setTimeout(60_000);

      const account = freshAccount(`${viewport.name}-realkey`);

      // A fresh account has no key yet, so sign-up lands directly on /keys.
      await signUp(page, account);

      await page.locator("#key-anthropic").fill(REAL_KEY!);
      await page.getByRole("button", { name: "Connect key" }).click();
      await expect(page.getByText("Key verified and saved")).toBeVisible();

      await page.getByRole("link", { name: "Open the canvas" }).click();
      await page.waitForURL("**/canvas");

      await page
        .locator("textarea")
        .fill("Reply with exactly the word: pong");
      await page.getByRole("button", { name: "Send" }).click();

      // Node status goes draft -> streaming -> complete (or interrupted /
      // error). Poll the accessible name rather than any visual cue — see
      // src/components/canvas/node-card.tsx's `ariaLabel`.
      const node = page.locator('[data-node-role="card"]').last();
      await expect(node).toHaveAttribute(
        "aria-label",
        /, (complete|interrupted|error)$/,
        { timeout: 45_000 },
      );
      await expect(node).toHaveAttribute("aria-label", /, complete$/);
      await expect(node).not.toHaveText("");
    });
  });
}
