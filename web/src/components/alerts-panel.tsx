"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

type Severity = "critical" | "warning" | "info";
type Category = "bad_campaign" | "opportunity" | "risk" | "bad_placement";

type Alert = {
  id: string;
  severity: Severity;
  category: Category;
  campaign_id: string | null;
  placement_key: string | null;
  title: string;
  message: string | null;
  metric_snapshot: Record<string, number | string | null> | null;
  acknowledged: boolean;
  created_at: string;
};

const SEVERITY_STYLES: Record<Severity, { ring: string; chip: string; label: string }> = {
  critical: { ring: "border-rose-800", chip: "bg-rose-950/60 text-rose-200", label: "Crítico" },
  warning: { ring: "border-amber-800", chip: "bg-amber-950/60 text-amber-200", label: "Aviso" },
  info: { ring: "border-indigo-800", chip: "bg-indigo-950/60 text-indigo-200", label: "Info" },
};

const CATEGORY_LABELS: Record<Category, string> = {
  bad_campaign: "Campanha em prejuízo",
  opportunity: "Oportunidade",
  risk: "Risco",
  bad_placement: "Placement fraco",
};

export function AlertsPanel() {
  const qc = useQueryClient();
  const query = useQuery<Alert[]>({
    queryKey: ["alerts"],
    queryFn: () => api<Alert[]>("/api/alerts"),
  });
  const ack = useMutation({
    mutationFn: (id: string) => api(`/api/alerts/${id}/ack`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });

  const alerts = query.data ?? [];

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900">
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <h2 className="text-base font-semibold">Alertas</h2>
        <span className="text-xs text-zinc-500">
          {query.isLoading
            ? "Carregando..."
            : alerts.length === 0
              ? "Nada pra resolver"
              : `${alerts.length} aberto(s)`}
        </span>
      </header>

      {query.isError && (
        <div className="p-4 text-sm text-rose-400">
          Erro ao carregar alertas: {(query.error as Error).message}
        </div>
      )}

      {!query.isError && alerts.length === 0 && !query.isLoading && (
        <div className="p-6 text-center text-sm text-zinc-500">
          Nenhum alerta ativo. Os alertas são reavaliados após cada sincronização.
        </div>
      )}

      <ul className="divide-y divide-zinc-800/50">
        {alerts.map((a) => {
          const style = SEVERITY_STYLES[a.severity];
          return (
            <li key={a.id} className={`px-4 py-3 border-l-2 ${style.ring}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 ${style.chip}`}>
                      {style.label}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                      {CATEGORY_LABELS[a.category]}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-zinc-100">{a.title}</p>
                  {a.message && <p className="text-xs text-zinc-400">{a.message}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => ack.mutate(a.id)}
                  disabled={ack.isPending && ack.variables === a.id}
                  className="shrink-0 h-8 px-2 rounded-md text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {ack.isPending && ack.variables === a.id ? "..." : "Resolver"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
