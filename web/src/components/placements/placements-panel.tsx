"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

export function PlacementsPanel({
  username,
  role,
}: {
  username: string;
  role?: string;
}) {
  const [preset, setPreset] = useState<DatePresetKey>("last_7_days");
  const [minCost, setMinCost] = useState(20);
  const [maxRoi, setMaxRoi] = useState(-10);
  const [reasonFilter, setReasonFilter] = useState<Item["reason"] | "all">("all");

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

  const items = (query.data?.items ?? []).filter((it) =>
    reasonFilter === "all" ? true : it.reason === reasonFilter,
  );

  const stats = query.data?.stats;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader username={username} role={role} />
      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Placements — preview de ruins</h1>
            <p className="text-sm text-zinc-400">
              Cruzamento de custo (Google Ads) com receita (GAM via UTM) por
              (campanha, placement). Esta tela é <span className="text-zinc-100">somente leitura</span> nesta versão —
              o botão Aplicar exclusão chega na próxima fase, com dupla checagem
              de segurança.
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
            <h2 className="text-base font-semibold">Placements ruins</h2>
            <span className="text-xs text-zinc-500">
              {query.isLoading
                ? "Carregando..."
                : `${items.length} de ${stats?.placements_bad ?? 0} mostrando`}
            </span>
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
                      className="border-b border-zinc-800/50 last:border-0 hover:bg-zinc-900/50"
                    >
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

        <p className="text-xs text-zinc-500">
          O botão <span className="text-zinc-300">Aplicar exclusão</span> chega na
          próxima fase. Antes de bloquear placements no Google Ads, o sistema
          vai re-conferir o ROI da última leitura — se tiver melhorado, não
          bloqueia.
        </p>
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
