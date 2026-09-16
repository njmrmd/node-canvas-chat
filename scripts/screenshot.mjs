#!/usr/bin/env node
/**
 * Renders the pre-canvas screens in a real browser and writes a PNG per state,
 * at both review viewports, in both colour schemes.
 *
 * Why this exists: a design pass that is signed off from a description is not
 * signed off. This drives the actual routes in actual Chrome, reaches the
 * error, waiting and success states through the app's own code paths, and
 * leaves evidence someone else can look at.
 *
 * Why it has no dependencies: the system Chrome already speaks the DevTools
 * protocol over a websocket, and Node has had a websocket client since 22.
 * Adding Playwright would mean a ~400MB browser download and a new entry in
 * the dependency tree for something that is not part of the product.
 *
 * Usage:
 *   node scripts/screenshot.mjs --base http://127.0.0.1:3000 --out ./shots
 *
 * The `/dev/screens` routes it uses only exist under `next dev`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = parseArgs(process.argv.slice(2));
const BASE = args.base ?? "http://127.0.0.1:3000";
const OUT = args.out ?? "./shots";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

const SCHEMES = ["light", "dark"];

/**
 * Each state names the route to open, an optional set of stubbed API
 * responses, and the steps to take once the page is up.
 *
 * Stubs exist because the database is not wired yet and because a real 429 is
 * not something you can ask for politely. They are applied at the network
 * layer, so the component under test takes the same path it takes in
 * production — `apiFetch` parses a real response and the component renders
 * from its own state.
 */
const STATES = [
  {
    name: "01-sign-up-default",
    path: "/sign-up",
  },
  {
    name: "02-sign-up-field-errors",
    path: "/sign-up",
    steps: [
      { type: "fill", selector: "#email", value: "not-an-email" },
      { type: "fill", selector: "#password", value: "abc" },
      { type: "click", selector: 'button[type="submit"]' },
    ],
  },
  {
    name: "03-sign-up-server-error",
    path: "/sign-up",
    stub: {
      "/api/auth/signup": {
        status: 409,
        body: {
          error: {
            code: "email_taken",
            message:
              "An account already exists for that email address. Sign in instead.",
          },
        },
      },
    },
    steps: [
      { type: "fill", selector: "#email", value: "taken@example.com" },
      { type: "fill", selector: "#password", value: "a-long-enough-password" },
      { type: "click", selector: 'button[type="submit"]' },
    ],
  },
  {
    name: "04-sign-up-rate-limited",
    path: "/sign-up",
    stub: {
      "/api/auth/signup": {
        status: 429,
        headers: { "Retry-After": "1847" },
        body: {
          error: {
            code: "rate_limited",
            message:
              "You have reached the limit of 5 for this action. Try again in 31 minutes.",
          },
        },
      },
    },
    steps: [
      { type: "fill", selector: "#email", value: "someone@example.com" },
      { type: "fill", selector: "#password", value: "a-long-enough-password" },
      { type: "click", selector: 'button[type="submit"]' },
    ],
  },
  {
    name: "05-sign-in-invalid-credentials",
    path: "/sign-in",
    stub: {
      "/api/auth/signin": {
        status: 401,
        body: {
          error: {
            code: "invalid_credentials",
            message: "That email and password do not match.",
          },
        },
      },
    },
    steps: [
      { type: "fill", selector: "#email", value: "someone@example.com" },
      { type: "fill", selector: "#password", value: "a-long-enough-password" },
      { type: "click", selector: 'button[type="submit"]' },
    ],
  },
  {
    name: "06-keys-empty",
    path: "/dev/screens?screen=keys",
  },
  {
    name: "07-keys-verifying",
    path: "/dev/screens?screen=keys",
    // Deliberately never fulfilled: the request hangs, which is exactly the
    // state a user sits in while we call the provider.
    hang: ["/api/keys/anthropic"],
    steps: [
      { type: "fill", selector: "#key-anthropic", value: "sk-ant-api03-xxxx" },
      { type: "click", selector: 'button[type="submit"]' },
      { type: "wait", ms: 400 },
    ],
  },
  {
    name: "08-keys-invalid-key",
    path: "/dev/screens?screen=keys",
    stub: {
      "/api/keys/anthropic": {
        status: 400,
        body: {
          error: {
            code: "invalid_api_key",
            message:
              "Anthropic rejected that key. Check you copied all of it, and that it is still active in the console.",
          },
        },
      },
    },
    steps: [
      { type: "fill", selector: "#key-anthropic", value: "sk-ant-api03-xxxx" },
      { type: "click", selector: 'button[type="submit"]' },
    ],
  },
  {
    name: "09-keys-connected-success",
    path: "/dev/screens?screen=keys",
    stub: {
      "/api/keys/anthropic": {
        status: 200,
        body: {
          key: {
            provider: "anthropic",
            last4: "9f2c",
            createdAt: "2026-09-14T12:00:00.000Z",
            updatedAt: "2026-09-14T12:00:00.000Z",
          },
        },
      },
    },
    steps: [
      { type: "fill", selector: "#key-anthropic", value: "sk-ant-api03-xxxx" },
      { type: "click", selector: 'button[type="submit"]' },
    ],
  },
  {
    // D4/C7: the rescue path is a disclosure, so the open state is the one
    // that has to be reviewed — closed it is a single line of summary text.
    name: "09b-keys-rescue-path-open",
    path: "/dev/screens?screen=keys",
    steps: [{ type: "click", selector: "details summary" }],
  },
  {
    name: "10-keys-connected-resting",
    path: "/dev/screens?screen=keys-connected",
  },
  {
    name: "11-keys-delete-account-confirm",
    path: "/dev/screens?screen=keys-connected",
    steps: [{ type: "clickText", text: "Delete account" }],
  },
  {
    name: "12-keys-disconnect-confirm",
    path: "/dev/screens?screen=keys-connected",
    steps: [{ type: "clickText", text: "Disconnect this key" }],
  },
];

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  await mkdir(OUT, { recursive: true });

  const profile = await mkdtemp(join(tmpdir(), "ncc-shots-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=9333",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "about:blank",
  ]);
  chrome.stderr.on("data", () => {});

  try {
    const page = await connectToPage();
    let count = 0;

    for (const state of STATES) {
      for (const viewport of VIEWPORTS) {
        for (const scheme of SCHEMES) {
          const file = `${state.name}-${viewport.name}-${scheme}.png`;
          await capture(page, state, viewport, scheme, join(OUT, file));
          count += 1;
          console.log(`  ${file}`);
        }
      }
    }

    console.log(`\n${count} screenshots in ${OUT}`);
    page.close();
  } finally {
    chrome.kill();
    await rm(profile, { recursive: true, force: true });
  }
}

async function capture(page, state, viewport, scheme, file) {
  // Reset between shots: a page carrying the previous state's stubs or
  // component state produces a screenshot that is quietly a lie.
  await page.send("Fetch.disable");

  await page.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 2,
    mobile: viewport.mobile,
  });

  await page.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: scheme }],
  });

  const stub = state.stub ?? {};
  const hang = state.hang ?? [];

  if (Object.keys(stub).length > 0 || hang.length > 0) {
    await page.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });

    page.on("Fetch.requestPaused", async (event) => {
      const path = new URL(event.request.url).pathname;

      if (hang.includes(path)) return; // never answered, on purpose

      const match = stub[path];
      if (!match) {
        await page.send("Fetch.continueRequest", { requestId: event.requestId });
        return;
      }

      await page.send("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: match.status,
        responseHeaders: Object.entries({
          "Content-Type": "application/json",
          ...(match.headers ?? {}),
        }).map(([name, value]) => ({ name, value: String(value) })),
        body: Buffer.from(JSON.stringify(match.body)).toString("base64"),
      });
    });
  }

  await page.navigate(`${BASE}${state.path}`);

  for (const step of state.steps ?? []) {
    await runStep(page, step);
  }

  // Let React commit, and let any focus ring from a click settle.
  await page.eval(`document.activeElement && document.activeElement.blur()`);
  await sleep(250);

  const { data } = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });

  await writeFile(file, Buffer.from(data, "base64"));
  page.off("Fetch.requestPaused");
}

/**
 * Polls until the node is in the document *and* React owns it.
 *
 * Being in the DOM is not enough. The markup arrives server-rendered, so a
 * step that runs before hydration types into an input React is not listening
 * to and clicks a button with no handler attached — and hydration then wipes
 * the value back to component state. That failure is silent: you get a
 * screenshot of the default state with a filename claiming it is an error
 * state. React tags every hydrated node with a `__reactFiber$…` key, so that
 * is the signal to wait for.
 */
async function waitForSelector(page, selector) {
  await retry(async () => {
    const ready = await page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      return Object.keys(el).some((key) => key.startsWith("__reactFiber$"));
    })()`);
    if (!ready) throw new Error(`no hydrated element for ${selector}`);
  }, 80);
}

async function waitForText(page, text) {
  await retry(async () => {
    const ready = await page.eval(`(() => {
      const wanted = ${JSON.stringify(text)};
      const el = [...document.querySelectorAll("button, a")].find(
        (node) => node.textContent.trim() === wanted
      );
      if (!el) return false;
      return Object.keys(el).some((key) => key.startsWith("__reactFiber$"));
    })()`);
    if (!ready) throw new Error(`no hydrated control labelled ${text}`);
  }, 80);
}

async function runStep(page, step) {
  if (step.type === "wait") {
    await sleep(step.ms);
    return;
  }

  if (step.type === "fill" || step.type === "click") {
    await waitForSelector(page, step.selector);
  }

  if (step.type === "clickText") {
    await waitForText(page, step.text);
  }

  if (step.type === "fill") {
    // React tracks the input's value on the DOM node, so assigning `.value`
    // directly is swallowed. Go through the prototype setter and dispatch the
    // event React actually listens for.
    await page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(step.selector)});
      if (!el) throw new Error("no element for " + ${JSON.stringify(step.selector)});
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value"
      ).set;
      setter.call(el, ${JSON.stringify(step.value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await sleep(60);
    return;
  }

  if (step.type === "click") {
    await page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(step.selector)});
      if (!el) throw new Error("no element for " + ${JSON.stringify(step.selector)});
      el.click();
    })()`);
    await sleep(300);
    return;
  }

  if (step.type === "clickText") {
    await page.eval(`(() => {
      const wanted = ${JSON.stringify(step.text)};
      const el = [...document.querySelectorAll("button, a")].find(
        (node) => node.textContent.trim() === wanted
      );
      if (!el) throw new Error("no control labelled " + wanted);
      el.click();
    })()`);
    await sleep(300);
    return;
  }

  throw new Error(`unknown step ${step.type}`);
}

/* ------------------------------------------------------------------ */
/* A very small DevTools protocol client.                              */
/* ------------------------------------------------------------------ */

async function connectToPage() {
  const targets = await retry(async () => {
    const response = await fetch("http://127.0.0.1:9333/json/list");
    const list = await response.json();
    const page = list.find((entry) => entry.type === "page");
    if (!page) throw new Error("no page target yet");
    return page;
  });

  const socket = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);

    if (data.id !== undefined) {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.error) entry.reject(new Error(JSON.stringify(data.error)));
      else entry.resolve(data.result);
      return;
    }

    const handler = listeners.get(data.method);
    if (handler) handler(data.params);
  };

  const page = {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, handler) {
      listeners.set(method, handler);
    },
    off(method) {
      listeners.delete(method);
    },
    close() {
      socket.close();
    },
    async eval(expression) {
      const result = await page.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          `${result.exceptionDetails.exception?.description ?? "evaluate failed"}\n--- expression ---\n${expression}`,
        );
      }
      return result.result?.value;
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

      // Turbopack's dev overlay and the font swap both land after that.
      await sleep(700);
    },
  };

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  return page;
}

async function retry(fn, attempts = 40) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    out[argv[i].replace(/^--/, "")] = argv[i + 1];
  }
  return out;
}
