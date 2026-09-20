# Browser tests

Playwright specs that drive a real browser against a real running app. This is
the only browser rig in the project — nothing here reaches outside the repo for
a test runner or for a browser.

## Run it cold

From a fresh clone, three commands:

```bash
pnpm install
pnpm exec playwright install chromium   # once per machine, ~180 MB
pnpm test:e2e
```

`pnpm test:e2e` starts `next dev` on port 3100 itself, waits for
`/api/health` to answer, runs the specs, and shuts the server down. You do not
need a dev server already running, and you do not need any environment
variables — the current specs only touch public pages.

Useful variants:

```bash
pnpm test:e2e --headed              # watch it happen
pnpm test:e2e --debug               # step through with the inspector
pnpm test:e2e e2e/smoke.spec.ts     # one file
pnpm exec playwright show-report    # open the last HTML report
```

## Run it against something already running

Set `E2E_BASE_URL` and Playwright skips its managed server entirely. This is
how to point the suite at a preview deployment or at a dev server you are
already watching:

```bash
E2E_BASE_URL=http://localhost:3000 pnpm test:e2e
E2E_BASE_URL=https://node-canvas-chat-git-my-branch.vercel.app pnpm test:e2e
```

`E2E_PORT` changes the port of the managed server if 3100 is taken.

## Which browser this uses

Chromium — specifically the Chrome for Testing build that ships with the
`@playwright/test` version pinned in `package.json`. `@playwright/test` is
pinned to an exact version with no caret precisely so that every machine and
every CI run resolves the same browser revision.

`playwright.config.ts` sets **no** `channel`. That is deliberate: `channel:
"chrome"` would launch whatever Google Chrome is installed on the host, which
is exactly the unreproducible setup this directory replaced. If a spec needs a
different browser, add a project to `playwright.config.ts` and a matching
`playwright install` line to this README — do not reach for a host browser.

Upgrading Playwright therefore means two steps, in this order:

```bash
pnpm add -D -E @playwright/test@<version>
pnpm exec playwright install chromium
```

The browser lands in Playwright's own cache (`~/.cache/ms-playwright` on Linux,
`~/Library/Caches/ms-playwright` on macOS), not in `node_modules`, so it is
shared across checkouts and survives `rm -rf node_modules`.

## Writing specs

- Put specs in this directory, named `*.spec.ts`.
- Use `baseURL`-relative paths (`page.goto("/sign-up")`), never an absolute
  `http://localhost:…` — that is what makes `E2E_BASE_URL` work.
- Prefer role and label queries over CSS selectors, so a spec fails when the
  page stops being usable rather than when a class name changes.
- Avoid `getByRole("alert")` on its own. Next.js injects an empty
  `[role="alert"]` route announcer into every page, so that query is ambiguous;
  scope it to the element you mean.
- Anything that needs a signed-in account needs `DATABASE_URL` and
  `KEY_VAULT_ENCRYPTION_KEY`. Say so at the top of the spec, and skip rather
  than fail when they are absent.
- Anything that needs a real, billable provider call (a real streamed model
  reply, not just key-format validation) needs its own key passed in — see
  `E2E_ANTHROPIC_API_KEY` in `sign-up-to-first-chat.spec.ts`. Nothing in this
  repo provisions that key for free; skip that assertion rather than fake the
  response when it is absent.
- Sign-up is rate-limited to 5 per hour per IP (`src/lib/rate-limit.ts`,
  `POLICIES.signUp`) — it is an abuse control, not a test seam. A spec that
  signs up more than a couple of accounts, run more than a couple of times in
  the same hour from the same machine or CI runner, will trip it and fail
  with "Too many attempts" — a real product response, not a broken test. Keep
  signups-per-run low and do not add retries around this specifically.
