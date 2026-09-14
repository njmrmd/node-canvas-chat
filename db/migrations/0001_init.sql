-- 0001_init — accounts, sessions, the BYO key vault and rate-limit counters.
--
-- Data minimization: an account is an email, a password verifier and a
-- timestamp. There is no name, no avatar, no analytics column. If the product
-- does not need it to work, it is not here.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
create table if not exists users (
  id              uuid primary key default gen_random_uuid(),
  -- Stored lowercased by the application so the unique index is the real
  -- case-insensitivity guarantee. citext would need an extension we do not
  -- otherwise want.
  email           text        not null unique,
  -- scrypt verifier, encoded as scrypt$N$r$p$<salt b64>$<hash b64>.
  -- Never a reversible form of the password.
  password_hash   text        not null,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Sessions
--
-- Server-side sessions, not JWTs: sign-out and account deletion must actually
-- revoke access, and a stateless token cannot be revoked. Only the SHA-256 of
-- the token is stored, so database read access does not yield a usable cookie.
-- ---------------------------------------------------------------------------
create table if not exists sessions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references users(id) on delete cascade,
  token_hash   bytea       not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);

create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists sessions_expires_at_idx on sessions(expires_at);

-- ---------------------------------------------------------------------------
-- BYO model key vault
--
-- The key itself is AES-256-GCM ciphertext. The encryption key lives only in
-- the server environment (KEY_VAULT_ENCRYPTION_KEY), never in this database,
-- so a dump of this table is inert on its own.
--
-- `last4` is the only plaintext-derived value stored, and it is the only thing
-- ever sent back to a browser.
-- ---------------------------------------------------------------------------
create table if not exists provider_keys (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references users(id) on delete cascade,
  provider    text        not null,
  ciphertext  bytea       not null,
  iv          bytea       not null,
  auth_tag    bytea       not null,
  -- Which server key encrypted this row. Lets a future rotation tell
  -- re-encryptable rows from ones that must be re-entered by the user.
  key_version smallint    not null default 1,
  last4       text        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- One key per provider per account. Re-saving replaces rather than stacks.
  unique (user_id, provider)
);

create index if not exists provider_keys_user_id_idx on provider_keys(user_id);

-- ---------------------------------------------------------------------------
-- Rate limiting
--
-- Fixed windows in Postgres rather than a second managed service. The row is
-- the counter and the window start is part of the key, so a window rolls over
-- by writing a new row instead of needing a sweeper to be correct. Reads tell
-- the caller exactly when their window resets, which is what makes the limit
-- legible in the UI instead of a silent failure.
--
-- `subject` is a namespaced identity: "user:<uuid>" or "ip:<addr>".
-- ---------------------------------------------------------------------------
create table if not exists rate_limits (
  bucket       text        not null,
  subject      text        not null,
  window_start timestamptz not null,
  count        integer     not null default 0,
  primary key (bucket, subject, window_start)
);

-- Expired windows are garbage; this index makes the sweep cheap.
create index if not exists rate_limits_window_start_idx on rate_limits(window_start);
