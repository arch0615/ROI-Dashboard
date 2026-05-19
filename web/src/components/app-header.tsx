"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/" as const, label: "Visão Geral" },
  { href: "/integrations" as const, label: "Integrações" },
];

export function AppHeader({ username }: { username: string }) {
  const pathname = usePathname();
  return (
    <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-6">
        <div className="flex items-center gap-6">
          <h1 className="text-lg font-semibold">ad-genius</h1>
          <nav className="flex items-center gap-1">
            {NAV.map((n) => {
              const active = pathname === n.href;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                    active
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900"
                  }`}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="text-xs text-zinc-400">
          {username} ·{" "}
          <a
            href="/api/auth/logout"
            onClick={async (e) => {
              e.preventDefault();
              await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
              window.location.href = "/login";
            }}
            className="hover:text-zinc-100 underline-offset-4 hover:underline"
          >
            Sair
          </a>
        </div>
      </div>
    </header>
  );
}
