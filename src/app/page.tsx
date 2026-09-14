/**
 * Scaffold placeholder. This exists to prove the pipeline is live and to show
 * which commit a given URL is serving — it is not the product surface and it is
 * not the visual direction. Frontend Engineer replaces this with the canvas;
 * Design Engineer owns how any of it looks.
 */

export const dynamic = "force-dynamic";

const build = {
  environment:
    process.env.VERCEL_TARGET_ENV ?? process.env.VERCEL_ENV ?? "local",
  commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
  branch: process.env.VERCEL_GIT_COMMIT_REF ?? "local",
};

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 py-16">
      <main className="w-full max-w-md">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
          Node Canvas Chat
        </p>

        <h1 className="mt-5 text-balance text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          A conversation is a graph, not a list.
        </h1>

        <p className="mt-4 text-pretty leading-relaxed text-muted">
          Bring your own model access and branch a chat across a canvas of
          nodes. Nothing is built yet — this page only confirms the deployment
          pipeline is live.
        </p>

        <dl className="mt-10 divide-y divide-hairline border-y border-hairline text-sm">
          {(
            [
              ["Environment", build.environment],
              ["Branch", build.branch],
              ["Commit", build.commit],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 py-2.5">
              <dt className="text-muted">{label}</dt>
              <dd className="font-mono">{value}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-8 text-sm text-muted">
          <a
            className="underline decoration-hairline underline-offset-4 transition-colors hover:decoration-current"
            href="https://github.com/njmrmd/node-canvas-chat"
          >
            Source on GitHub
          </a>
          <span aria-hidden="true" className="px-2">
            ·
          </span>
          <a
            className="underline decoration-hairline underline-offset-4 transition-colors hover:decoration-current"
            href="/api/health"
          >
            Health check
          </a>
        </p>
      </main>
    </div>
  );
}
