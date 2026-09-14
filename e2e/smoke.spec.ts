import { expect, test } from "@playwright/test";

/**
 * Harness smoke test. Deliberately thin: it proves a real browser starts, the
 * app boots, and the two public entry points serve — nothing more. The
 * sign-up-to-first-chat path is a separate spec and needs a database.
 *
 * Everything asserted here works with an empty environment. `/sign-up` only
 * touches the database when a session cookie is present, and a fresh browser
 * context has none, so this suite needs no `DATABASE_URL`.
 */

test("the landing page loads", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("the sign-up route is reachable and renders its form", async ({
  page,
}) => {
  const response = await page.goto("/sign-up");

  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Create an account" }),
  ).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});
