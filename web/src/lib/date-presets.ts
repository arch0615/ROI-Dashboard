// Local-timezone date helpers. We avoid UTC to keep "Hoje" coherent near
// midnight in the user's locale.
const toISO = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

export type DatePresetKey =
  | "today"
  | "yesterday"
  | "last_3_days"
  | "last_7_days"
  | "last_15_days"
  | "last_30_days";

export const DATE_PRESETS: Array<{
  key: DatePresetKey;
  label: string;
  range: () => { from: string; to: string };
}> = [
  { key: "today", label: "Hoje", range: () => ({ from: toISO(new Date()), to: toISO(new Date()) }) },
  { key: "yesterday", label: "Ontem", range: () => ({ from: toISO(daysAgo(1)), to: toISO(daysAgo(1)) }) },
  // Google Ads convention: "Last N days" excludes today
  { key: "last_3_days", label: "Últimos 3 dias", range: () => ({ from: toISO(daysAgo(3)), to: toISO(daysAgo(1)) }) },
  { key: "last_7_days", label: "Últimos 7 dias", range: () => ({ from: toISO(daysAgo(7)), to: toISO(daysAgo(1)) }) },
  { key: "last_15_days", label: "Últimos 15 dias", range: () => ({ from: toISO(daysAgo(15)), to: toISO(daysAgo(1)) }) },
  { key: "last_30_days", label: "Últimos 30 dias", range: () => ({ from: toISO(daysAgo(30)), to: toISO(daysAgo(1)) }) },
];

export function presetFromRange(from: string, to: string): DatePresetKey | null {
  for (const p of DATE_PRESETS) {
    const r = p.range();
    if (r.from === from && r.to === to) return p.key;
  }
  return null;
}
