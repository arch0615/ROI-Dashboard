"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { fmtCurrency, fmtDecimal, fmtNumber, fmtPercent } from "@/lib/format";

type CampaignAggregate = {
  id: string;
  google_account_id: string;
  campaign_id: string;
  name: string;
  status: string;
  channel_type: string;
  budget_micros: number | null;
  target_cpa_micros: number | null;
  spend: number;
  revenue: number;
  profit: number;
  clicks: number;
  conversions: number;
  impressions: number;
  roi: number;
  roas: number;
  ecpm: number;
  days_with_data: number;
};

type SortKey = "spend" | "revenue" | "profit" | "roi" | "roas" | "ecpm" | "clicks" | "conversions";
type Sort = { key: SortKey; dir: "asc" | "desc" } | null;

const COLUMNS: Array<{ key: SortKey; label: string; format: (n: number) => string }> = [
  { key: "spend", label: "Gasto", format: fmtCurrency },
  { key: "revenue", label: "Receita", format: fmtCurrency },
  { key: "profit", label: "Lucro", format: fmtCurrency },
  { key: "roi", label: "ROI", format: fmtPercent },
  { key: "roas", label: "ROAS", format: (n) => `${fmtDecimal(n, 2)}x` },
  { key: "ecpm", label: "eCPM", format: fmtCurrency },
  { key: "clicks", label: "Clicks", format: fmtNumber },
  { key: "conversions", label: "Conv.", format: (n) => fmtDecimal(n, 0) },
];

export function CampaignsTable({ from, to }: { from: string; to: string }) {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();

  const query = useQuery<CampaignAggregate[]>({
    queryKey: ["campaigns-aggregate", from, to],
    queryFn: () => api<CampaignAggregate[]>(`/api/campaigns/aggregate${qs ? `?${qs}` : ""}`),
  });

  const [sort, setSort] = useState<Sort>({ key: "roi", dir: "desc" });

  const sorted = useMemo(() => {
    const data = query.data ?? [];
    if (!sort) return data;
    const arr = [...data];
    const mult = sort.dir === "desc" ? -1 : 1;
    arr.sort((a, b) => {
      const av = Number(a[sort.key] ?? 0);
      const bv = Number(b[sort.key] ?? 0);
      if (av === bv) return 0;
      return av < bv ? -1 * mult : 1 * mult;
    });
    return arr;
  }, [query.data, sort]);

  const handleSort = (key: SortKey) => {
    setSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: "desc" };
      if (cur.dir === "desc") return { key, dir: "asc" };
      return null;
    });
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900">
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <h2 className="text-base font-semibold">Campanhas</h2>
        <span className="text-xs text-zinc-500">
          {query.isLoading
            ? "Carregando..."
            : query.data
              ? `${query.data.length} campanha(s)`
              : ""}
        </span>
      </header>

      {query.isError && (
        <div className="p-4 text-sm text-rose-400">
          Erro ao carregar campanhas: {(query.error as Error).message}
        </div>
      )}

      {!query.isError && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Campanha</th>
                {COLUMNS.map((c) => {
                  const active = sort?.key === c.key;
                  return (
                    <th
                      key={c.key}
                      className={`text-right px-3 py-2 font-medium ${
                        active ? "text-zinc-100" : ""
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => handleSort(c.key)}
                        className="inline-flex items-center gap-1 hover:text-zinc-100"
                      >
                        {c.label}
                        <span className="text-[10px]">
                          {active ? (sort?.dir === "desc" ? "▼" : "▲") : "↕"}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && !query.isLoading && (
                <tr>
                  <td
                    colSpan={COLUMNS.length + 1}
                    className="text-center py-8 text-sm text-zinc-500"
                  >
                    Nenhuma campanha sincronizada ainda.
                  </td>
                </tr>
              )}
              {sorted.map((c) => (
                <tr
                  key={c.id}
                  className="border-b border-zinc-800/50 last:border-0 hover:bg-zinc-900/50"
                >
                  <td className="px-4 py-2">
                    <div className="font-medium truncate max-w-[280px]" title={c.name}>
                      {c.name}
                    </div>
                    <div className="text-xs text-zinc-500 flex items-center gap-2">
                      <span>{c.channel_type}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          c.status === "enabled" || c.status === "ENABLED"
                            ? "bg-emerald-900/50 text-emerald-300"
                            : "bg-zinc-800 text-zinc-400"
                        }`}
                      >
                        {c.status}
                      </span>
                      {c.days_with_data === 0 && (
                        <span className="text-zinc-600">(sem métricas)</span>
                      )}
                    </div>
                  </td>
                  {COLUMNS.map((col) => {
                    const v = c[col.key];
                    let color = "";
                    if (col.key === "profit") {
                      color = v > 0 ? "text-emerald-300" : v < 0 ? "text-rose-300" : "";
                    }
                    if (col.key === "roi") {
                      color = v >= 10 ? "text-emerald-300" : v < 0 ? "text-rose-300" : "";
                    }
                    return (
                      <td key={col.key} className={`text-right px-3 py-2 tabular-nums ${color}`}>
                        {col.format(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
