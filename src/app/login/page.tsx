import { redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!hasAnyUser()) redirect("/setup");
  const user = await getSessionUser();
  if (user) redirect("/dashboard");
  return (
    <main className="max-w-md mx-auto pt-16 px-4">
      <h1 className="text-2xl font-semibold mb-6">Sign in</h1>
      <LoginForm />
    </main>
  );
}
