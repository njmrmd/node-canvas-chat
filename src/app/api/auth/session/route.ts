import { getSessionUser } from "@/lib/auth/session";
import { json, withRoute } from "@/lib/http";
import { isDatabaseConfigured } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/session — "who am I?"
 *
 * Always 200, with `user: null` when nobody is signed in. A 401 here would
 * make every page load look like an error to the client for the entirely
 * normal case of a signed-out visitor.
 *
 * This is the one route that tolerates an unconfigured database, because the
 * client calls it on first paint and a signed-out answer is still correct.
 */
export const GET = withRoute("session", async () => {
  if (!isDatabaseConfigured()) return json({ user: null });

  const user = await getSessionUser();
  return json({ user });
});
