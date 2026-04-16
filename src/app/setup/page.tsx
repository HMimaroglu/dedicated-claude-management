import { redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import SetupForm from "./SetupForm";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  if (hasAnyUser()) redirect("/login");
  return (
    <main className="max-w-md mx-auto pt-16 px-4">
      <h1 className="text-2xl font-semibold mb-2">First-run setup</h1>
      <p className="text-sm text-zinc-400 mb-6">
        Create the admin account. This is the only account. There is no minimum
        password length — any non-empty password is accepted.
      </p>
      <SetupForm />
    </main>
  );
}
