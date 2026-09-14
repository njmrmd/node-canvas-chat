# Node Canvas Chat

A conversation is a graph, not a list.

Node Canvas Chat is an open-source web app where you connect **your own model
access** — an API key you already hold — and talk to it on a pannable canvas of
nodes instead of a single scrolling thread. Branch a reply into three
directions, keep all three, and see the shape of the conversation.

It is responsive, requires a sign-up, and is rate limited per account.

> **Status: early.** The pipeline, sign-up/sign-in, the encrypted key vault,
> server-side provider routing and rate limiting are built. The node canvas is
> not. Set `DATABASE_URL` and `KEY_VAULT_ENCRYPTION_KEY` before the signed-in
> routes will work — without them they fail closed with a `not_configured`
> error rather than degrading.

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
| Database | Postgres (`pg`)                            |
| Auth     | Email + password, server-side sessions     |
| Provider | Official `@anthropic-ai/sdk`, server-side only |
| Canvas   | React Flow / `@xyflow/react` (planned)     |

The reasoning, the rejected alternatives and every free-tier ceiling are written
up in the `stack` document on TES-3.

## Run it locally

Requires Node 22+ and pnpm 9.

```bash
pnpm install
pnpm dev            # http://localhost:3000
```

The public pages run with an empty env. Signing up, storing a key and chatting
need `DATABASE_URL` and `KEY_VAULT_ENCRYPTION_KEY` — see **Database setup**
below. Copy `.env.example` to `.env.local`; `.gitignore` blocks every `.env*`
file except the example itself.

## Checks

```bash
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint
pnpm test           # node:test — vault, password verifier, CSRF check
pnpm build          # next build
```

All four run in GitHub Actions on every push and pull request
(`.github/workflows/ci.yml`). The tests need no database.

## How a key is protected

The single highest-trust thing this app does is hold someone else's API key.
The design is deliberately boring:

| Question | Answer |
| --- | --- |
| Where does the key live? | `provider_keys.ciphertext` in our Postgres. Nowhere else — not in a cookie, not in `localStorage`, not in a log. |
| What encrypts it? | AES-256-GCM under `KEY_VAULT_ENCRYPTION_KEY`, a 32-byte key that exists only in the server environment. |
| Who can read it? | Only `getDecryptedKey`, inside a request that has already proved the session owns the row. It has exactly one caller: the chat route. |
| What does a database dump give an attacker? | Ciphertext, a random IV, a GCM tag, and the last four characters. The encryption key is not in the database, so the dump is inert on its own. |
| Can a preview deployment read production keys? | No, provided Preview and Production hold different `KEY_VAULT_ENCRYPTION_KEY` values. Set them separately. |
| Can a row be moved between accounts? | No. Each ciphertext is bound to `<userId>:<provider>` as AES-GCM additional authenticated data, so a relocated row fails its tag check. |

Passwords are scrypt verifiers (`N=32768, r=8, p=1`), never reversible. Session
cookies are 32 random bytes stored only as their SHA-256, so database read
access does not yield a usable cookie either.

## Database setup

Any Postgres works; the app uses `pg` and no provider-specific features.

```bash
# 1. Point at a database. Migrations use the direct (non-pooled) URL.
cp .env.example .env.local   # fill DATABASE_URL and DATABASE_URL_UNPOOLED

# 2. Generate the vault key (32 bytes, base64) into KEY_VAULT_ENCRYPTION_KEY.
openssl rand -base64 32

# 3. Create the schema.
pnpm db:migrate
```

`pnpm db:migrate` is idempotent — it records what it applied in
`schema_migrations` and re-running it is a no-op.

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

### Environment variables on Vercel

Set the variables from `.env.example` in **Vercel → Project → Settings →
Environment Variables**, never in a committed file. Give Preview and Production
separate values — `KEY_VAULT_ENCRYPTION_KEY` especially, so a preview
deployment can never decrypt a production key.

```bash
# From a linked checkout, per target:
pnpm dlx vercel@latest env add KEY_VAULT_ENCRYPTION_KEY production
pnpm dlx vercel@latest env add DATABASE_URL production
```

After the variables land, run `pnpm db:migrate` once against that database
(using `DATABASE_URL_UNPOOLED`) and redeploy so the functions pick up the new
environment.

## Contributing

Conventional, small commits. CI must be green. If a change touches auth, key
storage, or the provider route, say in the PR description where the key lives,
what encrypts it, and what an attacker with database read access would get.

## Licence

[MIT](LICENSE).
