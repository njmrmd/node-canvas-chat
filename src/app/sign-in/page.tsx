import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getSessionUser } from "@/lib/auth/session";
import { resolveNextPath, safeNextPath } from "@/lib/auth/next-path";
import { isDatabaseConfigured } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sign in · Node Canvas Chat" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // `next` carries the page the visitor was actually trying to reach. It is a
  // query parameter, so it is hostile until `safeNextPath` says otherwise.
  const next = (await searchParams).next;
  const destination = resolveNextPath(next);

  if (isDatabaseConfigured() && (await getSessionUser())) redirect(destination);

  return <AuthForm mode="sign-in" next={safeNextPath(next) ?? undefined} />;
}
