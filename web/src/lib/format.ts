// Currency conventions match the original tracker:
// - Spend (Google Ads) is BRL native
// - Revenue (GAM) is USD native, converted to BRL by the backend before
//   landing in daily_metrics.profit
export const fmtBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 2,
  }).format(v ?? 0);

export const fmtUSD = (v: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.abs(v ?? 0) > 0 && Math.abs(v ?? 0) < 0.01 ? 6 : 2,
    maximumFractionDigits: Math.abs(v ?? 0) > 0 && Math.abs(v ?? 0) < 0.01 ? 6 : 2,
  }).format(v ?? 0);

export const fmtCurrency = fmtBRL;

export const fmtPercent = (v: number) =>
  `${v >= 0 ? "+" : ""}${(v ?? 0).toFixed(2)}%`;

export const fmtNumber = (v: number) =>
  new Intl.NumberFormat("pt-BR").format(v ?? 0);

export const fmtDecimal = (v: number, digits = 2) =>
  new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v ?? 0);
