import { redirect } from "next/navigation";
import { KeyManager } from "@/components/key-manager";
import { getSessionUser } from "@/lib/auth/session";
import { signInHref } from "@/lib/auth/next-path";
import { isDatabaseConfigured } from "@/lib/db";
import { listKeys } from "@/lib/keys";
import { PROVIDERS, PROVIDER_IDS } from "@/lib/providers/registry";

export const dynamic = "force-dynamic";

// Suffixed by the root layout's title template.
export const metadata = { title: "Model access" };

/**
 * The signed-in surface.
 *
 * The session check happens here, on the server, against the database — not in
 * middleware. Middleware can only see that a cookie exists, which is not the
 * same question as whether it names a live session.
 */
export default async function KeysPage() {
  // Carry the destination through the bounce, so signing in resumes the trip
  // the visitor was on instead of landing them somewhere they did not ask for.
  // The path is a literal here: this page's own route is the only honest
  // answer, and taking it from a header would let a caller choose it.
  if (!isDatabaseConfigured()) redirect(signInHref("/keys"));

  const user = await getSessionUser();
  if (!user) redirect(signInHref("/keys"));

  return (
    <KeyManager
      email={user.email}
      initialKeys={await listKeys(user.id)}
      providers={PROVIDER_IDS.map((id) => ({
        id,
        label: PROVIDERS[id].label,
        consoleUrl: PROVIDERS[id].consoleUrl,
        keyPrefix: PROVIDERS[id].keyPrefix,
      }))}
    />
  );
}
