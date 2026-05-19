"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SectionCard, buttonClass, ghostButtonClass, inputClass } from "./section-card";
import type { Site } from "./types";

export function SitesSection() {
  const qc = useQueryClient();
  const list = useQuery<Site[]>({
    queryKey: ["sites"],
    queryFn: () => api<Site[]>("/api/sites"),
  });

  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/sites", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setName("");
      setDomain("");
      qc.invalidateQueries({ queryKey: ["sites"] });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api(`/api/sites/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sites"] }),
  });

  return (
    <SectionCard
      title="Sites"
      subtitle="Cada site é uma propriedade que recebe tráfego do Google Ads e gera receita via GAM."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name) return;
          create.mutate({ name, domain: domain || undefined });
        }}
        className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2"
      >
        <input
          className={inputClass}
          placeholder="Nome (ex: meusite-1)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          className={inputClass}
          placeholder="Domínio (ex: meusite.com)"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
        />
        <button type="submit" className={buttonClass} disabled={create.isPending || !name}>
          {create.isPending ? "Adicionando..." : "Adicionar site"}
        </button>
        {create.isError && (
          <span className="md:col-span-3 text-sm text-rose-400">
            {(create.error as Error).message}
          </span>
        )}
      </form>

      <ul className="space-y-2">
        {list.isLoading && <li className="text-sm text-zinc-500">Carregando...</li>}
        {list.data?.length === 0 && (
          <li className="text-sm text-zinc-500 py-2">Nenhum site cadastrado.</li>
        )}
        {list.data?.map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{s.name}</div>
              {s.domain && <div className="text-xs text-zinc-500 truncate">{s.domain}</div>}
            </div>
            <button
              type="button"
              className={ghostButtonClass}
              onClick={() => del.mutate(s.id)}
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
