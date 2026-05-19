"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AppHeader } from "../app-header";

type RulesConfig = {
  min_roi_pct: number;
  max_loss_roi_pct: number;
  boost_roi_pct: number;
  min_spend_threshold: number;
  budget_increase_pct: number;
  revenue_share_pct: number;
  auto_analysis_days: number;
  auto_scale_interval_days: number;
  auto_stoploss_days: number;
  auto_cpa_review_days: number;
  auto_standby_enter_days: number;
  auto_standby_max_days: number;
  auto_scale_min_roi: number;
  auto_scale_budget_pct: number;
  auto_stoploss_min_roi: number;
  auto_stoploss_min_cost: number;
  auto_cpa_up_pct: number;
  auto_cpa_down_pct: number;
  auto_standby_roi_low: number;
  auto_standby_roi_high: number;
  auto_standby_exit_roi: number;
  auto_pause_enabled: boolean;
  auto_boost_enabled: boolean;
};

const inputClass =
  "h-9 w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 text-sm focus:outline-none focus:border-zinc-600";

function Field({
  label,
  hint,
  value,
  step = "0.01",
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  step?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-zinc-200">{label}</label>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className={inputClass}
      />
      {hint && <p className="text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4 rounded-lg border border-zinc-800 p-3 cursor-pointer hover:bg-zinc-900/50">
      <div>
        <p className="font-medium text-sm">{label}</p>
        <p className="text-xs text-zinc-500">{hint}</p>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-zinc-100"
      />
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">{title}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{children}</div>
    </div>
  );
}

export function RulesPanel({ username }: { username: string }) {
  const qc = useQueryClient();
  const query = useQuery<RulesConfig>({
    queryKey: ["rules"],
    queryFn: () => api<RulesConfig>("/api/rules"),
  });
  const [form, setForm] = useState<RulesConfig | null>(null);
  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);

  const save = useMutation({
    mutationFn: (body: RulesConfig) =>
      api<RulesConfig>("/api/rules", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (data) => {
      qc.setQueryData(["rules"], data);
    },
  });

  const set = <K extends keyof RulesConfig>(k: K, v: RulesConfig[K]) =>
    setForm((prev) => (prev ? { ...prev, [k]: v } : prev));

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader username={username} />
      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <div>
          <h2 className="text-lg font-semibold">Regras do algoritmo</h2>
          <p className="text-sm text-zinc-400 mt-0.5">
            Defina os limites que disparam alertas e ações automáticas.
          </p>
        </div>

        {!form && <p className="text-sm text-zinc-500">Carregando...</p>}

        {form && (
          <div className="space-y-8 rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            <Section title="ROI e Limites">
              <Field
                label="ROI mínimo aceitável (%)"
                hint="Abaixo disso, vira aviso."
                value={form.min_roi_pct}
                onChange={(v) => set("min_roi_pct", v)}
              />
              <Field
                label="Limite de prejuízo: ROI máx. negativo (%)"
                hint="Atinge esse patamar → pausa (se ativada)."
                value={form.max_loss_roi_pct}
                onChange={(v) => set("max_loss_roi_pct", v)}
              />
              <Field
                label="ROI para aumento de orçamento (%)"
                hint="Acima disso, sugere boost."
                value={form.boost_roi_pct}
                onChange={(v) => set("boost_roi_pct", v)}
              />
              <Field
                label="Gasto mínimo para avaliar (R$)"
                hint="Abaixo disso, ignora a campanha."
                value={form.min_spend_threshold}
                onChange={(v) => set("min_spend_threshold", v)}
              />
              <Field
                label="% de aumento de orçamento sugerido"
                hint="Aplicado quando há boost."
                value={form.budget_increase_pct}
                onChange={(v) => set("budget_increase_pct", v)}
              />
              <Field
                label="Rev share do publisher (%)"
                hint="Quanto a rede fica. Padrão GAM: 6,5%. Afeta receita líquida e ROI."
                value={form.revenue_share_pct}
                onChange={(v) => set("revenue_share_pct", v)}
              />
            </Section>

            <Section title="Automação — Janelas (dias)">
              <Field
                label="Dias de análise"
                hint="Janela usada pelo algoritmo de automação."
                step="1"
                value={form.auto_analysis_days}
                onChange={(v) => set("auto_analysis_days", Math.round(v))}
              />
              <Field
                label="Intervalo entre escaladas (dias)"
                hint="Cooldown após aumentar orçamento."
                step="1"
                value={form.auto_scale_interval_days}
                onChange={(v) => set("auto_scale_interval_days", Math.round(v))}
              />
              <Field
                label="Dias para stop-loss"
                hint="Dias seguidos com ROI ruim antes de pausar."
                step="1"
                value={form.auto_stoploss_days}
                onChange={(v) => set("auto_stoploss_days", Math.round(v))}
              />
              <Field
                label="Dias entre revisões de CPA"
                hint="Cooldown para ajustar target CPA."
                step="1"
                value={form.auto_cpa_review_days}
                onChange={(v) => set("auto_cpa_review_days", Math.round(v))}
              />
              <Field
                label="Dias para entrar em standby"
                hint="Tempo em baixo rendimento antes de standby."
                step="1"
                value={form.auto_standby_enter_days}
                onChange={(v) => set("auto_standby_enter_days", Math.round(v))}
              />
              <Field
                label="Dias máximos em standby"
                hint="Limite antes de forçar pausa."
                step="1"
                value={form.auto_standby_max_days}
                onChange={(v) => set("auto_standby_max_days", Math.round(v))}
              />
            </Section>

            <Section title="Automação — Limiares">
              <Field
                label="ROI mínimo para escalar (%)"
                value={form.auto_scale_min_roi}
                onChange={(v) => set("auto_scale_min_roi", v)}
              />
              <Field
                label="% de aumento na escala"
                value={form.auto_scale_budget_pct}
                onChange={(v) => set("auto_scale_budget_pct", v)}
              />
              <Field
                label="ROI stop-loss (%)"
                hint="Abaixo disso, pausa (negativo)."
                value={form.auto_stoploss_min_roi}
                onChange={(v) => set("auto_stoploss_min_roi", v)}
              />
              <Field
                label="Gasto mínimo stop-loss (R$)"
                value={form.auto_stoploss_min_cost}
                onChange={(v) => set("auto_stoploss_min_cost", v)}
              />
              <Field
                label="% aumento CPA"
                value={form.auto_cpa_up_pct}
                onChange={(v) => set("auto_cpa_up_pct", v)}
              />
              <Field
                label="% redução CPA"
                value={form.auto_cpa_down_pct}
                onChange={(v) => set("auto_cpa_down_pct", v)}
              />
              <Field
                label="ROI baixo standby (%)"
                value={form.auto_standby_roi_low}
                onChange={(v) => set("auto_standby_roi_low", v)}
              />
              <Field
                label="ROI alto standby (%)"
                value={form.auto_standby_roi_high}
                onChange={(v) => set("auto_standby_roi_high", v)}
              />
              <Field
                label="ROI para sair do standby (%)"
                value={form.auto_standby_exit_roi}
                onChange={(v) => set("auto_standby_exit_roi", v)}
              />
            </Section>

            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
                Modo de execução
              </h3>
              <ToggleRow
                label="Pausa automática"
                hint="Quando ROI fica abaixo do limite de prejuízo, pausa sozinho."
                checked={form.auto_pause_enabled}
                onChange={(v) => set("auto_pause_enabled", v)}
              />
              <ToggleRow
                label="Aumento automático de orçamento"
                hint="Recomendado deixar desligado — você aprova manualmente."
                checked={form.auto_boost_enabled}
                onChange={(v) => set("auto_boost_enabled", v)}
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-zinc-800">
              {save.isSuccess && !save.isPending && (
                <span className="text-xs text-emerald-400">Salvo.</span>
              )}
              {save.isError && (
                <span className="text-xs text-rose-400">
                  {(save.error as Error).message}
                </span>
              )}
              <button
                type="button"
                onClick={() => save.mutate(form)}
                disabled={save.isPending}
                className="h-9 px-4 rounded-md bg-zinc-100 text-zinc-950 text-sm font-medium hover:bg-white disabled:opacity-50"
              >
                {save.isPending ? "Salvando..." : "Salvar configurações"}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
