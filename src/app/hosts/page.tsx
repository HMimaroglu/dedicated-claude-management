import { redirect } from "next/navigation";
import Link from "next/link";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { listHosts } from "@/lib/hosts";
import HostsClient from "./HostsClient";
import { Nav } from "../Nav";

export const dynamic = "force-dynamic";

export default async function HostsPage() {
  if (!hasAnyUser()) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const hosts = listHosts();

  return (
    <main className="max-w-4xl mx-auto pt-12 px-4">
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-2xl font-semibold hover:text-zinc-300">
            DCM
          </Link>
          <Nav current="hosts" />
        </div>
        <span className="text-sm text-zinc-400">{user.username}</span>
      </header>

      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Hosts</h2>
      </div>

      <HostsClient initialHosts={hosts} />
    </main>
  );
}
