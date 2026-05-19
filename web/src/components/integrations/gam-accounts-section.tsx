"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SectionCard, buttonClass, ghostButtonClass, inputClass } from "./section-card";
import type { GamAccount } from "./types";

export function GamAccountsSection() {
  const qc = useQueryClient();
  const list = useQuery<GamAccount[]>({
    queryKey: ["gam-accounts"],
    queryFn: () => api<GamAccount[]>("/api/gam-accounts"),
  });

  const [networkCode, setNetworkCode] = useState("");
  const [accountName, setAccountName] = useState("");
  const [serviceEmail, setServiceEmail] = useState("");

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/gam-accounts", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setNetworkCode("");
      setAccountName("");
      setServiceEmail("");
      qc.invalidateQueries({ queryKey: ["gam-accounts"] });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api(`/api/gam-accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gam-accounts"] }),
  });

  return (
    <SectionCard
      title="Contas GAM"
      subtitle="Adicione o network_code da rede e o e-mail da Service Account. O upload da chave JSON chega no M3."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!networkCode) return;
          create.mutate({
            network_code: networkCode,
            account_name: accountName || undefined,
            service_account_email: serviceEmail || undefined,
          });
        }}
        className="grid grid-cols-1 md:grid-cols-2 gap-2"
      >
        <input
          className={inputClass}
          placeholder="network_code (ex: 12345678)"
          value={networkCode}
          onChange={(e) => setNetworkCode(e.target.value)}
          required
        />
        <input
          className={inputClass}
          placeholder="Nome da rede (opcional)"
          value={accountName}
          onChange={(e) => setAccountName(e.target.value)}
        />
        <input
          className={`${inputClass} md:col-span-2`}
          placeholder="service_account_email (ex: svc@proj.iam.gserviceaccount.com)"
          value={serviceEmail}
          onChange={(e) => setServiceEmail(e.target.value)}
        />
        <div className="md:col-span-2 flex items-center gap-2">
          <button type="submit" className={buttonClass} disabled={create.isPending || !networkCode}>
            {create.isPending ? "Adicionando..." : "Adicionar conta GAM"}
          </button>
          {create.isError && (
            <span className="text-sm text-rose-400">{(create.error as Error).message}</span>
          )}
        </div>
      </form>

      <ul className="space-y-2">
        {list.isLoading && <li className="text-sm text-zinc-500">Carregando...</li>}
        {list.data?.length === 0 && (
          <li className="text-sm text-zinc-500 py-2">Nenhuma rede GAM adicionada.</li>
        )}
        {list.data?.map((a) => (
          <li
            key={a.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">
                {a.account_name ?? a.network_code}
              </div>
              <div className="text-xs text-zinc-500 flex items-center gap-2">
                <span>network {a.network_code}</span>
                {a.service_account_email && (
                  <span className="truncate">{a.service_account_email}</span>
                )}
                <span>{a.status}</span>
              </div>
            </div>
            <button
              type="button"
              className={ghostButtonClass}
              onClick={() => del.mutate(a.id)}
              disabled={del.isPending}
            >
              Remover
            </button>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
