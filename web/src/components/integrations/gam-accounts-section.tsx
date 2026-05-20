"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SectionCard, buttonClass, ghostButtonClass, inputClass } from "./section-card";
import type { GamAccount } from "./types";

function UtmKeyForm({
  account,
  onSave,
  isSaving,
}: {
  account: GamAccount;
  onSave: (vars: { id: string; utm_key_id: string; utm_key_name: string }) => void;
  isSaving: boolean;
}) {
  const [keyId, setKeyId] = useState(account.utm_key_id ?? "");
  const [keyName, setKeyName] = useState(account.utm_key_name ?? "");
  useEffect(() => {
    setKeyId(account.utm_key_id ?? "");
    setKeyName(account.utm_key_name ?? "");
  }, [account.utm_key_id, account.utm_key_name]);

  const dirty = keyId !== (account.utm_key_id ?? "") || keyName !== (account.utm_key_name ?? "");

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-zinc-500">UTM:</span>
      <input
        className={`${inputClass} h-7 w-28 text-xs`}
        placeholder="key_id (ex: 12345)"
        value={keyId}
        onChange={(e) => setKeyId(e.target.value.trim())}
      />
      <input
        className={`${inputClass} h-7 w-40 text-xs`}
        placeholder="rótulo (ex: utm_campaign)"
        value={keyName}
        onChange={(e) => setKeyName(e.target.value)}
      />
      {dirty && (
        <button
          type="button"
          onClick={() => onSave({ id: account.id, utm_key_id: keyId, utm_key_name: keyName })}
          disabled={isSaving}
          className="h-7 px-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-medium hover:bg-white disabled:opacity-50"
        >
          {isSaving ? "..." : "Salvar"}
        </button>
      )}
    </div>
  );
}

export function GamAccountsSection() {
  const qc = useQueryClient();
  const list = useQuery<GamAccount[]>({
    queryKey: ["gam-accounts"],
    queryFn: () => api<GamAccount[]>("/api/gam-accounts"),
  });

  const [networkCode, setNetworkCode] = useState("");
  const [accountName, setAccountName] = useState("");
  const [saJson, setSaJson] = useState("");

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/gam-accounts", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setNetworkCode("");
      setAccountName("");
      setSaJson("");
      qc.invalidateQueries({ queryKey: ["gam-accounts"] });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api(`/api/gam-accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gam-accounts"] }),
  });

  const [syncResults, setSyncResults] = useState<
    Record<string, { state: "ok" | "error"; message: string } | undefined>
  >({});
  const sync = useMutation({
    mutationFn: async (id: string) => {
      const data = await api<{ rows_written: number; total_revenue: number }>(
        `/api/sync/gam/${id}`,
        { method: "POST", body: JSON.stringify({ date_preset: "LAST_7_DAYS" }) },
      );
      return { id, ...data };
    },
    onSuccess: ({ id, rows_written, total_revenue }) => {
      setSyncResults((prev) => ({
        ...prev,
        [id]: {
          state: "ok",
          message: `${rows_written} linha(s), receita total ≈ ${total_revenue.toFixed(2)}`,
        },
      }));
      qc.invalidateQueries({ queryKey: ["gam-accounts"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (err, id) => {
      setSyncResults((prev) => ({
        ...prev,
        [id]: { state: "error", message: (err as Error).message },
      }));
    },
  });
  const utmSync = useMutation({
    mutationFn: async (id: string) => {
      const data = await api<{ rows_written: number; total_revenue: number; unmatched_rows: number }>(
        `/api/sync/gam-utm/${id}`,
        { method: "POST", body: JSON.stringify({ date_preset: "LAST_7_DAYS" }) },
      );
      return { id, ...data };
    },
    onSuccess: ({ id, rows_written, total_revenue, unmatched_rows }) => {
      setSyncResults((prev) => ({
        ...prev,
        [id]: {
          state: "ok",
          message: `UTM: ${rows_written} linha(s) atribuída(s), receita ${total_revenue.toFixed(2)}${unmatched_rows ? ` (${unmatched_rows} sem valor)` : ""}`,
        },
      }));
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (err, id) => {
      setSyncResults((prev) => ({
        ...prev,
        [id]: { state: "error", message: (err as Error).message },
      }));
    },
  });
  const saveUtmKey = useMutation({
    mutationFn: async (vars: { id: string; utm_key_id: string; utm_key_name: string }) => {
      const data = await api<GamAccount>(`/api/gam-accounts/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          utm_key_id: vars.utm_key_id || null,
          utm_key_name: vars.utm_key_name || null,
        }),
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["gam-accounts"] });
    },
  });

  return (
    <SectionCard
      title="Contas GAM"
      subtitle="Cole o JSON da Service Account. Será criptografado em repouso (AES-256-GCM). O e-mail é extraído automaticamente do client_email."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!networkCode) return;
          create.mutate({
            network_code: networkCode,
            account_name: accountName || undefined,
            service_account_json: saJson || undefined,
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
        <textarea
          className={`${inputClass} md:col-span-2 h-32 py-2 font-mono text-xs`}
          placeholder='Cole o JSON da Service Account aqui (com client_email e private_key)'
          value={saJson}
          onChange={(e) => setSaJson(e.target.value)}
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
        {list.data?.map((a) => {
          const result = syncResults[a.id];
          const isSyncing = sync.isPending && sync.variables === a.id;
          const isUtmSyncing = utmSync.isPending && utmSync.variables === a.id;
          return (
            <li
              key={a.id}
              className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {a.account_name ?? a.network_code}
                  </div>
                  <div className="text-xs text-zinc-500 flex items-center gap-2 flex-wrap">
                    <span>network {a.network_code}</span>
                    {a.currency && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5">{a.currency}</span>
                    )}
                    <span
                      className={`rounded px-1.5 py-0.5 ${
                        a.has_service_account
                          ? "bg-emerald-900/50 text-emerald-300"
                          : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      {a.has_service_account ? "SA salva" : "sem SA"}
                    </span>
                    {a.utm_key_id && (
                      <span className="rounded bg-indigo-900/50 text-indigo-300 px-1.5 py-0.5">
                        UTM key {a.utm_key_id}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    className={ghostButtonClass}
                    onClick={() => sync.mutate(a.id)}
                    disabled={!a.has_service_account || isSyncing}
                  >
                    {isSyncing ? "Sincronizando..." : "Sincronizar"}
                  </button>
                  <button
                    type="button"
                    className={ghostButtonClass}
                    onClick={() => utmSync.mutate(a.id)}
                    disabled={!a.has_service_account || !a.utm_key_id || isUtmSyncing}
                    title={
                      a.utm_key_id
                        ? "Sincronizar receita por UTM (atribuição direta a campanhas)"
                        : "Configure utm_key_id abaixo"
                    }
                  >
                    {isUtmSyncing ? "UTM..." : "UTM"}
                  </button>
                  <button
                    type="button"
                    className={ghostButtonClass}
                    onClick={() => del.mutate(a.id)}
                    disabled={del.isPending}
                  >
                    Remover
                  </button>
                </div>
              </div>
              <UtmKeyForm
                account={a}
                onSave={(vars) => saveUtmKey.mutate(vars)}
                isSaving={saveUtmKey.isPending && saveUtmKey.variables?.id === a.id}
              />
              {result && (
                <div
                  className={`text-xs ${
                    result.state === "ok" ? "text-emerald-300" : "text-rose-400"
                  }`}
                >
                  {result.message}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
