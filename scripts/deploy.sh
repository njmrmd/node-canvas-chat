#!/usr/bin/env bash
#
# Deploy to Vercel with build provenance attached, then prove it arrived.
#
#   scripts/deploy.sh            # preview
#   scripts/deploy.sh --prod     # production
#
# Why this exists instead of plain `vercel deploy`:
#
# The CLI attaches the commit it is deploying as deployment metadata, but it
# only uses the keys Vercel maps onto VERCEL_GIT_COMMIT_SHA / _REF
# (`githubCommitSha`, `githubCommitRef`, …) when it recognises the checkout's
# remote as a supported provider. Deploy from a clone whose origin is a local
# path, a worktree, or a checkout with no remote, and it falls back to the
# provider-neutral `gitCommitSha` keys — which map to nothing. The deployment
# comes up with those variables set to the empty string and `/api/health`
# cannot say which commit it is running. That is TES-17, and it cost QA a
# sign-off.
#
# So this script does not ask Vercel to work it out. It reads the commit from
# the checkout it is standing in and passes it explicitly:
#
#   --env    BUILD_COMMIT/BUILD_BRANCH/BUILD_DIRTY  what the app reports
#   --meta   githubCommit*                          what the dashboard shows
#
# Nothing passed here is a secret — it is the commit of a public repo. Real
# secrets (DATABASE_URL, KEY_VAULT_ENCRYPTION_KEY) live in the project's
# environment variables and are never passed on a command line.
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

target=preview
if [[ ${1:-} == "--prod" ]]; then
  target=production
  shift
fi

commit=$(git rev-parse --short=7 HEAD)
branch=$(git rev-parse --abbrev-ref HEAD)

# A deploy from a dirty checkout is not the commit it claims to be — it is that
# commit plus whatever is uncommitted. Say so rather than let a sign-off name a
# commit that does not contain the code under test.
dirty=""
if [[ -n $(git status --porcelain) ]]; then
  dirty=1
  echo "warning: deploying from a checkout with uncommitted changes" >&2
  echo "         /api/health will report \"dirty\": true" >&2
fi

args=(deploy --yes)
if [[ $target == production ]]; then
  args+=(--prod)
fi

args+=(--env "BUILD_COMMIT=$commit" --env "BUILD_BRANCH=$branch")
if [[ -n $dirty ]]; then
  args+=(--env "BUILD_DIRTY=1")
fi

# Best effort parity for the Vercel dashboard's own commit column. Only claimed
# when the origin really is the GitHub repo — a guess here would be a lie in a
# place people trust.
origin=$(git config --get remote.origin.url || true)
if [[ $origin =~ ^(https://github\.com/|git@github\.com:)([^/]+)/(.+)$ ]]; then
  args+=(
    --meta "githubCommitSha=$(git rev-parse HEAD)"
    --meta "githubCommitRef=$branch"
    --meta "githubCommitOrg=${BASH_REMATCH[2]}"
    --meta "githubCommitRepo=${BASH_REMATCH[3]%.git}"
  )
fi

echo "Deploying ${commit} (${branch}) to ${target}..." >&2
output=$(vercel "${args[@]}" "$@")

# The CLI prints a bare URL to a terminal, but a JSON envelope when it detects
# it is being run by an agent. Read both rather than assume which one is in
# front of us.
url=$(node -e '
  const raw = require("node:fs").readFileSync(0, "utf8").trim();
  let url = null;
  try {
    url = JSON.parse(raw)?.deployment?.url ?? null;
  } catch {
    url = raw.split("\n").reverse().find((line) => line.trim().startsWith("http"))?.trim() ?? null;
  }
  if (!url) {
    console.error("error: no deployment URL in the CLI output");
    process.exit(1);
  }
  process.stdout.write(url.startsWith("http") ? url : `https://${url}`);
' <<<"$output")

echo "$url"

# The deploy is not done until the deployment can name itself. A green build
# that reports an empty commit is the exact failure this script exists to stop,
# so it fails here rather than at the next sign-off.
echo "Verifying provenance at ${url}/api/health..." >&2
health=$(curl -fsS --retry 3 --retry-delay 2 "${url}/api/health")
echo "$health" >&2

if [[ $health != *"\"commit\":\"$commit\""* ]]; then
  echo "error: ${url} does not report commit ${commit}" >&2
  exit 1
fi
echo "OK: ${url} reports ${commit}" >&2
