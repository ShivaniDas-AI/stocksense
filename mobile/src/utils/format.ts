/** Formatting helpers shared by the screens. */

export function money(v: number | string | null | undefined, currency = "USD"): string {
  const n = Number(v ?? 0);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency} ${Math.round(n).toLocaleString()}`;
  }
}

export function num(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "-";
  return Number(v).toLocaleString();
}

export function rate(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "-";
  const n = Number(v);
  return n < 1 ? n.toFixed(2) : n.toFixed(1);
}

/** Dates arrive as "YYYY-MM-DD"; show them as local calendar dates. */
export function dateLabel(v: string | null | undefined): string {
  if (!v) return "-";
  const [y, m, d] = String(v).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function days(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "-";
  return `${Math.round(Number(v))} d`;
}

/** Percentage change from prev to cur, or null when there is no baseline. */
export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 100);
}
