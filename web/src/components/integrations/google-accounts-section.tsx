"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SectionCard, buttonClass, ghostButtonClass, inputClass } from "./section-card";
import type { GoogleAccount } from "./types";

export function GoogleAccountsSection() {
  const qc = useQueryClient();
  const list = useQuery<GoogleAccount[]>({
    queryKey: ["google-accounts"],
    queryFn: () => api<GoogleAccount[]>("/api/google-accounts"),
  });

  const [customerId, setCustomerId] = useState("");
  const [accountName, setAccountName] = useState("");
  const [loginCustomerId, setLoginCustomerId] = useState("");
  const [isMcc, setIsMcc] = useState(false);
  const [refreshToken, setRefreshToken] = useState("");

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/google-accounts", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setCustomerId("");
      setAccountName("");
      setLoginCustomerId("");
      setIsMcc(false);
      setRefreshToken("");
      qc.invalidateQueries({ queryKey: ["google-accounts"] });
    },
  });

  const connect = useMutation({
    mutationFn: () => api<{ url: string }>("/api/oauth/google/start", { method: "POST" }),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });

  const del = useMutation({
    mutationFn: (id: string) =>
      api(`/api/google-accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["google-accounts"] }),
  });

  const [actionResults, setActionResults] = useState<
    Record<string, { state: "ok" | "error"; message: string } | undefined>
  >({});
  const test = useMutation({
    mutationFn: async (id: string) => {
      const data = await api<{ customers: string[] }>(`/api/google-accounts/${id}/customers`);
      return { id, customers: data.customers };
    },
    onSuccess: ({ id, customers }) => {
      setActionResults((prev) => ({
        ...prev,
        [id]: {
          state: "ok",
          message: customers.length
            ? `${customers.length} cliente(s): ${customers.slice(0, 5).join(", ")}${customers.length > 5 ? "…" : ""}`
            : "Token válido (nenhum cliente visível)",
        },
      }));
    },
    onError: (err, id) => {
      setActionResults((prev) => ({
        ...prev,
        [id]: { state: "error", message: (err as Error).message },
      }));
    },
  });
  const sync = useMutation({
    mutationFn: async (id: string) => {
      const data = await api<{
        leaf_count: number;
        metric_rows: number;
        accounts: Array<{ customer_id: string; campaigns?: number; metric_rows?: number; error?: string }>;
      }>(`/api/sync/google-ads/${id}`, {
        method: "POST",
        body: JSON.stringify({ date_preset: "LAST_7_DAYS" }),
      });
      return { id, ...data };
    },
    onSuccess: ({ id, leaf_count, metric_rows, accounts }) => {
      const errs = accounts.filter((a) => a.error);
      setActionResults((prev) => ({
        ...prev,
        [id]: {
          state: errs.length === 0 ? "ok" : "error",
          message:
            errs.length === 0
              ? `${leaf_count} conta(s), ${metric_rows} linha(s) de métrica`
              : `${errs[0]?.error ?? "erro desconhecido"}`,
        },
      }));
      qc.invalidateQueries({ queryKey: ["google-accounts"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (err, id) => {
      setActionResults((prev) => ({
        ...prev,
        [id]: { state: "error", message: (err as Error).message },
      }));
    },
  });

  return (
    <SectionCard
      title="Contas Google Ads"
      subtitle="Conecte via OAuth para autorizar a leitura das suas contas. Ou, se preferir, cole um refresh_token manualmente — em qualquer caso ele é criptografado em repouso (AES-256-GCM)."
    >
      <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
        <div className="flex-1 text-sm">
          <p className="font-medium">Autorizar via Google</p>
          <p className="text-xs text-zinc-500">
            Redireciona para a tela de consentimento do Google. Após autorizar,
            todas as contas acessíveis são adicionadas automaticamente.
          </p>
        </div>
        <button
          type="button"
          className={buttonClass}
          onClick={() => connect.mutate()}
          disabled={connect.isPending}
        >
          {connect.isPending ? "Redirecionando..." : "Conectar via Google"}
        </button>
      </div>
      {connect.isError && (
        <p className="text-sm text-rose-400">{(connect.error as Error).message}</p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!customerId) return;
          create.mutate({
            customer_id: customerId,
            account_name: accountName || undefined,
            login_customer_id: loginCustomerId || undefined,
            is_mcc: isMcc,
            refresh_token: refreshToken || undefined,
          });
        }}
        className="grid grid-cols-1 md:grid-cols-2 gap-2"
      >
        <input
          className={inputClass}
          placeholder="customer_id (ex: 123-456-7890)"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          required
        />
        <input
          className={inputClass}
          placeholder="Nome da conta (opcional)"
          value={accountName}
          onChange={(e) => setAccountName(e.target.value)}
        />
        <input
          className={inputClass}
          placeholder="login_customer_id (MCC, opcional)"
          value={loginCustomerId}
          onChange={(e) => setLoginCustomerId(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm text-zinc-300 px-1">
          <input
            type="checkbox"
            checked={isMcc}
            onChange={(e) => setIsMcc(e.target.checked)}
            className="accent-zinc-400"
          />
          É conta MCC
        </label>
        <textarea
          className={`${inputClass} md:col-span-2 h-20 py-2`}
          placeholder="refresh_token (opcional)"
          value={refreshToken}
          onChange={(e) => setRefreshToken(e.target.value)}
        />
        <div className="md:col-span-2 flex items-center gap-2">
          <button type="submit" className={buttonClass} disabled={create.isPending || !customerId}>
            {create.isPending ? "Adicionando..." : "Adicionar conta"}
          </button>
          {create.isError && (
            <span className="text-sm text-rose-400">{(create.error as Error).message}</span>
          )}
        </div>
      </form>

      <ul className="space-y-2">
        {list.isLoading && <li className="text-sm text-zinc-500">Carregando...</li>}
        {list.data?.length === 0 && (
          <li className="text-sm text-zinc-500 py-2">Nenhuma conta adicionada.</li>
        )}
        {list.data?.map((a) => {
          const result = actionResults[a.id];
          const isTesting = test.isPending && test.variables === a.id;
          const isSyncing = sync.isPending && sync.variables === a.id;
          return (
            <li
              key={a.id}
              className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {a.account_name ?? a.customer_id}
                  </div>
                  <div className="text-xs text-zinc-500 flex items-center gap-2">
                    <span>{a.customer_id}</span>
                    {a.is_mcc && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5">MCC</span>
                    )}
                    <span
                      className={`rounded px-1.5 py-0.5 ${
                        a.has_refresh_token
                          ? "bg-emerald-900/50 text-emerald-300"
                          : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      {a.has_refresh_token ? "token salvo" : "sem token"}
                    </span>
                    <span>{a.status}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    className={ghostButtonClass}
                    onClick={() => test.mutate(a.id)}
                    disabled={!a.has_refresh_token || isTesting}
                  >
                    {isTesting ? "Testando..." : "Testar"}
                  </button>
                  <button
                    type="button"
                    className={ghostButtonClass}
                    onClick={() => sync.mutate(a.id)}
                    disabled={!a.has_refresh_token || isSyncing}
                  >
                    {isSyncing ? "Sincronizando..." : "Sincronizar"}
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
