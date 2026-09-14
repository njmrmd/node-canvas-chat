#!/usr/bin/env node
/**
 * Migration runner. Applies every db/migrations/*.sql exactly once, in
 * filename order, each inside a transaction, recording what it applied.
 *
 * Deliberately ~80 lines of `pg` rather than a migration framework: the
 * supply-chain lens says a dependency has to earn its place, and the only
 * feature we need beyond "run these files once" is a ledger table.
 *
 *   pnpm db:migrate
 *
 * Uses DATABASE_URL_UNPOOLED when set. Neon's pooled (pgbouncer) endpoint does
 * not support every DDL statement reliably, so schema changes go direct.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "db", "migrations");

// Load .env.local for local runs. Vercel and CI inject the real environment.
async function loadDotEnv() {
  if (process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED) return;
  try {
    const raw = await readFile(path.join(root, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const value = match[2].replace(/^["']|["']$/g, "");
      if (value && !process.env[match[1]]) process.env[match[1]] = value;
    }
  } catch {
    // No .env.local is fine.
  }
}

await loadDotEnv();

const connectionString =
  process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "DATABASE_URL_UNPOOLED (or DATABASE_URL) is not set. See .env.example.",
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
  await client.query(`
    create table if not exists schema_migrations (
      name        text primary key,
      applied_at  timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await client.query("select name from schema_migrations")).rows.map(
      (row) => row.name,
    ),
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;

  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await readFile(path.join(dir, name), "utf8");
    process.stdout.write(`applying ${name}… `);
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [
        name,
      ]);
      await client.query("commit");
      console.log("ok");
      ran += 1;
    } catch (error) {
      await client.query("rollback");
      console.log("failed");
      throw error;
    }
  }

  console.log(
    ran === 0 ? "Already up to date." : `Applied ${ran} migration(s).`,
  );
} finally {
  await client.end();
}
