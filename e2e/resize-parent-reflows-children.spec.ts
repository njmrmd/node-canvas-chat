import { expect, test } from "@playwright/test";

/**
 * TES-110: resizing a parent that already has two real children must move
 * those children clear of the parent's new bounds and of each other — the
 * same reflow `reflowChildrenOnCreate` already runs on node *creation*
 * (TES-103), now also run from `resizeNode` (`use-canvas-controller.ts`).
 * Before that fix, `resizeNode` only ever patched the node's `size`; the
 * composer's skeleton preview (`previewNodePosition`, canvas-app.tsx) then
 * computed a fresh reflow from the parent's *post*-resize size while the real
 * cards stayed at their stale, pre-resize slots, so the preview landed on top
 * of an already-placed sibling. See `src/lib/canvas/layout.test.ts` for the
 * exact-geometry reproduction and fix-confirmation of that mismatch.
 *
 * This spec checks the same mechanism end to end in a real browser, without
 * needing a connected model key: it seeds a parent-with-two-children graph
 * directly via `PUT /api/canvas` (no streamed reply required), drags the
 * parent's resize handle, and asserts from real `getBoundingClientRect()`
 * rects that (a) neither child overlaps the parent's new bounds or the other
 * child, and (b) the children actually moved — proving the live reflow fired
 * rather than merely not having collided by chance.
 *
 * Does not need `E2E_ANTHROPIC_API_KEY` — resizing does not touch the
 * composer's provider-gated preview, only the real sibling positions the
 * preview must agree with.
 */

const hasDb = Boolean(process.env.DATABASE_URL || process.env.E2E_BASE_URL);

test.skip(
  !hasDb,
  "needs DATABASE_URL/KEY_VAULT_ENCRYPTION_KEY (or E2E_BASE_URL pointing at a deployment that has them) — see e2e/README.md",
);

test.use({ viewport: { width: 1440, height: 900 } });

function freshAccount() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    email: `e2e-tes110-resize-${stamp}@example.com`,
    password: "correct horse battery staple",
  };
}

type Rect = { x: number; y: number; width: number; height: number };

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

test("resizing a parent with two children reflows them clear of its new bounds", async ({ page }) => {
  const account = freshAccount();

  await page.goto("/sign-up");
  await page.locator("#email").fill(account.email);
  await page.locator("#password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/keys");

  // No key is connected — this spec never needs the composer to be enabled,
  // only the canvas's own resize/reflow plumbing, which runs regardless.
  await page.goto("/canvas");

  const now = Date.now();
  const seeded = {
    graph: {
      nodeIds: ["root", "reply", "fork"],
      nodesById: {
        root: {
          id: "root",
          parentId: null,
          prompt: "What is the capital of France?",
          response: "Paris.",
          thinking: "",
          status: "complete",
          error: null,
          position: { x: 400, y: 200 },
          positionMode: "auto",
          size: null,
          collapsed: false,
          bodyCollapsed: false,
          usage: null,
          createdAt: now,
          updatedAt: now,
        },
        reply: {
          id: "reply",
          parentId: "root",
          prompt: "Name one famous landmark there.",
          response: "The Eiffel Tower.",
          thinking: "",
          status: "complete",
          error: null,
          position: { x: 140, y: 432 },
          positionMode: "auto",
          size: null,
          collapsed: false,
          bodyCollapsed: false,
          usage: null,
          createdAt: now + 1,
          updatedAt: now + 1,
        },
        fork: {
          id: "fork",
          parentId: "root",
          prompt: "Tell me about deep sea vents instead.",
          response: "Hydrothermal vents host chemosynthetic ecosystems.",
          thinking: "",
          status: "complete",
          error: null,
          position: { x: 660, y: 432 },
          positionMode: "auto",
          size: null,
          collapsed: false,
          bodyCollapsed: false,
          usage: null,
          createdAt: now + 2,
          updatedAt: now + 2,
        },
      },
    },
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedNodeId: null,
    hasBranchedOnce: true,
  };

  // In-page fetch, not `page.request` — the CSRF `Origin` check
  // (`src/lib/auth/csrf.ts`) only sees a same-origin request from a real
  // page navigation/fetch, which is also what the app's own save path does.
  const putStatus = await page.evaluate(async (body) => {
    const res = await fetch("/api/canvas", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status;
  }, seeded);
  expect(putStatus).toBe(204);

  await page.reload();

  const cards = page.locator('[data-node-role="card"]');
  await expect(cards).toHaveCount(3);

  const rootCard = page.locator('[data-node-id="root"]');
  const replyCard = page.locator('[data-node-id="reply"]');
  const forkCard = page.locator('[data-node-id="fork"]');

  const replyBefore = await replyCard.boundingBox();
  const forkBefore = await forkCard.boundingBox();
  expect(replyBefore).toBeTruthy();
  expect(forkBefore).toBeTruthy();

  const handle = rootCard.getByRole("button", { name: "Resize card" });
  const handleBox = await handle.boundingBox();
  expect(handleBox).toBeTruthy();
  const startX = handleBox!.x + handleBox!.width / 2;
  const startY = handleBox!.y + handleBox!.height / 2;

  // Corner-drag-resize root substantially bigger — the exact repro shape
  // from the ticket ("Corner-drag-resize that same node bigger").
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 220, startY + 220, { steps: 10 });
  await page.mouse.up();

  // Give the live reflow (which reads real measured card heights) a moment
  // to settle after the resize's own re-layout.
  await page.waitForTimeout(200);

  const rootAfter = await rootCard.boundingBox();
  const replyAfter = await replyCard.boundingBox();
  const forkAfter = await forkCard.boundingBox();
  expect(rootAfter).toBeTruthy();
  expect(replyAfter).toBeTruthy();
  expect(forkAfter).toBeTruthy();

  expect(
    replyAfter!.x !== replyBefore!.x || replyAfter!.y !== replyBefore!.y,
    "reply must actually move — proves the live reflow fired rather than the assertions below passing by chance",
  ).toBe(true);

  expect(rectsOverlap(rootAfter!, replyAfter!), "resized root must not overlap the reply sibling").toBe(false);
  expect(rectsOverlap(rootAfter!, forkAfter!), "resized root must not overlap the fork sibling").toBe(false);
  expect(rectsOverlap(replyAfter!, forkAfter!), "the two siblings must not overlap each other").toBe(false);
});
