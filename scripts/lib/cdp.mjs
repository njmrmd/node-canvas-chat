/**
 * A very small DevTools protocol client, and a headless Chrome to point it at.
 *
 * Why not a browser automation library: the system Chrome already speaks this
 * protocol over a websocket and Node has had a websocket client since 22.
 * Adding Playwright would mean a ~400MB browser download in the dependency tree
 * of a product that does not use a browser at runtime.
 *
 * `scripts/screenshot.mjs` still carries its own copy of this client. That is
 * not a second opinion about how to do it — it landed first, and rewriting a
 * working review harness to import this was not worth doing in the same change
 * that introduced it. Whoever next touches that file should delete its client
 * and import this one.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Runs `fn` against a headless page, then cleans up the browser and its
 * throwaway profile whether `fn` threw or not.
 *
 * The debugging port is allocated by Chrome (`--remote-debugging-port=0`) and
 * read back from the `DevToolsActivePort` file in *our* profile directory. It
 * used to be hard-coded to 9334, which is a correctness bug and not a tidiness
 * one: two agent runs capture at the same time in this repo routinely, and when
 * the port was already bound the second Chrome failed to start while
 * `connectToPage` happily attached to the *first run's* browser. Its assertions
 * then ran against whatever page that browser happened to be on.
 *
 * That is not a flaky test — it is a harness that silently measures someone
 * else's tab. It was caught by a sign-up probe that reported `/dev/screens`,
 * a route belonging to a different capture script entirely; the same collision
 * also produced a green 6/6 and a red 1/6 on identical input minutes apart.
 * A pass from the old code means as little as a failure.
 *
 * Reading the port from our own profile dir makes the browser we talk to
 * provably the one we spawned: nothing else can write that file.
 */
export async function withPage(fn) {
  const profile = await mkdtemp(join(tmpdir(), "ncc-cdp-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    // 0 = let the OS pick a free one. Never a fixed port; see above.
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    // The export is an image file other people's software colour-manages.
    // Pin the profile so it does not come out of this machine's display.
    "--force-color-profile=srgb",
    "about:blank",
  ]);
  chrome.stderr.on("data", () => {});

  try {
    const port = await activePort(profile);
    const page = await connectToPage(port);
    try {
      return await fn(page);
    } finally {
      page.close();
    }
  } finally {
    // `kill` only delivers the signal. Chrome is still flushing its profile
    // while we would be deleting it, which loses the race as `ENOTEMPTY` and
    // throws *after* every assertion has already passed — a green run that
    // exits non-zero. For a check meant to gate a hand-off that is as bad as a
    // false green, so wait for the process to actually be gone first.
    chrome.kill();
    await once(chrome, "exit").catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The port Chrome actually bound, from the `DevToolsActivePort` file it writes
 * into its own profile directory. Line 1 is the port.
 */
async function activePort(profile) {
  return retry(async () => {
    const raw = await readFile(join(profile, "DevToolsActivePort"), "utf8");
    const port = Number.parseInt(raw.split("\n")[0], 10);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error("DevToolsActivePort not written yet");
    }
    return port;
  }, 80);
}

async function connectToPage(port) {
  const target = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list = await response.json();
    const found = list.find((entry) => entry.type === "page");
    if (!found) throw new Error("no page target yet");
    return found;
  });

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  let nextId = 1;
  const pending = new Map();

  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id === undefined) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(JSON.stringify(data.error)));
    else entry.resolve(data.result);
  };

  const page = {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },

    close() {
      socket.close();
    },

    async eval(expression) {
      const result = await page.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          `${result.exceptionDetails.exception?.description ?? "evaluate failed"}\n--- expression ---\n${expression}`,
        );
      }
      return result.result?.value;
    },

    /** Viewport, device pixel ratio and colour scheme, set together. */
    async emulate({ width, height, scale = 1, mobile = false, scheme }) {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: scale,
        mobile,
      });
      if (scheme) {
        await page.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: scheme }],
        });
      }
    },

    async navigate(url) {
      // Load events proved unreliable here — a blank-page load could satisfy
      // the wait for the navigation that followed it. Poll the page's own
      // state instead: it is the thing we actually care about.
      //
      // "A page finished loading" is not the same question as "the page I asked
      // for is here". Every page in this app has a <main> and reaches
      // readyState "complete", so whatever was on screen before satisfies both
      // on the first poll, and the wait returns against the *old* document. A
      // front-door run measured /sign-up that way and reported the landing
      // page's links missing; the same hole can just as easily hand back a
      // green assertion about a page nobody navigated to.
      //
      // So mark this document first. Only a new one can clear the mark, which
      // is true for a redirect as well — and redirects are load-bearing here,
      // /keys sends a signed-out visitor to the closed-door screen.
      const mark = Date.now() + Math.random();
      await page.eval(`window.__captureMark = ${mark}`);

      const { frameId } = await page.send("Page.navigate", { url });
      if (!frameId) throw new Error(`navigation to ${url} was refused`);

      await retry(async () => {
        const state = await page.eval(`(() => ({
          stale: window.__captureMark === ${mark},
          href: location.href,
          ready: document.readyState === "complete" && !!document.querySelector("main"),
        }))()`);
        // The marker only survives if this is still the document we set it on,
        // so its absence is what proves the navigation actually committed.
        if (state.stale) {
          throw new Error(`still on ${state.href}, waiting for ${url}`);
        }
        if (!state.ready) throw new Error(`still loading ${url}`);
      }, 80);

      // Turbopack's dev overlay and the web font swap both land after that.
      // A card screenshotted in the fallback font is a card in the wrong font.
      await page.eval(`document.fonts.ready`);
      await sleep(700);
    },

    async screenshot({ clip, beyondViewport = false } = {}) {
      const { data } = await page.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: beyondViewport,
        ...(clip ? { clip: { ...clip, scale: clip.scale ?? 1 } } : {}),
      });
      return Buffer.from(data, "base64");
    },
  };

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  return page;
}

export async function retry(fn, attempts = 40) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await sleep(250);
    }
  }
  throw last;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    out[argv[i].replace(/^--/, "")] = argv[i + 1];
  }
  return out;
}
