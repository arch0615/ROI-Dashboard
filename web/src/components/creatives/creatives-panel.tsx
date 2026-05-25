"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { fmtCurrency, fmtNumber, fmtPercent } from "@/lib/format";
import { DATE_PRESETS, type DatePresetKey } from "@/lib/date-presets";
import { AppHeader } from "../app-header";

type Creative = {
  campaign_id: string;
  campaign_name: string | null;
  ad_id: string;
  ad_name: string | null;
  ad_type: string | null;
  status: string | null;
  resource_name: string | null;
  clicks: number;
  impressions: number;
  cost: number;
  revenue_attributed: number;
  profit: number;
  roi: number;
  diff_vs_campaign_pp: number;
  days: number;
  ctr: number;
};

type Campaign = {
  campaign_id: string;
  campaign_name: string | null;
  cost: number;
  revenue: number;
  profit: number;
  roi: number;
  creative_count: number;
  bad_count: number;
  creatives: Creative[];
};

type Preview = {
  stats: {
    period: { from: string; to: string };
    cfg: { min_cost: number; max_roi_diff_pp: number; min_days: number };
    creatives_analyzed: number;
    campaigns_with_data: number;
    creatives_bad: number;
  };
  bad: Creative[];
  campaigns: Campaign[];
};

type Pause = {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
  ad_id: string;
  ad_name: string | null;
  resource_name: string;
  snapshot_cost: number;
  snapshot_revenue: number;
  snapshot_roi: number;
  snapshot_diff_pp: number;
  snapshot_days: number;
  applied_at: string;
  undone_at: string | null;
  error: string | null;
};

export function CreativesPanel({ username, role }: { username: string; role?: string }) {
  const qc = useQueryClient();
  const isAdmin = role === "admin";
  const [preset, setPreset] = useState<DatePresetKey>("last_7_days");
  const [minCost, setMinCost] = useState(200);
  const [maxRoiDiff, setMaxRoiDiff] = useState(10);
  const [minDays, setMinDays] = useState(7);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applyResult, setApplyResult] = useState<{
    applied: number;
    rejected: number;
    errors: number;
    rejected_items?: Array<{ ad_name: string | null; rejected_reason: string }>;
  } | null>(null);

  const range = useMemo(() => {
    const p = DATE_PRESETS.find((d) => d.key === preset);
    return p ? p.range() : { from: "", to: "" };
  }, [preset]);

  const query = useQuery<Preview>({
    queryKey: ["creatives-preview", range.from, range.to, minCost, maxRoiDiff, minDays],
    queryFn: () => {
      const qs = new URLSearchParams({
        from: range.from,
        to: range.to,
        min_cost: String(minCost),
        max_roi_diff_pp: String(maxRoiDiff),
        min_days: String(minDays),
      });
      return api<Preview>(`/api/creatives/preview?${qs.toString()}`);
    },
  });

  const pausesQuery = useQuery<Pause[]>({
    queryKey: ["creative-pauses"],
    queryFn: () => api<Pause[]>(`/api/creatives/pauses`),
  });

  const apply = useMutation({
    mutationFn: () => {
      const items = (query.data?.bad ?? []).filter((cv) => selected.has(cv.ad_id));
      return api<{
        applied: number;
        rejected: number;
        errors: number;
        rejected_items: Array<{ ad_name: string | null; rejected_reason: string }>;
      }>(`/api/creatives/pause`, {
        method: "POST",
        body: JSON.stringify({
          items: items.map((cv) => ({
            campaign_id: cv.campaign_id,
            campaign_name: cv.campaign_name,
            ad_id: cv.ad_id,
            ad_name: cv.ad_name,
            resource_name: cv.resource_name,
          })),
          max_roi_diff_pp: maxRoiDiff,
          min_days: minDays,
          from: range.from,
          to: range.to,
        }),
      });
    },
    onSuccess: (data) => {
      setApplyResult(data);
      setSelected(new Set());
      setConfirmOpen(false);
      qc.invalidateQueries({ queryKey: ["creative-pauses"] });
      qc.invalidateQueries({ queryKey: ["creatives-preview"] });
    },
  });

  const undo = useMutation({
    mutationFn: (id: string) => api(`/api/creatives/pauses/${id}/undo`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["creative-pauses"] }),
  });

  useEffect(() => {
    setSelected(new Set());
  }, [range.from, range.to, minCost, maxRoiDiff, minDays]);

  const stats = query.data?.stats;
  const badList = query.data?.bad ?? [];
  const campaigns = query.data?.campaigns ?? [];
  const activePauses = pausesQuery.data ?? [];

  const toggleExpand = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader username={username} role={role} />
      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Criativos — pausar ruins</h1>
          <p className="text-sm text-zinc-400">
            Compara o ROI de cada criativo com o ROI médio da campanha. Custo do Ads vem por
            criativo (dimensão real); receita do GAM é alocada por click-share. Cada criativo
            cujo ROI esteja {maxRoiDiff} pp ou mais abaixo da campanha é candidato a pausar.
          </p>
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
                Custo mín (R$)
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
                Dias mín
              </span>
              <input
                type="number"
                value={minDays}
                onChange={(e) => setMinDays(Number(e.target.value) || 0)}
                className="h-9 w-24 rounded-md bg-zinc-950 border border-zinc-800 px-3"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] uppercase tracking-wider text-zinc-500">
                Dif. ROI mín (pp)
              </span>
              <input
                type="number"
                value={maxRoiDiff}
                onChange={(e) => setMaxRoiDiff(Number(e.target.value) || 0)}
                className="h-9 w-28 rounded-md bg-zinc-950 border border-zinc-800 px-3"
              />
            </label>
          </div>
        </section>

        {/* Stats */}
        {stats && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-xs grid grid-cols-2 md:grid-cols-4 gap-y-2 gap-x-6">
            <Stat label="Período" value={`${stats.period.from} → ${stats.period.to}`} />
            <Stat label="Criativos analisados" value={fmtNumber(stats.creatives_analyzed)} />
            <Stat label="Campanhas" value={fmtNumber(stats.campaigns_with_data)} />
            <Stat label="Candidatos a pausar" value={fmtNumber(stats.creatives_bad)} highlight />
          </div>
        )}

        {/* Per-campaign collapsible list */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
          <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
            <div>
              <h2 className="text-base font-semibold">Campanhas</h2>
              <span className="text-xs text-zinc-500">
                {query.isLoading
                  ? "Carregando..."
                  : `${campaigns.length} com dados · ${selected.size} criativos selecionados`}
              </span>
            </div>
            {isAdmin && badList.length > 0 && (
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={selected.size === 0 || apply.isPending}
                className="h-9 px-3 rounded-md bg-rose-600 text-zinc-50 text-sm font-medium hover:bg-rose-500 disabled:opacity-50"
              >
                {apply.isPending ? "Pausando..." : `Pausar criativos (${selected.size})`}
              </button>
            )}
          </header>
          {query.isError && (
            <div className="p-4 text-sm text-rose-400">{(query.error as Error).message}</div>
          )}
          {!query.isError && campaigns.length === 0 && !query.isLoading && (
            <div className="p-6 text-center text-sm text-zinc-500">
              Nenhuma campanha com dados de criativos no período.
            </div>
          )}
          <ul className="divide-y divide-zinc-800/50">
            {campaigns.map((c) => {
              const open = expanded.has(c.campaign_id);
              return (
                <li key={c.campaign_id}>
                  <button
                    type="button"
                    onClick={() => toggleExpand(c.campaign_id)}
                    className="w-full text-left px-4 py-3 hover:bg-zinc-900/50 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex items-center gap-3">
                      <span className="text-zinc-500 text-xs">{open ? "▼" : "▶"}</span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate max-w-[420px]">
                          {c.campaign_name ?? c.campaign_id}
                          {c.bad_count > 0 && (
                            <span className="ml-2 text-[10px] uppercase tracking-wider rounded bg-rose-950/60 text-rose-200 border border-rose-800 px-1.5 py-0.5">
                              {c.bad_count} ruim(ns)
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {c.creative_count} criativo(s) · cost {fmtCurrency(c.cost)} · rev{" "}
                          {fmtCurrency(c.revenue)} · ROI{" "}
                          <span className={c.roi < 0 ? "text-rose-300" : "text-emerald-300"}>
                            {fmtPercent(c.roi)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                  {open && (
                    <div className="px-4 pb-3 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-xs uppercase tracking-wider text-zinc-500">
                          <tr>
                            {isAdmin && <th className="w-8 px-2"></th>}
                            <th className="text-left px-3 py-2 font-medium">Criativo</th>
                            <th className="text-right px-2 py-2 font-medium">Impr.</th>
                            <th className="text-right px-2 py-2 font-medium">Clicks</th>
                            <th className="text-right px-2 py-2 font-medium">CTR</th>
                            <th className="text-right px-2 py-2 font-medium">Custo</th>
                            <th className="text-right px-2 py-2 font-medium">Receita</th>
                            <th className="text-right px-2 py-2 font-medium">ROI</th>
                            <th className="text-right px-2 py-2 font-medium" title="Diferença vs ROI da campanha (positivo = pior)">
                              Dif vs camp
                            </th>
                            <th className="text-left px-2 py-2 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.creatives.map((cv) => {
                            const isBad = badList.some((b) => b.ad_id === cv.ad_id);
                            const checked = selected.has(cv.ad_id);
                            return (
                              <tr
                                key={cv.ad_id}
                                className={`border-t border-zinc-800/50 hover:bg-zinc-900/30 ${
                                  checked ? "bg-rose-950/30" : ""
                                }`}
                              >
                                {isAdmin && (
                                  <td className="px-2 py-2 w-8">
                                    {isBad && cv.resource_name && (
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={(e) => {
                                          const next = new Set(selected);
                                          if (e.target.checked) next.add(cv.ad_id);
                                          else next.delete(cv.ad_id);
                                          setSelected(next);
                                        }}
                                        className="accent-rose-500"
                                      />
                                    )}
                                  </td>
                                )}
                                <td className="px-3 py-2">
                                  <div className="font-medium truncate max-w-[260px]" title={cv.ad_name ?? ""}>
                                    {cv.ad_name ?? `ad ${cv.ad_id}`}
                                  </div>
                                  <div className="text-xs text-zinc-500">{cv.ad_type}</div>
                                </td>
                                <td className="text-right px-2 py-2 tabular-nums">{fmtNumber(cv.impressions)}</td>
                                <td className="text-right px-2 py-2 tabular-nums">{fmtNumber(cv.clicks)}</td>
                                <td className="text-right px-2 py-2 tabular-nums">{cv.ctr.toFixed(2)}%</td>
                                <td className="text-right px-2 py-2 tabular-nums">{fmtCurrency(cv.cost)}</td>
                                <td className="text-right px-2 py-2 tabular-nums">{fmtCurrency(cv.revenue_attributed)}</td>
                                <td className={`text-right px-2 py-2 tabular-nums ${cv.roi < 0 ? "text-rose-300" : "text-emerald-300"}`}>
                                  {fmtPercent(cv.roi)}
                                </td>
                                <td className={`text-right px-2 py-2 tabular-nums ${cv.diff_vs_campaign_pp > 0 ? "text-rose-300" : "text-zinc-400"}`}>
                                  {cv.diff_vs_campaign_pp > 0 ? "+" : ""}
                                  {cv.diff_vs_campaign_pp.toFixed(1)}pp
                                </td>
                                <td className="px-2 py-2">
                                  <span className="text-[10px] uppercase tracking-wider rounded bg-zinc-800 text-zinc-300 px-1.5 py-0.5">
                                    {cv.status ?? "?"}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {/* Active pauses */}
        {isAdmin && activePauses.length > 0 && (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
            <header className="px-4 py-3 border-b border-zinc-800">
              <h2 className="text-base font-semibold">Criativos pausados</h2>
              <p className="text-xs text-zinc-500">Use Desfazer pra reativar.</p>
            </header>
            <ul className="divide-y divide-zinc-800/50">
              {activePauses.map((p) => (
                <li key={p.id} className="px-4 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate max-w-[420px]">
                      {p.ad_name ?? `ad ${p.ad_id}`}
                    </div>
                    <div className="text-xs text-zinc-500">
                      {p.campaign_name ?? p.campaign_id} · ROI {fmtPercent(p.snapshot_roi)} · dif{" "}
                      {p.snapshot_diff_pp.toFixed(1)}pp · {p.applied_at}
                      {p.error && (
                        <span className="text-rose-400 ml-2">⚠ {p.error.slice(0, 80)}</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Reativar ${p.ad_name ?? p.ad_id}?`)) undo.mutate(p.id);
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

        {applyResult && (
          <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-sm space-y-2">
            <div className="flex items-center justify-between">
              <span>
                <span className="text-emerald-300 font-medium">{applyResult.applied}</span>{" "}
                pausado(s), {applyResult.rejected} rejeitado(s) pela trava, {applyResult.errors}{" "}
                erro(s).
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
                    <span className="text-zinc-300">{r.ad_name ?? "(sem nome)"}</span> —{" "}
                    {r.rejected_reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {confirmOpen && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-md w-full p-5 space-y-3">
              <h3 className="text-base font-semibold">Confirmar pausa</h3>
              <p className="text-sm text-zinc-300">
                Você está prestes a pausar <strong>{selected.size}</strong> criativo(s) no Google
                Ads. O sistema vai re-conferir o ROI vs campanha de cada um antes de pausar —
                qualquer um cuja diferença tenha caído pra menos de{" "}
                <span className="text-zinc-100">{maxRoiDiff}pp</span> será rejeitado.
              </p>
              <p className="text-xs text-zinc-500">
                Toda pausa fica registrada e pode ser desfeita em "Criativos pausados".
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
                  {apply.isPending ? "Pausando..." : "Sim, pausar"}
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
      <div className={highlight ? "text-rose-300 font-semibold" : "text-zinc-100"}>{value}</div>
    </div>
  );
}
