"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { fmtCurrency, fmtNumber, fmtPercent } from "@/lib/format";
import { DATE_PRESETS, type DatePresetKey } from "@/lib/date-presets";
import { AppHeader } from "../app-header";

type Item = {
  key: string;
  campaign_id: string;
  campaign_name: string | null;
  placement: string;
  placement_clean: string | null;
  raw_placement: string;
  impressions: number;
  cost: number;
  revenue: number;
  profit: number;
  roi: number;
  days: number;
  matched: boolean;
  reason: "roi_critico" | "roi_baixo";
};

type CampaignTotal = {
  campaign_id: string;
  campaign_name: string | null;
  cost: number;
  revenue_brl: number;
  profit: number;
  roi: number;
  landing_page_count: number;
  bad_count: number;
};

type Preview = {
  stats: {
    period: { from: string; to: string };
    cfg: { min_cost: number; max_roi: number; min_days: number };
    gam_rev_rows: number;
    campaigns_with_revenue: number;
    landing_pages_analyzed: number;
    placements_bad: number;
  };
  items: Item[];
  campaign_totals: CampaignTotal[];
};

const REASON_LABEL: Record<Item["reason"], string> = {
  roi_critico: "ROI crítico",
  roi_baixo: "ROI baixo",
};

const REASON_STYLE: Record<Item["reason"], string> = {
  roi_critico: "bg-rose-950/60 text-rose-200 border-rose-800",
  roi_baixo: "bg-amber-950/60 text-amber-200 border-amber-800",
};

type Exclusion = {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
  placement: string;
  criterion_resource_name: string | null;
  snapshot_cost: number;
  snapshot_revenue: number;
  snapshot_roi: number;
  reason: string | null;
  applied_at: string;
  undone_at: string | null;
  error: string | null;
};

export function PlacementsPanel({
  username,
  role,
}: {
  username: string;
  role?: string;
}) {
  const qc = useQueryClient();
  const isAdmin = role === "admin";
  const [preset, setPreset] = useState<DatePresetKey>("last_7_days");
  const [minCost, setMinCost] = useState(20);
  const [maxRoi, setMaxRoi] = useState(-10);
  const [reasonFilter, setReasonFilter] = useState<Item["reason"] | "all">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applyResult, setApplyResult] = useState<{
    applied: number;
    rejected: number;
    errors: number;
    rejected_items?: Array<{ placement: string; rejected_reason: string }>;
  } | null>(null);

  const range = useMemo(() => {
    const p = DATE_PRESETS.find((d) => d.key === preset);
    return p ? p.range() : { from: "", to: "" };
  }, [preset]);

  const query = useQuery<Preview>({
    queryKey: ["placements-preview", range.from, range.to, minCost, maxRoi],
    queryFn: () => {
      const qs = new URLSearchParams({
        from: range.from,
        to: range.to,
        min_cost: String(minCost),
        max_roi: String(maxRoi),
      });
      return api<Preview>(`/api/placements/preview?${qs.toString()}`);
    },
  });

  const exclusionsQuery = useQuery<Exclusion[]>({
    queryKey: ["placement-exclusions"],
    queryFn: () => api<Exclusion[]>(`/api/placements/exclusions`),
  });

  const apply = useMutation({
    mutationFn: () => {
      const items = (query.data?.items ?? []).filter((it) => selected.has(it.key));
      return api<{
        applied: number;
        rejected: number;
        errors: number;
        rejected_items: Array<{ placement: string; rejected_reason: string }>;
      }>(`/api/placements/exclude`, {
        method: "POST",
        body: JSON.stringify({
          items: items.map((it) => ({
            campaign_id: it.campaign_id,
            campaign_name: it.campaign_name,
            placement: it.placement,
            reason: it.reason,
          })),
          max_roi: maxRoi,
          from: range.from,
          to: range.to,
        }),
      });
    },
    onSuccess: (data) => {
      setApplyResult(data);
      setSelected(new Set());
      setConfirmOpen(false);
      qc.invalidateQueries({ queryKey: ["placement-exclusions"] });
      qc.invalidateQueries({ queryKey: ["placements-preview"] });
    },
  });

  const undo = useMutation({
    mutationFn: (id: string) =>
      api(`/api/placements/exclusions/${id}/undo`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["placement-exclusions"] }),
  });

  const items = (query.data?.items ?? []).filter((it) =>
    reasonFilter === "all" ? true : it.reason === reasonFilter,
  );

  // Clear selection if the underlying item list changes (date/threshold filter).
  useEffect(() => {
    setSelected(new Set());
  }, [range.from, range.to, minCost, maxRoi, reasonFilter]);

  const stats = query.data?.stats;
  const activeExclusions = exclusionsQuery.data ?? [];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader username={username} role={role} />
      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Placements — bloquear ruins</h1>
            <p className="text-sm text-zinc-400">
              Cruzamento de custo (Google Ads) com receita (GAM via UTM) por
              (campanha, landing page). Marque o que quer bloquear, clique{" "}
              <span className="text-zinc-100">Aplicar exclusão</span>. Antes de
              mutar o Google Ads o sistema re-confere o ROI mais recente — se
              tiver melhorado, recusa.
            </p>
          </div>
        </div>

        {/* Controls */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 pr-1">
              Período
            </span>
            {DATE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPreset(p.key)}
                className={`h-8 px-3 rounded-md text-xs font-medium ${
                  preset === p.key
                    ? "bg-zinc-100 text-zinc-950"
                    : "border border-zinc-700 text-zinc-200 hover:bg-zinc-800"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="space-y-1">
              <span className="block text-[11px] uppercase tracking-wider text-zinc-500">
                Custo mínimo (R$)
              </span>
              <input
                type="number"
                value={minCost}
                onChange={(e) => setMinCost(Number(e.target.value) || 0)}
                className="h-9 w-28 rounded-md bg-zinc-950 border border-zinc-800 px-3"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] uppercase tracking-wider text-zinc-500">
                ROI máx. (%)
              </span>
              <input
                type="number"
                value={maxRoi}
                onChange={(e) => setMaxRoi(Number(e.target.value) || 0)}
                className="h-9 w-28 rounded-md bg-zinc-950 border border-zinc-800 px-3"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] uppercase tracking-wider text-zinc-500">
                Filtrar por motivo
              </span>
              <select
                value={reasonFilter}
                onChange={(e) =>
                  setReasonFilter((e.target.value as Item["reason"]) || "all")
                }
                className="h-9 rounded-md bg-zinc-950 border border-zinc-800 px-3"
              >
                <option value="all">Todos</option>
                <option value="roi_critico">ROI crítico</option>
                <option value="roi_baixo">ROI baixo</option>
              </select>
            </label>
          </div>
        </section>

        {/* Stats strip */}
        {stats && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-xs grid grid-cols-2 md:grid-cols-5 gap-y-2 gap-x-6">
            <Stat label="Período" value={`${stats.period.from} → ${stats.period.to}`} />
            <Stat label="Campanhas com receita" value={fmtNumber(stats.campaigns_with_revenue)} />
            <Stat label="Landing pages analisadas" value={fmtNumber(stats.landing_pages_analyzed)} />
            <Stat label="Linhas GAM" value={fmtNumber(stats.gam_rev_rows)} />
            <Stat label="Ruins" value={fmtNumber(stats.placements_bad)} highlight />
          </div>
        )}

        {/* Table */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
          <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
            <div>
              <h2 className="text-base font-semibold">Placements ruins</h2>
              <span className="text-xs text-zinc-500">
                {query.isLoading
                  ? "Carregando..."
                  : `${items.length} de ${stats?.placements_bad ?? 0} mostrando · ${selected.size} selecionados`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {isAdmin && items.length > 0 && (
                <button
                  type="button"
                  onClick={() => setConfirmOpen(true)}
                  disabled={selected.size === 0 || apply.isPending}
                  className="h-9 px-3 rounded-md bg-rose-600 text-zinc-50 text-sm font-medium hover:bg-rose-500 disabled:opacity-50 disabled:hover:bg-rose-600"
                >
                  {apply.isPending ? "Aplicando..." : `Aplicar exclusão (${selected.size})`}
                </button>
              )}
            </div>
          </header>
          {query.isError && (
            <div className="p-4 text-sm text-rose-400">
              {(query.error as Error).message}
            </div>
          )}
          {!query.isError && items.length === 0 && !query.isLoading && (
            <div className="p-6 text-center text-sm text-zinc-500">
              Nenhum placement ruim no filtro atual.
            </div>
          )}
          {items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
                  <tr>
                    {isAdmin && (
                      <th className="px-3 py-2 w-8">
                        <input
                          type="checkbox"
                          aria-label="Select all"
                          checked={items.length > 0 && items.every((it) => selected.has(it.key))}
                          onChange={(e) => {
                            const next = new Set(selected);
                            for (const it of items) {
                              if (e.target.checked) next.add(it.key);
                              else next.delete(it.key);
                            }
                            setSelected(next);
                          }}
                          className="accent-rose-500"
                        />
                      </th>
                    )}
                    <th className="text-left px-4 py-2 font-medium">Campanha / Landing page</th>
                    <th className="text-right px-3 py-2 font-medium" title="Custo atribuído pelo share de impressões">
                      Custo
                    </th>
                    <th className="text-right px-3 py-2 font-medium">Receita</th>
                    <th className="text-right px-3 py-2 font-medium">ROI</th>
                    <th className="text-right px-3 py-2 font-medium">Imp.</th>
                    <th className="text-right px-3 py-2 font-medium">Dias</th>
                    <th className="text-left px-3 py-2 font-medium">Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr
                      key={it.key}
                      className={`border-b border-zinc-800/50 last:border-0 hover:bg-zinc-900/50 ${
                        selected.has(it.key) ? "bg-rose-950/30" : ""
                      }`}
                    >
                      {isAdmin && (
                        <td className="px-3 py-2 w-8">
                          <input
                            type="checkbox"
                            checked={selected.has(it.key)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(it.key);
                              else next.delete(it.key);
                              setSelected(next);
                            }}
                            className="accent-rose-500"
                          />
                        </td>
                      )}
                      <td className="px-4 py-2">
                        <div className="text-xs text-zinc-500 truncate max-w-[280px]" title={it.campaign_name ?? ""}>
                          {it.campaign_name ?? `(camp ${it.campaign_id})`}
                        </div>
                        <div className="font-medium truncate max-w-[300px]" title={it.placement}>
                          {it.placement}
                        </div>
                      </td>
                      <td className="text-right px-3 py-2 tabular-nums">{fmtCurrency(it.cost)}</td>
                      <td className="text-right px-3 py-2 tabular-nums">{fmtCurrency(it.revenue)}</td>
                      <td
                        className={`text-right px-3 py-2 tabular-nums ${
                          it.roi <= -50 ? "text-rose-300" : "text-amber-300"
                        }`}
                      >
                        {fmtPercent(it.roi)}
                      </td>
                      <td className="text-right px-3 py-2 tabular-nums">{fmtNumber(it.impressions)}</td>
                      <td className="text-right px-3 py-2 tabular-nums">{it.days}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`text-[10px] uppercase tracking-wider rounded border px-1.5 py-0.5 ${REASON_STYLE[it.reason]}`}
                        >
                          {REASON_LABEL[it.reason]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Active exclusions */}
        {isAdmin && activeExclusions.length > 0 && (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
            <header className="px-4 py-3 border-b border-zinc-800">
              <h2 className="text-base font-semibold">Exclusões ativas</h2>
              <p className="text-xs text-zinc-500">
                Placements bloqueados no Google Ads. Use Desfazer pra remover o
                bloqueio se a exclusão foi um engano.
              </p>
            </header>
            <ul className="divide-y divide-zinc-800/50">
              {activeExclusions.map((e) => (
                <li key={e.id} className="px-4 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate max-w-[480px]" title={e.placement}>
                      {e.placement}
                    </div>
                    <div className="text-xs text-zinc-500">
                      {e.campaign_name ?? `camp ${e.campaign_id}`} · ROI no momento da
                      exclusão: {fmtPercent(e.snapshot_roi)} · {e.applied_at}
                      {e.error && (
                        <span className="text-rose-400 ml-2">⚠ {e.error.slice(0, 80)}</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Desfazer exclusão de ${e.placement}?`)) undo.mutate(e.id);
                    }}
                    disabled={undo.isPending}
                    className="h-8 px-2 rounded-md text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    Desfazer
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Apply result toast */}
        {applyResult && (
          <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-sm space-y-2">
            <div className="flex items-center justify-between">
              <span>
                <span className="text-emerald-300 font-medium">{applyResult.applied}</span>{" "}
                aplicado(s), {applyResult.rejected} rejeitado(s) pela trava,{" "}
                {applyResult.errors} erro(s).
              </span>
              <button
                type="button"
                onClick={() => setApplyResult(null)}
                className="text-xs text-zinc-500 hover:text-zinc-200"
              >
                Fechar
              </button>
            </div>
            {applyResult.rejected_items && applyResult.rejected_items.length > 0 && (
              <ul className="text-xs text-zinc-400 list-disc pl-5">
                {applyResult.rejected_items.slice(0, 8).map((r, i) => (
                  <li key={i}>
                    <span className="text-zinc-300">{r.placement}</span> — {r.rejected_reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Confirmation modal */}
        {confirmOpen && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-md w-full p-5 space-y-3">
              <h3 className="text-base font-semibold">Confirmar exclusão</h3>
              <p className="text-sm text-zinc-300">
                Você está prestes a bloquear <strong>{selected.size}</strong> placement(s) no
                Google Ads. O sistema vai re-conferir o ROI atual de cada um antes de aplicar —
                qualquer placement cujo ROI tenha melhorado pra acima de{" "}
                <span className="text-zinc-100">{maxRoi}%</span> será rejeitado.
              </p>
              <p className="text-xs text-zinc-500">
                Toda exclusão fica registrada e pode ser desfeita na seção "Exclusões ativas".
              </p>
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setConfirmOpen(false)}
                  className="h-9 px-3 rounded-md text-sm text-zinc-300 hover:bg-zinc-800"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => apply.mutate()}
                  disabled={apply.isPending}
                  className="h-9 px-3 rounded-md bg-rose-600 text-zinc-50 text-sm font-medium hover:bg-rose-500 disabled:opacity-50"
                >
                  {apply.isPending ? "Aplicando..." : "Sim, aplicar"}
                </button>
              </div>
              {apply.isError && (
                <p className="text-sm text-rose-400">{(apply.error as Error).message}</p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={highlight ? "text-rose-300 font-semibold" : "text-zinc-100"}>
        {value}
      </div>
    </div>
  );
}
