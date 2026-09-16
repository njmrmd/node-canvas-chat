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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Runs `fn` against a headless page, then cleans up the browser and its
 * throwaway profile whether `fn` threw or not.
 */
export async function withPage(fn, { port = 9334 } = {}) {
  const profile = await mkdtemp(join(tmpdir(), "ncc-cdp-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
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
    const page = await connectToPage(port);
    try {
      return await fn(page);
    } finally {
      page.close();
    }
  } finally {
    chrome.kill();
    await rm(profile, { recursive: true, force: true });
  }
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
      const { frameId } = await page.send("Page.navigate", { url });
      if (!frameId) throw new Error(`navigation to ${url} was refused`);

      await retry(async () => {
        const ready = await page.eval(
          `document.readyState === "complete" && !!document.querySelector("main")`,
        );
        if (!ready) throw new Error(`still loading ${url}`);
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
