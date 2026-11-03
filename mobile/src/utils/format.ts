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

/** "just now", "5 min ago", "2 h ago" from a timestamp in ms. */
export function ago(ts: number | undefined): string {
  if (!ts) return "just now";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Add days to a YYYY-MM-DD date string; returns YYYY-MM-DD. */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** Whole days from today to a YYYY-MM-DD date (negative if past). */
export function daysUntil(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** Percentage change from prev to cur, or null when there is no baseline. */
export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 100);
}
