"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SectionCard, buttonClass, ghostButtonClass, inputClass } from "./section-card";
import type { AccountSiteLink, GamAccount, GoogleAccount, Site } from "./types";

export function LinksSection() {
  const qc = useQueryClient();
  const links = useQuery<AccountSiteLink[]>({
    queryKey: ["account-site-links"],
    queryFn: () => api<AccountSiteLink[]>("/api/account-site-links"),
  });
  const googleAccounts = useQuery<GoogleAccount[]>({
    queryKey: ["google-accounts"],
    queryFn: () => api<GoogleAccount[]>("/api/google-accounts"),
  });
  const gamAccounts = useQuery<GamAccount[]>({
    queryKey: ["gam-accounts"],
    queryFn: () => api<GamAccount[]>("/api/gam-accounts"),
  });
  const sites = useQuery<Site[]>({
    queryKey: ["sites"],
    queryFn: () => api<Site[]>("/api/sites"),
  });

  const [siteId, setSiteId] = useState("");
  const [googleAccountId, setGoogleAccountId] = useState("");
  const [gamAccountId, setGamAccountId] = useState("");

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/account-site-links", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setSiteId("");
      setGoogleAccountId("");
      setGamAccountId("");
      qc.invalidateQueries({ queryKey: ["account-site-links"] });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) =>
      api(`/api/account-site-links/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account-site-links"] }),
  });

  const googleAccountById = new Map(googleAccounts.data?.map((a) => [a.id, a]) ?? []);
  const gamAccountById = new Map(gamAccounts.data?.map((a) => [a.id, a]) ?? []);
  const siteById = new Map(sites.data?.map((s) => [s.id, s]) ?? []);

  return (
    <SectionCard
      title="Vínculos Conta ↔ Site"
      subtitle="Mapeia receita do site para a campanha Ads correta. O match real acontece via UTM (utm_campaign=campaignid)."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!siteId || (!googleAccountId && !gamAccountId)) return;
          create.mutate({
            site_id: siteId,
            google_account_id: googleAccountId || undefined,
            gam_account_id: gamAccountId || undefined,
          });
        }}
        className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-2"
      >
        <select
          className={inputClass}
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          required
        >
          <option value="">— Site —</option>
          {sites.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          className={inputClass}
          value={googleAccountId}
          onChange={(e) => setGoogleAccountId(e.target.value)}
        >
          <option value="">— Conta Google Ads —</option>
          {googleAccounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.account_name ?? a.customer_id}
            </option>
          ))}
        </select>
        <select
          className={inputClass}
          value={gamAccountId}
          onChange={(e) => setGamAccountId(e.target.value)}
        >
          <option value="">— Conta GAM —</option>
          {gamAccounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.account_name ?? a.network_code}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className={buttonClass}
          disabled={create.isPending || !siteId || (!googleAccountId && !gamAccountId)}
        >
          {create.isPending ? "Vinculando..." : "Vincular"}
        </button>
        {create.isError && (
          <span className="md:col-span-4 text-sm text-rose-400">
            {(create.error as Error).message}
          </span>
        )}
      </form>

      <ul className="space-y-2">
        {links.isLoading && <li className="text-sm text-zinc-500">Carregando...</li>}
        {links.data?.length === 0 && (
          <li className="text-sm text-zinc-500 py-2">Nenhum vínculo criado.</li>
        )}
        {links.data?.map((l) => {
          const site = siteById.get(l.site_id);
          const ga = l.google_account_id ? googleAccountById.get(l.google_account_id) : null;
          const gam = l.gam_account_id ? gamAccountById.get(l.gam_account_id) : null;
          return (
            <li
              key={l.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2"
            >
              <div className="min-w-0 text-sm">
                <span className="font-medium">{site?.name ?? "—"}</span>
                <span className="mx-2 text-zinc-600">↔</span>
                {ga && (
                  <span className="text-zinc-300">
                    Ads: {ga.account_name ?? ga.customer_id}
                  </span>
                )}
                {ga && gam && <span className="mx-2 text-zinc-600">·</span>}
                {gam && (
                  <span className="text-zinc-300">
                    GAM: {gam.account_name ?? gam.network_code}
                  </span>
                )}
              </div>
              <button
                type="button"
                className={ghostButtonClass}
                onClick={() => del.mutate(l.id)}
                disabled={del.isPending}
              >
                Remover
              </button>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
