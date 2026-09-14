import { redirect } from "next/navigation";
import { KeyManager } from "@/components/key-manager";
import { getSessionUser } from "@/lib/auth/session";
import { isDatabaseConfigured } from "@/lib/db";
import { listKeys } from "@/lib/keys";
import { PROVIDERS, PROVIDER_IDS } from "@/lib/providers/registry";

export const dynamic = "force-dynamic";

export const metadata = { title: "Model access · Node Canvas Chat" };

/**
 * The signed-in surface.
 *
 * The session check happens here, on the server, against the database — not in
 * middleware. Middleware can only see that a cookie exists, which is not the
 * same question as whether it names a live session.
 */
export default async function KeysPage() {
  if (!isDatabaseConfigured()) redirect("/sign-in");

  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

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
