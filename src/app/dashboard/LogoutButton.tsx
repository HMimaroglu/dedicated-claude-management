"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export default function LogoutButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  function logout() {
    start(async () => {
      await fetch("/api/logout", { method: "POST" });
      router.replace("/login");
      router.refresh();
    });
  }
  return (
    <button
      onClick={logout}
      disabled={pending}
      className="bg-zinc-800 hover:bg-zinc-700 px-3 py-1 rounded text-sm disabled:opacity-50"
    >
      {pending ? "…" : "Log out"}
    </button>
  );
}
