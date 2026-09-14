import { assertSameOrigin } from "@/lib/auth/csrf";
import { destroySession } from "@/lib/auth/session";
import { noContent, withRoute } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/signout
 *
 * Idempotent: signing out without a session is a 204, not an error. There is
 * nothing to leak and nothing useful to say.
 *
 * POST rather than GET because it changes state — a GET sign-out can be fired
 * by any <img> tag on any page on the internet.
 */
export const POST = withRoute("signout", async (request: Request) => {
  assertSameOrigin(request);
  await destroySession();
  return noContent();
});
