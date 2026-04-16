import { redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import LogoutButton from "./LogoutButton";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!hasAnyUser()) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <main className="max-w-3xl mx-auto pt-12 px-4">
      <header className="flex justify-between items-center mb-8">
        <h1 className="text-2xl font-semibold">DCM</h1>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-zinc-400">{user.username}</span>
          <LogoutButton />
        </div>
      </header>
      <p className="text-zinc-400">
        Phase 1 complete. Hosts, projects, and instances coming next.
      </p>
    </main>
  );
}
