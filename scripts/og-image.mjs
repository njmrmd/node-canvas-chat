#!/usr/bin/env node
/**
 * Regenerates the Open Graph card from the app itself.
 *
 *   pnpm dev                       # in another terminal
 *   node scripts/og-image.mjs
 *
 * It opens `/dev/og` in headless Chrome at exactly 1200x630 and writes the
 * screenshot to `src/app/opengraph-image.png`, where Next's file convention
 * picks it up and emits `og:image` with the right type and dimensions. Run it
 * whenever the drawing, the card's wording or the colour tokens change — the
 * PNG is a build output that happens to be committed, not a hand-made asset.
 *
 * Two things are deliberate:
 *
 * - **The light scheme.** The card is rendered light because that is the
 *   product's default appearance, and because a white card is the one that
 *   looks intentional in both Slack themes rather than only in one. Pass
 *   `--scheme dark` to see the alternative; changing which one ships is one
 *   word here.
 * - **1x, not 2x.** 1200x630 is what every crawler asks for, and a flat
 *   two-colour drawing gains almost nothing from a retina export while
 *   doubling a binary that lives in git forever.
 *
 * The route only exists under `next dev` — it is `notFound()` everywhere else —
 * so this cannot be pointed at a deployment.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withPage, parseArgs } from "./lib/cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = args.base ?? "http://127.0.0.1:3000";
const SCHEME = args.scheme ?? "light";
const OUT = args.out ?? join(process.cwd(), "src/app/opengraph-image.png");

const SIZE = { width: 1200, height: 630 };

await withPage(async (page) => {
  await page.emulate({ ...SIZE, scale: 1, scheme: SCHEME });
  await page.navigate(`${BASE}/dev/og`);

  // A card that came out the wrong size is a card that unfurls cropped, and
  // the only place that shows up is someone else's chat client. Check here.
  const box = await page.eval(`(() => {
    const el = document.querySelector("main");
    const { width, height } = el.getBoundingClientRect();
    return { width, height };
  })()`);

  if (box.width !== SIZE.width || box.height !== SIZE.height) {
    throw new Error(
      `/dev/og rendered ${box.width}x${box.height}, expected ${SIZE.width}x${SIZE.height}`,
    );
  }

  const png = await page.screenshot({ clip: { x: 0, y: 0, ...SIZE } });
  await writeFile(OUT, png);

  console.log(`${OUT} — ${SIZE.width}x${SIZE.height}, ${SCHEME}, ${png.length} bytes`);
});
