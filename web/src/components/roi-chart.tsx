"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "@/lib/api";
import { fmtCurrency, fmtPercent } from "@/lib/format";

type TimeseriesRow = {
  date: string;
  spend: number;
  revenue: number;
  profit: number;
  clicks: number;
  impressions: number;
  roi: number;
  roas: number;
};

function buildQuery(from: string, to: string) {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return params.toString();
}

function TooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload: TimeseriesRow }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-900 p-2 text-xs space-y-0.5 shadow-lg">
      <div className="font-medium text-zinc-200">{label}</div>
      <div className="text-zinc-400">
        ROI: <span className="text-zinc-100 font-medium">{fmtPercent(row.roi)}</span>
      </div>
      <div className="text-zinc-400">
        Gasto: <span className="text-zinc-100">{fmtCurrency(row.spend)}</span>
      </div>
      <div className="text-zinc-400">
        Receita: <span className="text-zinc-100">{fmtCurrency(row.revenue)}</span>
      </div>
      <div className="text-zinc-400">
        Lucro: <span className="text-zinc-100">{fmtCurrency(row.profit)}</span>
      </div>
    </div>
  );
}

export function RoiChart({ from, to }: { from: string; to: string }) {
  const qs = buildQuery(from, to);
  const query = useQuery<TimeseriesRow[]>({
    queryKey: ["timeseries", from, to],
    queryFn: () => api<TimeseriesRow[]>(`/api/dashboard/timeseries${qs ? `?${qs}` : ""}`),
  });

  const data = (query.data ?? []).map((r) => ({ ...r, dateShort: r.date.slice(5) }));

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-base font-semibold">ROI ao longo do tempo</h2>
        <span className="text-xs text-zinc-500">
          {query.isLoading
            ? "Carregando..."
            : data.length > 0
              ? `${data.length} dia(s)`
              : ""}
        </span>
      </div>

      <div className="h-[260px]">
        {query.isError ? (
          <div className="h-full flex items-center justify-center text-sm text-rose-400">
            Erro: {(query.error as Error).message}
          </div>
        ) : data.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-zinc-500">
            Sem dados ainda. Sincronize uma conta para ver o gráfico.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
              <defs>
                <linearGradient id="roiFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#a5b4fc" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#a5b4fc" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="dateShort" stroke="#71717a" fontSize={11} />
              <YAxis
                stroke="#71717a"
                fontSize={11}
                tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              />
              <Tooltip content={<TooltipContent />} />
              <Area
                type="monotone"
                dataKey="roi"
                stroke="#a5b4fc"
                strokeWidth={2}
                fill="url(#roiFill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
