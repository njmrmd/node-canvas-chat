#!/usr/bin/env node
/**
 * Answers one question: is the commit on the remote branch the commit the
 * deployment is serving?
 *
 *   node scripts/check-deploy-drift.mjs                    # production vs origin/main
 *   node scripts/check-deploy-drift.mjs --base https://... --ref refs/heads/main
 *
 * Exits non-zero on drift, so it can gate a hand-off.
 *
 * Why this exists: "done" has meant *committed* three times on this project and
 * been read as *live* three times — TES-13 and TES-9 were the same landing-page
 * bug closed twice, and TES-29 was closed while the fix sat two commits behind
 * production. Every one of those was caught by a person noticing, which is not
 * a control.
 *
 * Two deliberate choices about where the numbers come from:
 *
 * - The remote SHA comes from `git ls-remote`, which asks the host. Do not
 *   substitute `git log origin/main` or `git branch -r`: those read `.git`'s
 *   remote-tracking cache, which is as old as your last fetch. On the one
 *   question this script exists to answer, a stale cache gives a confident
 *   wrong answer.
 * - The deployed SHA comes from `/api/health` over the network, not from the
 *   repo. Rendering the checkout tells you what `HEAD` does, which was never
 *   the question.
 *
 * It compares a prefix, because `/api/health` reports a short SHA.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "https://node-canvas-chat.vercel.app").replace(
  /\/$/,
  "",
);
const REF = args.ref ?? "refs/heads/main";

/** The host's answer, not the local cache's. */
async function remoteSha() {
  const { stdout } = await run("git", ["ls-remote", "origin", REF]);
  const sha = stdout.split(/\s+/)[0];
  if (!sha) throw new Error(`no such ref on origin: ${REF}`);
  return sha;
}

/** The deployment's own answer, over the network. */
async function deployed() {
  const response = await fetch(`${BASE}/api/health`);
  if (!response.ok) {
    throw new Error(`${BASE}/api/health returned ${response.status}`);
  }
  return response.json();
}

const [remote, health] = await Promise.all([remoteSha(), deployed()]);
const short = remote.slice(0, health.commit?.length ?? 7);
const drifted = health.commit !== short;

console.log(`ref       ${REF}`);
console.log(`remote    ${remote.slice(0, 7)}   (git ls-remote)`);
console.log(
  `deployed  ${health.commit}   (${BASE}/api/health, ${health.environment})`,
);
if (health.dirty) {
  console.log(
    "\nThe deployment reports dirty: it was built from a working tree with\n" +
      "uncommitted changes, so its commit does not fully describe it.",
  );
}

if (drifted) {
  console.error(
    `\nDRIFT: ${BASE} is not serving ${REF}.\n` +
      "Whatever was merged is not what anyone is using. Deploy with\n" +
      "  scripts/deploy.sh --prod      (from a clean checkout)",
  );
  process.exit(1);
}

console.log("\nIn sync: the deployment is serving the commit on the remote.");
