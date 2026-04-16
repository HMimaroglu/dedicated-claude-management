"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export default function SetupForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 1) {
      setError("Password must not be empty");
      return;
    }
    start(async () => {
      const r = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Setup failed");
        return;
      }
      router.replace("/dashboard");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <span className="block text-sm mb-1">Username</span>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
          className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-zinc-100"
        />
      </label>
      <label className="block">
        <span className="block text-sm mb-1">Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-zinc-100"
        />
      </label>
      <label className="block">
        <span className="block text-sm mb-1">Confirm password</span>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-zinc-100"
        />
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="w-full bg-zinc-100 text-zinc-900 px-4 py-2 rounded-md font-medium disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create admin account"}
      </button>
    </form>
  );
}
