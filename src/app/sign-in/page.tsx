import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getSessionUser } from "@/lib/auth/session";
import { isDatabaseConfigured } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sign in · Node Canvas Chat" };

export default async function SignInPage() {
  if (isDatabaseConfigured() && (await getSessionUser())) redirect("/keys");
  return <AuthForm mode="sign-in" />;
}
