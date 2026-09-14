import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getSessionUser } from "@/lib/auth/session";
import { isDatabaseConfigured } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata = { title: "Create an account · Node Canvas Chat" };

export default async function SignUpPage() {
  // Already signed in? Nothing to do here.
  if (isDatabaseConfigured() && (await getSessionUser())) redirect("/keys");
  return <AuthForm mode="sign-up" />;
}
