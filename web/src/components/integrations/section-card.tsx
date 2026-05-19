import type { ReactNode } from "react";

export function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {subtitle && <p className="text-xs text-zinc-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

export const inputClass =
  "h-9 rounded-md bg-zinc-950 border border-zinc-800 px-3 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600";

export const buttonClass =
  "h-9 px-3 rounded-md bg-zinc-100 text-zinc-950 text-sm font-medium disabled:opacity-50 hover:bg-white";

export const ghostButtonClass =
  "h-8 px-2 rounded-md text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800";
