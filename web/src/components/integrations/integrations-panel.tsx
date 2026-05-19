"use client";

import { AppHeader } from "../app-header";
import { GoogleAccountsSection } from "./google-accounts-section";
import { GamAccountsSection } from "./gam-accounts-section";
import { SitesSection } from "./sites-section";
import { LinksSection } from "./links-section";

export function IntegrationsPanel({ username }: { username: string }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader username={username} />
      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <GoogleAccountsSection />
          <GamAccountsSection />
        </div>
        <SitesSection />
        <LinksSection />
      </main>
    </div>
  );
}
