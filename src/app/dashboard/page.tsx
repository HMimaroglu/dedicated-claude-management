import Link from "next/link";
import { redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { listHosts } from "@/lib/hosts";
import LogoutButton from "./LogoutButton";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!hasAnyUser()) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const hosts = listHosts();
  const online = hosts.filter((h) => h.status === "online").length;
  const quarantined = hosts.filter((h) => h.status === "quarantined").length;

  return (
    <main className="max-w-3xl mx-auto pt-12 px-4">
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-semibold">DCM</h1>
          <nav className="text-sm flex gap-4 text-zinc-400">
            <Link href="/dashboard" className="text-zinc-100">Dashboard</Link>
            <Link href="/hosts" className="hover:text-zinc-100">Hosts</Link>
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-zinc-400">{user.username}</span>
          <LogoutButton />
        </div>
      </header>
      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard label="Hosts" value={hosts.length.toString()} />
        <StatCard label="Online" value={online.toString()} />
        <StatCard label="Quarantined" value={quarantined.toString()} tone={quarantined > 0 ? "warn" : undefined} />
      </div>
      <p className="text-zinc-400 text-sm">
        <Link href="/hosts" className="underline decoration-dotted">Manage hosts →</Link>
      </p>
    </main>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className={`bg-zinc-900 border rounded-md p-4 ${tone === "warn" ? "border-red-900" : "border-zinc-800"}`}>
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className="text-2xl font-mono">{value}</div>
    </div>
  );
}
