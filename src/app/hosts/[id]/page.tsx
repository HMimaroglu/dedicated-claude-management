import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getHost, recentProbes } from "@/lib/hosts";
import HostDetailClient from "./HostDetailClient";
import { Nav } from "../../Nav";

export const dynamic = "force-dynamic";

export default async function HostDetail(
  { params }: { params: Promise<{ id: string }> }
) {
  if (!hasAnyUser()) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { id } = await params;
  const hostId = Number.parseInt(id, 10);
  if (!Number.isFinite(hostId)) notFound();
  const host = getHost(hostId);
  if (!host) notFound();
  const probes = recentProbes(hostId, 50);

  return (
    <main className="max-w-4xl mx-auto pt-12 px-4">
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-2xl font-semibold hover:text-zinc-300">DCM</Link>
          <div className="flex items-center gap-4">
            <Nav current="hosts" />
            <span className="text-zinc-100 font-mono text-sm">/ {host.name}</span>
          </div>
        </div>
        <span className="text-sm text-zinc-400">{user.username}</span>
      </header>

      <HostDetailClient host={host} probes={probes} />
    </main>
  );
}
