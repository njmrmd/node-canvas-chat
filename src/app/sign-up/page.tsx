import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getSessionUser } from "@/lib/auth/session";
import { resolveNextPath, safeNextPath } from "@/lib/auth/next-path";
import { isDatabaseConfigured } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata = { title: "Create an account · Node Canvas Chat" };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const next = (await searchParams).next;

  // Already signed in? Nothing to do here.
  if (isDatabaseConfigured() && (await getSessionUser())) {
    redirect(resolveNextPath(next));
  }

  return <AuthForm mode="sign-up" next={safeNextPath(next) ?? undefined} />;
}
