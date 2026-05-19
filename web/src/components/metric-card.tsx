import type { ReactNode } from "react";

type Variant = "default" | "success" | "danger" | "primary";

const variantClasses: Record<Variant, string> = {
  default: "bg-zinc-900 border-zinc-800",
  primary: "bg-indigo-600/20 border-indigo-500/40",
  success: "bg-emerald-600/20 border-emerald-500/40",
  danger: "bg-rose-600/20 border-rose-500/40",
};

export function MetricCard({
  label,
  value,
  icon,
  variant = "default",
  hint,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  variant?: Variant;
  hint?: string;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border p-5 transition-colors ${variantClasses[variant]}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5 min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{label}</p>
          <p className="text-2xl md:text-3xl font-bold tracking-tight truncate">{value}</p>
          {hint && <p className="text-xs text-zinc-500">{hint}</p>}
        </div>
        {icon && (
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-zinc-300">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
