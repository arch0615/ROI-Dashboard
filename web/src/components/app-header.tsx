"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavEntry = { href: string; label: string; adminOnly?: boolean };

const NAV: NavEntry[] = [
  { href: "/", label: "Visão Geral" },
  { href: "/placements", label: "Placements" },
  { href: "/creatives", label: "Criativos" },
  { href: "/integrations", label: "Integrações", adminOnly: true },
  { href: "/rules", label: "Regras", adminOnly: true },
  { href: "/admin", label: "Admin", adminOnly: true },
];

export function AppHeader({
  username,
  role = "admin",
}: {
  username: string;
  role?: "admin" | "member" | string;
}) {
  const pathname = usePathname();
  const visible = NAV.filter((n) => !n.adminOnly || role === "admin");
  return (
    <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-6">
        <div className="flex items-center gap-6">
          <h1 className="text-lg font-semibold">ad-genius</h1>
          <nav className="flex items-center gap-1">
            {visible.map((n) => {
              const active = pathname === n.href;
              return (
                <Link
                  key={n.href}
                  // @ts-expect-error — typedRoutes is strict; the path list is closed
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
          {username}
          {role === "member" && <span className="ml-2 text-zinc-600">(membro)</span>}
          {" · "}
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
