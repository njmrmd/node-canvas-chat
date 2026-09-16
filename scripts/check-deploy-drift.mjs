#!/usr/bin/env node
/**
 * Answers one question across three layers: is the product a visitor gets the
 * product that has actually been written?
 *
 *   local     this checkout's HEAD          — work that exists nowhere else
 *   remote    git ls-remote                 — what has been shared
 *   deployed  /api/health over the network  — what a visitor is served
 *
 * A gap at either join is a way for "done" to mean nothing. The check started
 * with only remote↔deployed; QA pointed out that the wider gap in a workspace
 * two runs share is local↔remote, and that three of their last four findings
 * lived there — including a production link card contradicting the page it
 * opened, because the fix sat unpushed five commits deep.
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

/**
 * This checkout's HEAD, or null when there is no usable git context.
 *
 * The third layer. The two the check started with — remote and deployed — miss
 * the gap this repo actually has: work finished in a shared checkout and never
 * pushed. That is invisible to anything anchored on the remote, and QA found
 * three of their last four defects living in it, including a production link
 * card contradicting the page it opened because the fix was sitting unpushed
 * five commits deep.
 *
 * Silent in CI, where the checkout *is* the remote, so this costs nothing
 * there and only speaks where a human or an agent is holding unpushed work.
 */
async function localSha() {
  try {
    const { stdout } = await run("git", ["rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return null;
  }
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

const [remote, health, local] = await Promise.all([
  remoteSha(),
  deployedHealth(),
  localSha(),
]);
const short = remote.slice(0, health.commit?.length ?? 7);
const sameSha = health.commit === short;

/*
 * Unpushed work, classified the same way as drift: only commits that can reach
 * a visitor are a problem. A local branch ahead by a harness commit is normal
 * and says nothing; ahead by a page component means the product has a fix
 * nobody outside this checkout can get.
 */
const localAhead = local && local !== remote ? await changedFiles(remote, local) : [];
const localUnresolvable = localAhead === null;
const localDeployable = (localAhead ?? []).filter(isDeployable);
const unpushedProduct = localDeployable.length > 0;

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
if (local) {
  console.log(
    `local     ${local.slice(0, 7)}   (this checkout${local === remote ? ", pushed" : ", NOT on the remote"})`,
  );
}
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

if (local && local !== remote) {
  if (localUnresolvable) {
    console.log(
      `unpushed  ${local.slice(0, 7)} vs ${remote.slice(0, 7)} — range unresolvable, not classified`,
    );
  } else {
    const skipped = localAhead.length - localDeployable.length;
    console.log(
      `unpushed  ${localAhead.length} file(s) in this checkout only — ` +
        `${localDeployable.length} deployable, ${skipped} not`,
    );
    for (const file of localDeployable.slice(0, 10)) {
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

if (unpushedProduct) {
  console.error(
    "\nUNPUSHED: this checkout holds product changes that are on no remote.\n" +
      "Nobody else can see them and no deploy can pick them up — the commit\n" +
      "exists and the fix does not. Push before treating any of it as done.",
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

if (drifted || untrustworthy || unpushedProduct) process.exit(1);

if (!sameSha) {
  console.log(
    "\nIn sync: the remote is ahead, but only by commits that cannot reach a\n" +
      "visitor. Nothing to deploy.",
  );
} else {
  console.log("\nIn sync: the deployment is serving the commit on the remote.");
}
