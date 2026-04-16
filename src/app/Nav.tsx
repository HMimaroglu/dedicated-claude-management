import Link from "next/link";

export type NavTab = "dashboard" | "hosts" | "projects" | "instances" | "workflows";

const ITEMS: Array<{ tab: NavTab; href: string; label: string }> = [
  { tab: "dashboard", href: "/dashboard", label: "Dashboard" },
  { tab: "hosts", href: "/hosts", label: "Hosts" },
  { tab: "projects", href: "/projects", label: "Projects" },
  { tab: "instances", href: "/instances", label: "Instances" },
  { tab: "workflows", href: "/workflows", label: "Workflows" },
];

export function Nav({ current }: { current: NavTab }) {
  return (
    <nav className="text-sm flex gap-4 text-zinc-400">
      {ITEMS.map((it) => (
        <Link
          key={it.tab}
          href={it.href}
          className={it.tab === current ? "text-zinc-100" : "hover:text-zinc-100"}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}
