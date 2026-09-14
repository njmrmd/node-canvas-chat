import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Deploy probe. Proves a server function actually ran on this deployment, which
 * a static page cannot. Returns build identity only — never environment values,
 * connection strings, or anything user-scoped.
 */
export function GET() {
  return NextResponse.json({
    ok: true,
    service: "node-canvas-chat",
    // Vercel sets these; they are empty on a local `next dev`.
    environment: process.env.VERCEL_TARGET_ENV ?? process.env.VERCEL_ENV ?? "local",
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? "local",
  });
}
