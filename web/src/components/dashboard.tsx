"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { fmtCurrency, fmtPercent, fmtNumber, fmtDecimal } from "@/lib/format";
import { FilterBar, EMPTY_FILTERS, type DashboardFilters } from "./filter-bar";
import { MetricCard } from "./metric-card";
import { AppHeader } from "./app-header";
import { CampaignsTable } from "./campaigns-table";

type Overview = {
  range: { from: string | null; to: string | null };
  totals: {
    spend: number;
    revenue: number;
    profit: number;
    roi: number;
    roas: number;
    clicks: number;
    conversions: number;
    impressions: number;
  };
  coverage: { campaigns_with_data: number; days_with_data: number };
};

export function Dashboard({ username }: { username: string }) {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<DashboardFilters>(EMPTY_FILTERS);

  const params = new URLSearchParams();
  if (filters.fromDate) params.set("from", filters.fromDate);
  if (filters.toDate) params.set("to", filters.toDate);
  const qs = params.toString();

  const overview = useQuery<Overview>({
    queryKey: ["overview", filters.fromDate, filters.toDate],
    queryFn: () => api<Overview>(`/api/dashboard/overview${qs ? `?${qs}` : ""}`),
  });

  const recalc = useMutation({
    mutationFn: () =>
      api<{ rows_updated: number; revenue_allocated: number }>(`/api/sync/rollup`, {
        method: "POST",
        body: JSON.stringify(
          filters.fromDate || filters.toDate
            ? { from: filters.fromDate || undefined, to: filters.toDate || undefined }
            : {},
        ),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  const t = overview.data?.totals;
  const cov = overview.data?.coverage;
  const noData = !overview.isLoading && cov && cov.days_with_data === 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader username={username} />

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <FilterBar filters={filters} onChange={setFilters} />
          </div>
          <button
            type="button"
            onClick={() => recalc.mutate()}
            disabled={recalc.isPending}
            className="h-9 px-3 mt-[40px] rounded-md border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            title="Re-calcula receita/profit/ROI a partir dos dados já sincronizados"
          >
            {recalc.isPending
              ? "Recalculando..."
              : recalc.isSuccess
                ? `${recalc.data?.rows_updated ?? 0} linha(s) atualizadas`
                : "Recalcular"}
          </button>
        </div>

        {noData && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-400">
            Sem dados ainda. As métricas aparecem assim que o primeiro sync do
            Google Ads + GAM rodar (M3).
          </div>
        )}

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <MetricCard
            label="Gasto"
            value={fmtCurrency(t?.spend ?? 0)}
            variant="default"
            hint={cov ? `${cov.days_with_data} dia(s) com dados` : undefined}
          />
          <MetricCard
            label="Receita"
            value={fmtCurrency(t?.revenue ?? 0)}
            variant="default"
          />
          <MetricCard
            label="Lucro"
            value={fmtCurrency(t?.profit ?? 0)}
            variant={t && t.profit > 0 ? "success" : t && t.profit < 0 ? "danger" : "default"}
          />
          <MetricCard
            label="ROI"
            value={t ? fmtPercent(t.roi) : "—"}
            variant={t && t.roi >= 10 ? "success" : t && t.roi < 0 ? "danger" : "primary"}
            hint={t ? `ROAS ${fmtDecimal(t.roas, 2)}x` : undefined}
          />
        </section>

        <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <MetricCard label="Impressões" value={fmtNumber(t?.impressions ?? 0)} />
          <MetricCard label="Clicks" value={fmtNumber(t?.clicks ?? 0)} />
          <MetricCard
            label="Conversões"
            value={fmtDecimal(t?.conversions ?? 0, 0)}
          />
        </section>

        {overview.isError && (
          <div className="rounded-xl border border-rose-800 bg-rose-950/50 p-4 text-sm text-rose-200">
            Erro ao carregar métricas: {(overview.error as Error).message}
          </div>
        )}

        <CampaignsTable from={filters.fromDate} to={filters.toDate} />
      </main>
    </div>
  );
}
