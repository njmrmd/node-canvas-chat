import { redirect } from "next/navigation";
import "@/app/canvas.css";
import { CanvasApp } from "@/components/canvas/canvas-app";
import { getSessionUser } from "@/lib/auth/session";
import { signInHref } from "@/lib/auth/next-path";
import { isDatabaseConfigured } from "@/lib/db";
import { listKeys } from "@/lib/keys";
import { CANVAS } from "@/lib/routes";
import { PROVIDERS } from "@/lib/providers/registry";

export const dynamic = "force-dynamic";

// Suffixed by the root layout's title template.
export const metadata = { title: "Canvas" };

/**
 * The product surface, per the same session-check pattern `/keys` uses: the
 * check happens here, server-side, against the database — not in middleware,
 * which can only see that a cookie exists.
 *
 * `hasProvider` is computed once, server-side, from the same query
 * `/keys` uses to decide "connected" — a presence check on `listKeys`, not a
 * boolean column. The client never learns *which* key exists beyond that.
 */
export default async function CanvasPage() {
  if (!isDatabaseConfigured()) redirect(signInHref(CANVAS));

  const user = await getSessionUser();
  if (!user) redirect(signInHref(CANVAS));

  const keys = await listKeys(user.id);
  const hasProvider = keys.some((key) => key.provider === "anthropic");

  return (
    <CanvasApp
      email={user.email}
      hasProvider={hasProvider}
      models={PROVIDERS.anthropic.models}
      defaultModelId={PROVIDERS.anthropic.defaultModelId}
    />
  );
}
