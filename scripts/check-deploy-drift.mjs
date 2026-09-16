#!/usr/bin/env node
/**
 * Answers one question: is the *product* the deployment serves the product that
 * was merged?
 *
 *   node scripts/check-deploy-drift.mjs                    # production vs origin/main
 *   node scripts/check-deploy-drift.mjs --base https://... --ref refs/heads/main
 *   node scripts/check-deploy-drift.mjs --strict           # any SHA difference is drift
 *
 * Exits non-zero on drift or on an untrustworthy build, so it can gate a
 * hand-off.
 *
 * Why this exists: "done" has meant *committed* three times on this project and
 * been read as *live* three times — TES-13 and TES-9 were the same landing-page
 * bug closed twice, and TES-29 was closed while the fix sat two commits behind
 * production. Every one of those was caught by a person noticing, which is not
 * a control.
 *
 * Three deliberate choices about what it compares:
 *
 * - The remote SHA comes from `git ls-remote`, which asks the host. Do not
 *   substitute `git log origin/main` or `git branch -r`: those read `.git`'s
 *   remote-tracking cache, which is as old as your last fetch. On the one
 *   question this script exists to answer, a stale cache gives a confident
 *   wrong answer.
 * - The deployed SHA comes from `/api/health` over the network, not from the
 *   repo. Rendering the checkout tells you what `HEAD` does, which was never
 *   the question.
 * - **Drift means a deployable file differs, not that the SHAs differ.** The
 *   first version compared SHAs, so a commit touching only `scripts/` turned it
 *   red — and a gate that cries wolf is one people learn to clear reflexively
 *   or ignore. Ignoring red is exactly how TES-13 and TES-9 recurred, so a
 *   check that manufactures red is not a neutral inconvenience; it is the
 *   failure mode. (QA raised this on TES-4.)
 *
 * `--strict` restores plain SHA comparison for the case where you want the
 * deployment to match the remote exactly, provenance and all.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

function parseArgs(argv) {
  const args = { _flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args._flags.add(name);
    else args[name] = next;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? "https://node-canvas-chat.vercel.app").replace(
  /\/$/,
  "",
);
const REF = args.ref ?? "refs/heads/main";
const STRICT = args._flags.has("strict");

/**
 * Paths that cannot change what a visitor is served.
 *
 * A deny-list rather than an allow-list, on purpose: anything unrecognised
 * counts as deployable, so a new directory is treated as shipping code until
 * someone deliberately says otherwise. The failure that matters is a real
 * change called safe, not a safe change called real.
 */
const NON_DEPLOYABLE = [
  /^scripts\//,
  /^\.github\//,
  /^docs?\//,
  /^\.vscode\//,
  /\.md$/,
  /^\.gitignore$/,
];

const isDeployable = (path) => !NON_DEPLOYABLE.some((rule) => rule.test(path));

/** The host's answer, not the local cache's. */
async function remoteSha() {
  const { stdout } = await run("git", ["ls-remote", "origin", REF]);
  const sha = stdout.split(/\s+/)[0];
  if (!sha) throw new Error(`no such ref on origin: ${REF}`);
  return sha;
}

/** The deployment's own answer, over the network. */
async function deployedHealth() {
  const response = await fetch(`${BASE}/api/health`);
  if (!response.ok) {
    throw new Error(`${BASE}/api/health returned ${response.status}`);
  }
  return response.json();
}

/** Files changed between two commits, or null when the range is unresolvable. */
async function changedFiles(from, to) {
  try {
    // The deployed commit may predate this clone's fetch, so make sure both
    // ends of the range exist locally before asking for the diff.
    await run("git", ["fetch", "--quiet", "origin", REF]);
    await run("git", ["cat-file", "-e", `${from}^{commit}`]);
    const { stdout } = await run("git", ["diff", "--name-only", `${from}`, `${to}`]);
    return stdout.split("\n").filter(Boolean);
  } catch {
    // A shallow clone, a force-push, or a commit that never reached this
    // remote. Fall back to the SHA comparison and say so rather than guessing.
    return null;
  }
}

const [remote, health] = await Promise.all([remoteSha(), deployedHealth()]);
const short = remote.slice(0, health.commit?.length ?? 7);
const sameSha = health.commit === short;

/*
 * A dirty deploy carries the right commit and the wrong code, so no SHA or
 * path comparison can see it. That is the one way this check could otherwise
 * be green while the deployment is not the thing that was merged.
 */
const untrustworthy = health.dirty === true;

const changed = sameSha || STRICT ? [] : await changedFiles(health.commit, remote);
const unresolvable = changed === null;
const deployableChanges = (changed ?? []).filter(isDeployable);
const drifted = STRICT || unresolvable ? !sameSha : deployableChanges.length > 0;

console.log(`ref       ${REF}`);
console.log(`remote    ${remote.slice(0, 7)}   (git ls-remote)`);
console.log(
  `deployed  ${health.commit}   (${BASE}/api/health, ${health.environment})`,
);
// Printed in the header, always. When a deployment was both drifted and dirty
// the old version reported only the drift, so you redeployed and *then* met the
// second problem. Both facts are known here; both get said here.
console.log(`build     ${untrustworthy ? "DIRTY — built from uncommitted changes" : "clean"}`);

if (!sameSha && !STRICT) {
  if (unresolvable) {
    console.log(
      `ahead     ${remote.slice(0, 7)} is not resolvable locally — falling back to SHA comparison`,
    );
  } else {
    const skipped = (changed ?? []).length - deployableChanges.length;
    console.log(
      `ahead     ${changed.length} file(s) between deployed and remote — ` +
        `${deployableChanges.length} deployable, ${skipped} not`,
    );
    for (const file of deployableChanges.slice(0, 10)) {
      console.log(`            ${file}`);
    }
  }
}

if (drifted) {
  console.error(
    `\nDRIFT: ${BASE} is not serving the product on ${REF}.\n` +
      "Whatever was merged is not what anyone is using. Deploy with\n" +
      "  scripts/deploy.sh --prod      (from a clean checkout)",
  );
}

if (untrustworthy) {
  console.error(
    "\nDIRTY: the deployment was built from a working tree with uncommitted\n" +
      "changes, so its commit does not describe the code that is running and a\n" +
      "sign-off naming that commit would be naming the wrong thing. Redeploy with\n" +
      "  scripts/deploy.sh --prod      (from a clean checkout)",
  );
}

if (drifted || untrustworthy) process.exit(1);

if (!sameSha) {
  console.log(
    "\nIn sync: the remote is ahead, but only by commits that cannot reach a\n" +
      "visitor. Nothing to deploy.",
  );
} else {
  console.log("\nIn sync: the deployment is serving the commit on the remote.");
}
