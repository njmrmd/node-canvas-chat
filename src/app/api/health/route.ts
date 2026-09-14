import { NextResponse } from "next/server";
import { buildInfo } from "@/lib/build-info";

export const dynamic = "force-dynamic";

/**
 * Deploy probe. Proves a server function actually ran on this deployment, which
 * a static page cannot, and names the commit that ran — this is the only place
 * the app states its own provenance, so a QA sign-off can say which build it
 * applies to.
 *
 * Returns build identity only — never environment values, connection strings,
 * or anything user-scoped. See `@/lib/build-info` for where the fields come
 * from and why they are never blank.
 */
export function GET() {
  return NextResponse.json(
    { ok: true, service: "node-canvas-chat", ...buildInfo() },
    // A cached health response would report the commit of whichever deployment
    // filled the cache, which is worse than no answer at all.
    { headers: { "Cache-Control": "no-store" } },
  );
}
