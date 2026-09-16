import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { ServiceUnavailable } from "@/components/service-unavailable";
import { getSessionUser } from "@/lib/auth/session";
import { resolveNextPath, safeNextPath } from "@/lib/auth/next-path";
import { isDatabaseConfigured } from "@/lib/db";

export const dynamic = "force-dynamic";

// The "· Node Canvas Chat" suffix comes from the title template in the root
// layout now, so it is not repeated here.
export const metadata = { title: "Create an account" };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const next = (await searchParams).next;

  // Say so before the password is chosen, not after it is submitted. Rendering
  // the real form here would take a stranger through the whole ritual and then
  // answer with a 503.
  if (!isDatabaseConfigured()) {
    return <ServiceUnavailable heading="Create an account" />;
  }

  // Already signed in? Nothing to do here.
  if (await getSessionUser()) {
    redirect(resolveNextPath(next));
  }

  return <AuthForm mode="sign-up" next={safeNextPath(next) ?? undefined} />;
}
