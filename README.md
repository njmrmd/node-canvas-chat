# Node Canvas Chat

A conversation is a graph, not a list.

Node Canvas Chat is an open-source web app where you connect **your own model
access** — an API key you already hold — and talk to it on a pannable canvas of
nodes instead of a single scrolling thread. Branch a reply into three
directions, keep all three, and see the shape of the conversation.

It is responsive, requires a sign-up, and is rate limited per account.

> **Status: scaffold.** The pipeline is live and deploys on every push. The
> canvas, auth, and key vault are not built yet.

## Why bring your own key

There is no billing and no business model here. You supply model access, so the
project never resells inference and never needs your payment details.

That makes key handling the highest-trust thing this app does, so it is designed
around a short list of rules that are not negotiable:

- Your key is **encrypted at rest** (AES-256-GCM) with a server-held key and is
  never returned to the browser after you save it. The UI shows a masked suffix.
- **Every provider call originates from the server.** A key that reaches the
  browser is a leaked key.
- Keys, tokens, prompt bodies and PII never enter logs or error reports.
- Deleting your account deletes your key.

## Stack

| Layer    | Choice                                     |
| -------- | ------------------------------------------ |
| Framework| Next.js 16 (App Router) + React 19, TypeScript |
| Styling  | Tailwind CSS v4                            |
| Hosting  | Vercel                                     |
| Database | Neon Postgres (planned)                    |
| Auth     | Auth.js v5, OAuth providers (planned)      |
| Canvas   | React Flow / `@xyflow/react` (planned)     |

The reasoning, the rejected alternatives and every free-tier ceiling are written
up in the `stack` document on TES-3.

## Run it locally

Requires Node 22+ and pnpm 9.

```bash
pnpm install
pnpm dev            # http://localhost:3000
```

The scaffold needs **no environment variables** — it runs with an empty env.
`.env.example` documents the slots that auth and the key vault will fill. Copy it
to `.env.local` when you get there; `.gitignore` blocks every `.env*` file except
the example itself.

## Checks

```bash
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint
pnpm build          # next build
```

All three run in GitHub Actions on every push and pull request
(`.github/workflows/ci.yml`).

## Deploy it yourself

Nothing here needs a paid plan. Vercel Hobby, GitHub Free and Neon Free are
enough.

1. Fork or clone this repo and push it to your own GitHub account.
2. At [vercel.com/new](https://vercel.com/new), import the repo. Vercel detects
   Next.js; accept every default. The build command is `pnpm build`.
3. Deploy. Production builds from `main`; every other branch and every pull
   request gets its own preview URL automatically — no extra configuration.
4. Confirm it worked:

   ```bash
   curl https://<your-deployment>/api/health
   # {"ok":true,"service":"node-canvas-chat","environment":"production",...}
   ```

   `/api/health` runs as a server function, so a 200 from it proves more than
   the page loading does.

To redeploy from the command line instead:

```bash
pnpm dlx vercel@latest link      # once, per checkout
pnpm dlx vercel@latest --prod
```

### When the app grows past the scaffold

Auth and the key vault will require the variables in `.env.example`. Set them in
**Vercel → Project → Settings → Environment Variables**, not in a committed
file, and give Preview and Production separate values —
`KEY_VAULT_ENCRYPTION_KEY` especially, so a preview deployment can never decrypt
a production key.

## Contributing

Conventional, small commits. CI must be green. If a change touches auth, key
storage, or the provider route, say in the PR description where the key lives,
what encrypts it, and what an attacker with database read access would get.

## Licence

[MIT](LICENSE).
