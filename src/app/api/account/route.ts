import { cookies } from "next/headers";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { SESSION_COOKIE, requireSessionUser } from "@/lib/auth/session";
import { query } from "@/lib/db";
import { noContent, withRoute } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/account — delete the account, and with it the key.
 *
 * `data minimization`: this is one statement. `provider_keys` and `sessions`
 * both cascade from `users`, so deleting the account provably removes the
 * stored key and revokes every session — there is no second system to
 * reconcile and no cleanup job that can silently fail to run.
 *
 * Scoped to the caller's own id, so this route cannot delete anyone else's
 * account no matter what the request says.
 */
export const DELETE = withRoute("account.delete", async (request: Request) => {
  assertSameOrigin(request);

  const user = await requireSessionUser();
  await query("delete from users where id = $1", [user.id]);

  // The rows are gone, so the cookie is already dead; clear it so the browser
  // does not keep presenting it.
  (await cookies()).delete(SESSION_COOKIE);

  return noContent();
});
