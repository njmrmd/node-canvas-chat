import { requireSessionUser } from "@/lib/auth/session";
import { json, withRoute } from "@/lib/http";
import { listKeys } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/keys — which providers this account has connected.
 *
 * Returns a masked suffix and timestamps. There is no route, anywhere in this
 * API, that returns a stored key: once saved, a key is write-only from the
 * client's point of view.
 */
export const GET = withRoute("keys.list", async () => {
  const user = await requireSessionUser();
  return json({ keys: await listKeys(user.id) });
});
