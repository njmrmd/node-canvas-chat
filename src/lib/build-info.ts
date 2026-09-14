/**
 * Which build is this, really.
 *
 * QA signs off a deployment by naming the commit it tested, so `/api/health`
 * has to answer that question truthfully or the sign-off means nothing. It
 * stopped answering on one preview (TES-17) and the cause is worth writing
 * down, because it will happen again:
 *
 * Vercel derives `VERCEL_GIT_COMMIT_SHA` / `VERCEL_GIT_COMMIT_REF` from the
 * *provider-prefixed* deployment metadata the CLI attaches — `githubCommitSha`,
 * `gitlabCommitSha`, `bitbucketCommitSha`. When the CLI cannot work out which
 * provider a checkout belongs to (no remote, a remote it does not recognise, a
 * clone whose origin is a local path), it still attaches the commit, but under
 * the provider-neutral keys `gitCommitSha` / `gitCommitRef` — and nothing maps
 * those onto the system environment variables. The deployment then gets those
 * variables set to the empty string. Not unset: empty. `??` does not fire on
 * `""`, which is how the old code turned a missing commit into `"commit": ""`
 * rather than an obvious fallback.
 *
 * So two rules here:
 *
 *   1. Blank is missing. Every read goes through `present()`.
 *   2. Do not depend on Vercel identifying the repository. `scripts/deploy.sh`
 *      passes the commit it deployed as `BUILD_COMMIT`/`BUILD_BRANCH`, which
 *      works from any checkout, with any remote, or none.
 *
 * Vercel's own variables are still preferred when they are populated: they are
 * per-deployment and cannot be left stale in project settings, which a
 * dashboard-set `BUILD_COMMIT` could be.
 *
 * Nothing here is secret. It is the commit of a public repository, and it is
 * deliberately the only thing this module knows how to report — no environment
 * values, no connection strings, no anything user-scoped.
 */

/** What a field says when no source could answer it on a real deployment. */
export const UNKNOWN = "unknown";

/** What it says off-platform, where there is no deployment to identify. */
export const LOCAL = "local";

/** Trims, and treats the empty string as absent — see the note above. */
function present(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function firstPresent(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    const found = present(value);
    if (found) return found;
  }
  return null;
}

/** Commits are compared by eye, against `git log --oneline`. Seven is enough. */
function short(sha: string): string {
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

export type BuildInfo = {
  /** `production`, `preview`, `development`, or `local` when not on Vercel. */
  environment: string;
  /** Short commit sha, or `unknown` on a deployment that lost its provenance. */
  commit: string;
  /** Branch the deploy was made from, or `unknown`. */
  branch: string;
  /**
   * Present and `true` only when the deploy is known to have been built from a
   * checkout with uncommitted changes — so `commit` names the base it sat on,
   * not the code that is running. Absent means clean or not known; the deploy
   * path is the only thing that can tell the difference, and it says so
   * explicitly when it can.
   */
  dirty?: true;
};

/** `env` is a parameter so the resolution rules are testable without mutating
 * the real environment; nothing but the tests ever passes it. */
export function buildInfo(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BuildInfo {
  const onVercel = present(env.VERCEL) !== null;
  const fallback = onVercel ? UNKNOWN : LOCAL;

  const commit = firstPresent(env.VERCEL_GIT_COMMIT_SHA, env.BUILD_COMMIT);
  const branch = firstPresent(env.VERCEL_GIT_COMMIT_REF, env.BUILD_BRANCH);

  return {
    environment:
      firstPresent(env.VERCEL_TARGET_ENV, env.VERCEL_ENV) ?? LOCAL,
    commit: commit ? short(commit) : fallback,
    branch: branch ?? fallback,
    ...(present(env.BUILD_DIRTY) ? { dirty: true as const } : {}),
  };
}
