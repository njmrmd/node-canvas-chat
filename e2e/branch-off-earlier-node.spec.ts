import { expect, test } from "@playwright/test";

/**
 * TES-117 regression: "Branch off a node that is not the newest" is the
 * shape TES-107 flagged as the one that catches fork-vs-append — reply to an
 * earlier node in a chain and the new message must attach there, not silently
 * continue the newest leaf. QA reported this broken on desktop (1440x900)
 * only, immediately after TES-106's y-offset reflow fix.
 *
 * This could not be reproduced against real product code across three
 * independent local repros (a hand-seeded well-spaced 4-node chain, a
 * hand-seeded chain with node2's row deliberately under-spaced to force an
 * overlap with node3/node4, and a fully live repro driving real Send/
 * reflowChildrenOnCreate/ResizeObserver with only `/api/chat` faked) — see
 * the TES-117 issue comment for the detail. In all three, clicking node2's
 * own Branch control (both the header icon and the bottom branch handle, at
 * on-screen coordinates confirmed via `elementFromPoint`) correctly rebinds
 * `selectedNodeId` and the new node persists with `parentId` pointing at
 * node2.
 *
 * The one concrete, exactly-matching failure mode found while building that
 * repro was in tooling, not the product: this canvas pans via a CSS
 * `transform`, not a real scrollable container, so `Element.scrollIntoView()`
 * is a silent no-op on it. A script that uses it to "scroll node2 into view"
 * (instead of a real pan, e.g. `page.mouse.wheel`) computes click
 * coordinates against a card that never moved — for a tall node2 that lands
 * the header actions bar off-screen, and the click silently misses. That
 * reproduces every symptom in the ticket (frozen composer badge, identical
 * before/after screenshots, skeleton landing at the tail of the chain) with
 * no product-code cause at all.
 *
 * This spec is the durable guard either way: it drives the exact repro
 * shape through a real browser, using `page.mouse.wheel` (a real pan, not
 * `scrollIntoView`) to bring node2 into view, so it cannot repeat that
 * specific tooling mistake. If TES-117 is real and just wasn't hit by these
 * three repros, this is what will catch it.
 *
 * Needs a real, billable Anthropic key (`E2E_ANTHROPIC_API_KEY`) — the whole
 * point is a chain of real streamed replies, one of them long enough to hit
 * the 640px card auto-size ceiling, which nothing in this repo can fake
 * without reaching for the `/api/chat` route interception e2e/README.md
 * explicitly says this suite does not do. Skips without one, same as
 * `sign-up-to-first-chat.spec.ts`.
 */

const hasDb = Boolean(process.env.DATABASE_URL || process.env.E2E_BASE_URL);
const REAL_KEY = process.env.E2E_ANTHROPIC_API_KEY;

test.skip(
  !hasDb,
  "needs DATABASE_URL/KEY_VAULT_ENCRYPTION_KEY (or E2E_BASE_URL pointing at a deployment that has them) — see e2e/README.md",
);

test.use({ viewport: { width: 1440, height: 900 } });

function freshAccount() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    email: `e2e-tes117-branch-${stamp}@example.com`,
    password: "correct horse battery staple",
  };
}

test("branching off a non-newest node attaches the reply there, not to the newest leaf", async ({
  page,
}) => {
  test.skip(
    !REAL_KEY,
    "set E2E_ANTHROPIC_API_KEY to exercise a real chain of streamed replies",
  );
  test.setTimeout(120_000);

  const account = freshAccount();

  await page.goto("/sign-up");
  await page.locator("#email").fill(account.email);
  await page.locator("#password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/keys");

  await page.locator("#key-anthropic").fill(REAL_KEY!);
  await page.getByRole("button", { name: "Connect key" }).click();
  await expect(page.getByText("Key verified and saved")).toBeVisible();

  await page.getByRole("link", { name: "Open the canvas" }).click();
  await page.waitForURL("**/canvas");

  const cards = page.locator('[data-node-role="card"]');
  const composer = page.locator("textarea");

  const sendAndWait = async (text: string, expectedCount: number) => {
    await composer.fill(text);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(cards).toHaveCount(expectedCount);
    await expect(cards.nth(expectedCount - 1)).toHaveAttribute(
      "aria-label",
      /, (complete|interrupted|error)$/,
      { timeout: 45_000 },
    );
  };

  await sendAndWait("What is the capital of France?", 1);
  // Long enough to hit the 640px auto-size ceiling (node-card.tsx) — this is
  // the exact condition QA's repro needed to reach the TES-107/117 shape.
  await sendAndWait(
    "Write at least 500 words about the history of Paris, covering the Roman settlement, the medieval period and the modern city, with specific names and dates.",
    2,
  );
  await sendAndWait("Name one famous landmark there.", 3);
  await sendAndWait("What river runs through it?", 4);

  await expect(page.getByText("Replying to · Node 4")).toBeVisible();

  const node2 = cards.nth(1);
  const node2Id = await node2.getAttribute("data-node-id");
  expect(node2Id).toBeTruthy();

  // Real pan, not `Element.scrollIntoView()` — see the file header comment
  // for why that distinction is the whole point of this spec.
  for (let i = 0; i < 40; i++) {
    const box = await node2.boundingBox();
    if (!box) throw new Error("node2 card not found while panning");
    const targetY = 450 - box.height / 2;
    const diff = box.y - targetY;
    if (Math.abs(diff) < 20) break;
    await page.mouse.wheel(0, diff > 0 ? 120 : -120);
    await page.waitForTimeout(60);
  }

  await node2.getByRole("button", { name: "Branch" }).first().click();
  await expect(page.getByText("Replying to · Node 2")).toBeVisible();

  await sendAndWait("Tell me about deep sea vents instead.", 5);

  const canvasState = await page.request.get("/api/canvas").then((r) => r.json());
  const newest = canvasState.graph.nodeIds[canvasState.graph.nodeIds.length - 1];
  expect(canvasState.graph.nodesById[newest].parentId).toBe(node2Id);
});
