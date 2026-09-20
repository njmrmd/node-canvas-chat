import { expect, test } from "@playwright/test";

/**
 * Harness smoke test. Deliberately thin: it proves a real browser starts, the
 * app boots, and the two public entry points serve — nothing more. The
 * sign-up-to-first-chat path is a separate spec and needs a database.
 *
 * Without a `DATABASE_URL`, `/sign-up` fails closed and renders a "not
 * finished being set up" notice instead of the form — the same heading, no
 * form fields. That is correct product behaviour, not a broken page, so this
 * spec only asserts what is true in both states: the route serves and shows
 * its heading. Asserting the form fields belongs to the DB-backed spec.
 */

test("the landing page loads", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("the sign-up route is reachable", async ({ page }) => {
  const response = await page.goto("/sign-up");

  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Create an account" }),
  ).toBeVisible();
});
