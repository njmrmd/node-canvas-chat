import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { ServiceUnavailable } from "@/components/service-unavailable";
import { getSessionUser } from "@/lib/auth/session";
import { resolveNextPath, safeNextPath } from "@/lib/auth/next-path";
import { isDatabaseConfigured } from "@/lib/db";

export const dynamic = "force-dynamic";

// Suffixed by the root layout's title template.
export const metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // `next` carries the page the visitor was actually trying to reach. It is a
  // query parameter, so it is hostile until `safeNextPath` says otherwise.
  const next = (await searchParams).next;
  const destination = resolveNextPath(next);

  // `/keys` bounces here when there is no database, so without this a visitor
  // is sent to a sign-in form that cannot authenticate anyone.
  if (!isDatabaseConfigured()) {
    return <ServiceUnavailable heading="Sign in" />;
  }

  if (await getSessionUser()) redirect(destination);

  return <AuthForm mode="sign-in" next={safeNextPath(next) ?? undefined} />;
}
