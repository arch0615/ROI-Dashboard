"use client";

import { DATE_PRESETS, presetFromRange, type DatePresetKey } from "@/lib/date-presets";

export type DashboardFilters = {
  fromDate: string;
  toDate: string;
};

export const EMPTY_FILTERS: DashboardFilters = { fromDate: "", toDate: "" };

export function FilterBar({
  filters,
  onChange,
}: {
  filters: DashboardFilters;
  onChange: (next: DashboardFilters) => void;
}) {
  const activePreset = presetFromRange(filters.fromDate, filters.toDate);

  const applyPreset = (key: DatePresetKey) => {
    const preset = DATE_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    const r = preset.range();
    onChange({ fromDate: r.from, toDate: r.to });
  };

  const isDirty = filters.fromDate !== "" || filters.toDate !== "";

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500 pr-1">
          Período
        </div>
        {DATE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => applyPreset(p.key)}
            className={`h-8 px-3 rounded-md text-xs font-medium transition-colors ${
              activePreset === p.key
                ? "bg-zinc-100 text-zinc-950"
                : "border border-zinc-700 text-zinc-200 hover:bg-zinc-800"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wider text-zinc-500">De</label>
          <input
            type="date"
            value={filters.fromDate}
            onChange={(e) => onChange({ ...filters, fromDate: e.target.value })}
            className="h-9 w-[150px] rounded-md bg-zinc-950 border border-zinc-800 px-3 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wider text-zinc-500">Até</label>
          <input
            type="date"
            value={filters.toDate}
            onChange={(e) => onChange({ ...filters, toDate: e.target.value })}
            className="h-9 w-[150px] rounded-md bg-zinc-950 border border-zinc-800 px-3 text-sm"
          />
        </div>
        {isDirty && (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="h-9 px-3 rounded-md text-xs text-zinc-400 hover:bg-zinc-800"
          >
            Limpar
          </button>
        )}
      </div>
    </div>
  );
}
