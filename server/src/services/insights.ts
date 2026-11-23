/**
 * Key number details: what sits behind each dashboard number, as headline
 * figures, chart series and tables the app (or any API client) can draw.
 *
 *   GET /api/v1/kpis/{metric}
 *   metric = sales | forecast | accuracy | cover | overstock | protected | at_risk
 */
import { query, queryOne } from "../db";
import { addDays, listForecasts, todayYmd } from "./forecasts";
import { latestRunDate } from "./inventory";
import { getForecastSettings } from "./settings";
import { invalid } from "./errors";

export const KPI_METRICS = ["sales", "forecast", "accuracy", "cover", "overstock", "protected", "at_risk"] as const;
export type KpiMetric = (typeof KPI_METRICS)[number];

type Unit = "money" | "units" | "percent" | "days" | "count";
interface Headline { label: string; value: number | null; unit: Unit; sub?: string; change_pct?: number | null }
interface Series { name: string; style?: "actual" | "forecast" | "reference"; points: { x: string; y: number }[] }
interface Chart { type: "line" | "bar" | "hbar"; title: string; caption?: string; unit: Unit; series: Series[] }
interface Column { key: string; label: string; unit?: Unit | "text" | "date" }
interface Table { title: string; caption?: string; columns: Column[]; rows: Record<string, any>[] }

export interface KpiDetail {
  metric: KpiMetric;
  title: string;
  summary: string;
  currency: string;
  run_date: string | null;
  headline: Headline[];
  charts: Chart[];
  tables: Table[];
}

const r0 = (v: number) => Math.round(v);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
const ymd = (d: any) => String(d).slice(0, 10);

/** Every day from start (inclusive) for n days, so charts have no gaps. */
function days(start: string, n: number) {
  return Array.from({ length: n }, (_, i) => addDays(start, i));
}

async function allForecasts(storeId: number) {
  const first = await listForecasts(storeId, { limit: 250, page: 1 });
  let rows = first.data;
  for (let p = 2; (p - 1) * 250 < first.total; p++) rows = rows.concat((await listForecasts(storeId, { limit: 250, page: p })).data);
  return rows;
}

export async function getKpiDetail(storeId: number, metric: string): Promise<KpiDetail> {
  if (!(KPI_METRICS as readonly string[]).includes(metric))
    throw invalid("invalid_metric", `metric must be one of: ${KPI_METRICS.join(", ")}.`, "metric");
  const store = await queryOne("SELECT currency FROM stores WHERE id=$1", [storeId]);
  const currency = store?.currency || "USD";
  const runDate = await latestRunDate(storeId);
  const base = { metric: metric as KpiMetric, currency, run_date: runDate };
  switch (metric as KpiMetric) {
    case "sales": return { ...base, ...(await sales(storeId)) };
    case "forecast": return { ...base, ...(await forecast(storeId, runDate)) };
    case "accuracy": return { ...base, ...(await accuracy(storeId, runDate)) };
    case "cover": return { ...base, ...(await cover(storeId)) };
    case "overstock": return { ...base, ...(await overstock(storeId)) };
    case "protected": return { ...base, ...(await protectedRevenue(storeId)) };
    case "at_risk": return { ...base, ...(await atRisk(storeId)) };
  }
}

/* ---------- sales ---------- */

async function sales(storeId: number) {
  const today = todayYmd();
  // Same windows as the dashboard tile: the last 30 days include today (sale_date >= today - 30).
  const start90 = addDays(today, -90);
  const daily = await query(
    `SELECT sale_date, SUM(units_sold)::int AS units, COALESCE(SUM(revenue),0)::float AS revenue
       FROM daily_sales WHERE store_id=$1 AND sale_date >= $2 GROUP BY 1`,
    [storeId, start90]
  );
  const byDay = new Map(daily.map((d: any) => [ymd(d.sale_date), d]));
  const series = days(start90, 91).map((d) => ({ d, units: Number(byDay.get(d)?.units ?? 0), revenue: Number(byDay.get(d)?.revenue ?? 0) }));
  const last30 = series.slice(-31);
  const prev30 = series.slice(-61, -31);
  const sum = (a: typeof series, k: "units" | "revenue") => a.reduce((s, x) => s + x[k], 0);
  const rev30 = sum(last30, "revenue"), revPrev = sum(prev30, "revenue");
  const units30 = sum(last30, "units"), unitsPrev = sum(prev30, "units");
  const best = [...last30].sort((a, b) => b.revenue - a.revenue)[0];

  // Weekly revenue, last 13 weeks (Monday weeks).
  const weekly = await query(
    `SELECT date_trunc('week', sale_date)::date AS w, COALESCE(SUM(revenue),0)::float AS revenue, SUM(units_sold)::int AS units
       FROM daily_sales WHERE store_id=$1 AND sale_date >= date_trunc('week', CURRENT_DATE) - interval '12 weeks'
      GROUP BY 1 ORDER BY 1`,
    [storeId]
  );

  const top = await query(
    `SELECT v.id, v.title, v.sku,
            COALESCE(SUM(ds.revenue) FILTER (WHERE ds.sale_date >= CURRENT_DATE - 30),0)::float AS revenue,
            COALESCE(SUM(ds.units_sold) FILTER (WHERE ds.sale_date >= CURRENT_DATE - 30),0)::int AS units,
            COALESCE(SUM(ds.revenue) FILTER (WHERE ds.sale_date < CURRENT_DATE - 30),0)::float AS revenue_prev
       FROM daily_sales ds JOIN variants v ON v.id = ds.variant_id
      WHERE ds.store_id=$1 AND ds.sale_date >= CURRENT_DATE - 60
      GROUP BY v.id, v.title, v.sku
     HAVING COALESCE(SUM(ds.revenue) FILTER (WHERE ds.sale_date >= CURRENT_DATE - 30),0) > 0
      ORDER BY revenue DESC LIMIT 10`,
    [storeId]
  );
  const byCategory = await query(
    `SELECT COALESCE(NULLIF(p.product_type,''), 'Uncategorised') AS category, COALESCE(SUM(ds.revenue),0)::float AS revenue
       FROM daily_sales ds JOIN variants v ON v.id = ds.variant_id JOIN products p ON p.id = v.product_id
      WHERE ds.store_id=$1 AND ds.sale_date >= CURRENT_DATE - 30
      GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    [storeId]
  );

  const change = pct(rev30, revPrev);
  return {
    title: "Sales, last 30 days",
    summary:
      rev30 > 0
        ? `Revenue was ${r0(rev30).toLocaleString()} over the last 30 days${change != null ? `, ${change >= 0 ? "up" : "down"} ${Math.abs(change)}% on the 30 days before` : ""}. Top product: ${top[0]?.title ?? "none"}.`
        : "No sales in the last 30 days.",
    headline: [
      { label: "Revenue", value: r2(rev30), unit: "money" as Unit, change_pct: change, sub: "vs previous 30 days" },
      { label: "Units sold", value: units30, unit: "units" as Unit, change_pct: pct(units30, unitsPrev) },
      { label: "Average a day", value: r2(rev30 / 30), unit: "money" as Unit, sub: `${r1(units30 / 30)} units a day` },
      { label: "Best day", value: best ? r2(best.revenue) : null, unit: "money" as Unit, sub: best && best.revenue > 0 ? best.d : "no sales" },
      { label: "Average price", value: units30 > 0 ? r2(rev30 / units30) : null, unit: "money" as Unit, sub: "revenue per unit" },
      { label: "Previous 30 days", value: r2(revPrev), unit: "money" as Unit, sub: `${unitsPrev.toLocaleString()} units` },
    ],
    charts: [
      {
        type: "line" as const, title: "Revenue a day, last 3 months", unit: "money" as Unit,
        caption: "Each point is one day's revenue, up to yesterday.",
        series: [{ name: "Revenue", style: "actual" as const, points: series.slice(0, -1).map((s) => ({ x: s.d, y: r2(s.revenue) })) }],
      },
      {
        type: "bar" as const, title: "Revenue a week", unit: "money" as Unit,
        series: [{ name: "Revenue", style: "actual" as const, points: weekly.map((w: any) => ({ x: ymd(w.w), y: r2(Number(w.revenue)) })) }],
      },
      ...(byCategory.length > 1
        ? [{ type: "hbar" as const, title: "Revenue by category, 30 days", unit: "money" as Unit, series: [{ name: "Revenue", points: byCategory.map((c: any) => ({ x: c.category, y: r2(Number(c.revenue)) })) }] }]
        : []),
    ],
    tables: [
      {
        title: "Top products, 30 days",
        columns: [
          { key: "title", label: "Product", unit: "text" as const },
          { key: "units", label: "Units", unit: "units" as Unit },
          { key: "revenue", label: "Revenue", unit: "money" as Unit },
          { key: "change_pct", label: "Change", unit: "percent" as Unit },
        ],
        rows: top.map((t: any) => ({ variant_id: Number(t.id), title: t.title, sku: t.sku, units: Number(t.units), revenue: r2(Number(t.revenue)), share_pct: rev30 > 0 ? r1((100 * Number(t.revenue)) / rev30) : null, change_pct: pct(Number(t.revenue), Number(t.revenue_prev)) })),
      },
    ],
  };
}

/* ---------- forecast ---------- */

async function forecast(storeId: number, runDate: string | null) {
  const today = todayYmd();
  if (!runDate) return empty("Forecast, next 30 days", "No forecast yet.");
  const fc = await query(
    `SELECT (e->>'d')::date AS d, SUM((e->>'y')::numeric)::float AS units, SUM((e->>'y')::numeric * COALESCE(v.price,0))::float AS revenue
       FROM forecasts f JOIN variants v ON v.id = f.variant_id CROSS JOIN LATERAL jsonb_array_elements(f.daily_forecast) e
      WHERE f.store_id=$1 AND f.run_date=$2 GROUP BY 1`,
    [storeId, runDate]
  );
  const fcMap = new Map(fc.map((r: any) => [ymd(r.d), r]));
  const past = await query(
    `SELECT sale_date, SUM(units_sold)::int AS units, COALESCE(SUM(revenue),0)::float AS revenue
       FROM daily_sales WHERE store_id=$1 AND sale_date >= $2 GROUP BY 1`,
    [storeId, addDays(today, -30)]
  );
  const pastMap = new Map(past.map((r: any) => [ymd(r.sale_date), r]));
  const ahead = days(today, 56);
  const next30 = ahead.slice(0, 30).map((d) => fcMap.get(d) ?? { units: 0, revenue: 0 });
  const units30 = next30.reduce((s, x: any) => s + Number(x.units), 0);
  const rev30 = next30.reduce((s, x: any) => s + Number(x.revenue), 0);
  const lastUnits = past.reduce((s: number, x: any) => s + Number(x.units), 0);
  const lastRev = past.reduce((s: number, x: any) => s + Number(x.revenue), 0);

  const top = await query(
    `SELECT v.id, v.title, v.sku, v.price, d.y AS units
       FROM forecasts f JOIN variants v ON v.id = f.variant_id
       CROSS JOIN LATERAL (SELECT SUM((e->>'y')::numeric)::float AS y FROM jsonb_array_elements(f.daily_forecast) WITH ORDINALITY t(e, i) WHERE i <= 30) d
      WHERE f.store_id=$1 AND f.run_date=$2 AND d.y > 0 ORDER BY d.y * COALESCE(v.price,0) DESC LIMIT 10`,
    [storeId, runDate]
  );

  return {
    title: "Forecast, next 30 days",
    summary: `The forecast expects ${r0(units30).toLocaleString()} units over the next 30 days, against ${lastUnits.toLocaleString()} sold in the last 30.`,
    headline: [
      { label: "Expected revenue", value: r2(rev30), unit: "money" as Unit, change_pct: pct(rev30, lastRev), sub: "vs last 30 days sold" },
      { label: "Expected units", value: r0(units30), unit: "units" as Unit, change_pct: pct(units30, lastUnits) },
      { label: "Units a day", value: r1(units30 / 30), unit: "units" as Unit, sub: `${r1(lastUnits / 30)} a day sold recently` },
      { label: "Next 8 weeks", value: r0(ahead.reduce((s, d) => s + Number((fcMap.get(d) as any)?.units ?? 0), 0)), unit: "units" as Unit, sub: "units expected" },
    ],
    charts: [
      {
        type: "line" as const, title: "Units a day: sold, then forecast", unit: "units" as Unit,
        caption: "Grey is the last 30 days sold; blue is the forecast for the next 8 weeks.",
        series: [
          { name: "Sold", style: "actual" as const, points: days(addDays(today, -30), 30).map((d) => ({ x: d, y: Number(pastMap.get(d)?.units ?? 0) })) },
          { name: "Forecast", style: "forecast" as const, points: ahead.map((d) => ({ x: d, y: r1(Number((fcMap.get(d) as any)?.units ?? 0)) })) },
        ],
      },
    ],
    tables: [
      {
        title: "Biggest sellers expected, 30 days",
        columns: [
          { key: "title", label: "Product", unit: "text" as const },
          { key: "units", label: "Units", unit: "units" as Unit },
          { key: "revenue", label: "Revenue", unit: "money" as Unit },
        ],
        rows: top.map((t: any) => ({ variant_id: Number(t.id), title: t.title, sku: t.sku, units: r0(Number(t.units)), revenue: r2(Number(t.units) * Number(t.price ?? 0)) })),
      },
    ],
  };
}

/* ---------- accuracy ---------- */

async function accuracy(storeId: number, runDate: string | null) {
  if (!runDate) return empty("Forecast accuracy", "No forecast yet.");
  const weighted = `SUM(accuracy * GREATEST(rate_14d, 0.01)) / NULLIF(SUM(GREATEST(rate_14d, 0.01)), 0)`;
  const trend = await query(
    `SELECT run_date, ${weighted} AS a, COUNT(*)::int AS n FROM stock_risk
      WHERE store_id=$1 AND accuracy IS NOT NULL AND run_date >= CURRENT_DATE - 90 GROUP BY run_date ORDER BY run_date`,
    [storeId]
  );
  const now = trend.length ? Number(trend[trend.length - 1].a) : null;
  const first = trend.length > 1 ? Number(trend[0].a) : null;
  const rows = await query(
    `SELECT sr.variant_id, v.title, v.sku, sr.accuracy, sr.rate_14d, sr.confidence, f.model_used
       FROM stock_risk sr JOIN variants v ON v.id = sr.variant_id
       LEFT JOIN forecasts f ON f.variant_id = sr.variant_id AND f.run_date = sr.run_date
      WHERE sr.store_id=$1 AND sr.run_date=$2 AND sr.accuracy IS NOT NULL
      ORDER BY sr.rate_14d DESC NULLS LAST`,
    [storeId, runDate]
  );
  const bands = [
    { x: "80% or better", min: 0.8, max: 2 },
    { x: "60 to 80%", min: 0.6, max: 0.8 },
    { x: "40 to 60%", min: 0.4, max: 0.6 },
    { x: "Below 40%", min: -99, max: 0.4 },
  ].map((b) => ({ x: b.x, y: rows.filter((r: any) => Number(r.accuracy) >= b.min && Number(r.accuracy) < b.max).length }));
  const toRow = (r: any) => ({ variant_id: Number(r.variant_id), title: r.title, sku: r.sku, accuracy_pct: r1(Math.max(0, Number(r.accuracy)) * 100), rate: String(r1(Number(r.rate_14d ?? 0))), model: r.model_used, confidence: r.confidence });
  const sorted = [...rows].sort((a: any, b: any) => Number(b.accuracy) - Number(a.accuracy));
  return {
    title: "Forecast accuracy",
    summary:
      now != null
        ? `Over the last 4 weeks the forecast was ${r1(Math.max(0, now) * 100)}% accurate: each product's forecast for each of those weeks was compared with what really sold that week (100% minus the weighted absolute error), weighted by how much each product sells. Slow, irregular sellers are the hardest to forecast and pull this down.`
        : "Accuracy needs a few weeks of regular sales to measure.",
    headline: [
      { label: "Accuracy now", value: now != null ? r1(Math.max(0, now) * 100) : null, unit: "percent" as Unit, sub: "weekly, last 4 weeks" },
      { label: "Change, 90 days", value: now != null && first != null ? r1((now - first) * 100) : null, unit: "percent" as Unit, sub: "points" },
      { label: "Products measured", value: rows.length, unit: "count" as Unit, sub: "with enough history" },
      { label: "80% or better", value: bands[0].y, unit: "count" as Unit, sub: "products" },
    ],
    charts: [
      ...(trend.length > 1
        ? [{ type: "line" as const, title: "Accuracy by forecast run", unit: "percent" as Unit, series: [{ name: "Accuracy", style: "actual" as const, points: trend.map((t: any) => ({ x: ymd(t.run_date), y: r1(Math.max(0, Number(t.a)) * 100) })) }] }]
        : []),
      { type: "hbar" as const, title: "Products by accuracy", unit: "count" as Unit, series: [{ name: "Products", points: bands }] },
    ],
    tables: [
      { title: "Most accurate", columns: accCols, rows: sorted.slice(0, 5).map(toRow) },
      { title: "Least accurate", caption: "Often slow or irregular sellers; a higher safety stock covers the uncertainty.", columns: accCols, rows: sorted.slice(-5).reverse().map(toRow) },
    ],
  };
}
const accCols: Column[] = [
  { key: "title", label: "Product", unit: "text" },
  { key: "rate", label: "A day", unit: "text" },
  { key: "accuracy_pct", label: "Accuracy", unit: "percent" },
];

/* ---------- days of cover ---------- */

async function cover(storeId: number) {
  const rows = (await allForecasts(storeId)).filter((r) => r.status !== "untracked" && r.status !== "no_sales" && r.cover_days != null);
  const sorted = [...rows].sort((a, b) => a.cover_days! - b.cover_days!);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)].cover_days : null;
  const bands = [
    { x: "Under 7 days", min: 0, max: 7 },
    { x: "7 to 14", min: 7, max: 14 },
    { x: "14 to 30", min: 14, max: 30 },
    { x: "30 to 60", min: 30, max: 60 },
    { x: "60 to 90", min: 60, max: 90 },
    { x: "Over 90", min: 90, max: 1e9 },
  ].map((b) => ({ x: b.x, y: rows.filter((r) => r.cover_days! >= b.min && r.cover_days! < b.max).length }));
  const shortOfLead = rows.filter((r) => r.cover_days! <= r.lead_time_days).length;
  const toRow = (r: any) => ({ variant_id: r.variant_id, title: r.title, sku: r.sku, cover_days: r.cover_days, lead_time_days: r.lead_time_days, runs_out_on: r.runs_out_on, status: r.status });
  return {
    title: "Days of cover",
    summary: median != null ? `Half of your products have more than ${r0(median)} days of stock at the forecast rate. ${shortOfLead} run out before a new order could arrive.` : "No products with stock and demand to measure.",
    headline: [
      { label: "Median cover", value: median != null ? r0(median) : null, unit: "days" as Unit, sub: "across products" },
      { label: "Shorter than lead time", value: shortOfLead, unit: "count" as Unit, sub: "products" },
      { label: "Under 14 days", value: bands[0].y + bands[1].y, unit: "count" as Unit, sub: "products" },
      { label: "Over 90 days", value: bands[5].y, unit: "count" as Unit, sub: "products" },
    ],
    charts: [{ type: "hbar" as const, title: "Products by days of cover", unit: "count" as Unit, series: [{ name: "Products", points: bands }] }],
    tables: [
      { title: "Least cover", columns: coverCols, rows: sorted.slice(0, 8).map(toRow) },
      { title: "Most cover", columns: coverCols, rows: sorted.slice(-5).reverse().map(toRow) },
    ],
  };
}
const coverCols: Column[] = [
  { key: "title", label: "Product", unit: "text" },
  { key: "cover_days", label: "Cover", unit: "days" },
  { key: "lead_time_days", label: "Lead", unit: "days" },
  { key: "runs_out_on", label: "Runs out", unit: "date" },
];

/* ---------- overstock ---------- */

async function overstock(storeId: number) {
  const settings = await getForecastSettings(storeId);
  const rows = (await allForecasts(storeId))
    .map((r) => {
      if (r.on_hand == null || !r.forecast_per_day || r.forecast_per_day <= 0) return null;
      const excess = r.on_hand - r.forecast_per_day * settings.overstock_days;
      if (excess <= 0) return null;
      const unit = r.unit_cost ?? r.price ?? 0;
      return { variant_id: r.variant_id, title: r.title, sku: r.sku, category: r.category || "Uncategorised", on_hand: r.on_hand, excess_units: r0(excess), value: r2(excess * unit), cover_days: r.cover_days, at_cost: r.unit_cost != null };
    })
    .filter(Boolean) as any[];
  rows.sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, r) => s + r.value, 0);
  const units = rows.reduce((s, r) => s + r.excess_units, 0);
  const cats = new Map<string, number>();
  for (const r of rows) cats.set(r.category, (cats.get(r.category) ?? 0) + r.value);
  return {
    title: "Cash in overstock",
    summary: rows.length
      ? `${r0(units).toLocaleString()} units are beyond ${settings.overstock_days} days of demand, tying up ${r0(total).toLocaleString()} at cost. ${rows[0].title} holds the most.`
      : `Nothing is stocked beyond ${settings.overstock_days} days of demand.`,
    headline: [
      { label: "Cash tied up", value: r2(total), unit: "money" as Unit, sub: rows.some((r) => !r.at_cost) ? "at cost where known, else price" : "at cost" },
      { label: "Extra units", value: r0(units), unit: "units" as Unit, sub: `beyond ${settings.overstock_days} days of demand` },
      { label: "Products", value: rows.length, unit: "count" as Unit, sub: "with stock past the window" },
    ],
    charts: [
      { type: "hbar" as const, title: "Cash in overstock by product", unit: "money" as Unit, series: [{ name: "Value", points: rows.slice(0, 8).map((r) => ({ x: r.title, y: r.value })) }] },
      ...(cats.size > 1 ? [{ type: "hbar" as const, title: "By category", unit: "money" as Unit, series: [{ name: "Value", points: [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([x, y]) => ({ x, y: r2(y) })) }] }] : []),
    ],
    tables: [
      {
        title: "Overstocked products", caption: "Consider a promotion or pausing orders for these.",
        columns: [
          { key: "title", label: "Product", unit: "text" as const },
          { key: "excess_units", label: "Extra", unit: "units" as Unit },
          { key: "cover_days", label: "Cover", unit: "days" as Unit },
          { key: "value", label: "Cash", unit: "money" as Unit },
        ],
        rows: rows.slice(0, 15),
      },
    ],
  };
}

/* ---------- revenue protected ---------- */

async function protectedRevenue(storeId: number) {
  const rows = await query(
    `SELECT a.id, a.type, a.title, a.revenue_at_risk::float AS revenue, a.resolved_at, a.variant_id, v.title AS product, v.sku, po.number AS po_number
       FROM inventory_alerts a LEFT JOIN variants v ON v.id = a.variant_id LEFT JOIN purchase_orders po ON po.id = a.resolved_by_po_id
      WHERE a.store_id=$1 AND a.status='resolved' AND a.resolved_by_po_id IS NOT NULL AND a.resolved_at > now() - interval '90 days'
      ORDER BY a.resolved_at DESC`,
    [storeId]
  );
  const total = rows.reduce((s: number, r: any) => s + Number(r.revenue ?? 0), 0);
  const weekly = await query(
    `SELECT date_trunc('week', resolved_at)::date AS w, COALESCE(SUM(revenue_at_risk),0)::float AS v
       FROM inventory_alerts WHERE store_id=$1 AND status='resolved' AND resolved_by_po_id IS NOT NULL AND resolved_at > now() - interval '90 days'
      GROUP BY 1 ORDER BY 1`,
    [storeId]
  );
  const open = await queryOne(
    "SELECT COUNT(*)::int AS n, COALESCE(SUM(revenue_at_risk),0)::float AS v FROM inventory_alerts WHERE store_id=$1 AND status='open'",
    [storeId]
  );
  return {
    title: "Revenue protected",
    summary: rows.length
      ? `Purchase orders closed ${rows.length} stock ${rows.length === 1 ? "alert" : "alerts"} in the last 90 days, protecting about ${r0(total).toLocaleString()} of sales that were at risk.`
      : "No alerts have been closed by a purchase order in the last 90 days yet. When an order arrives in time for an at-risk product, its sales show up here.",
    headline: [
      { label: "Protected, 90 days", value: r2(total), unit: "money" as Unit, sub: "sales that were at risk" },
      { label: "Alerts fixed by orders", value: rows.length, unit: "count" as Unit },
      { label: "Still at risk", value: r2(Number(open?.v ?? 0)), unit: "money" as Unit, sub: `${open?.n ?? 0} open alerts` },
    ],
    charts: weekly.length
      ? [{ type: "bar" as const, title: "Protected each week", unit: "money" as Unit, series: [{ name: "Protected", style: "actual" as const, points: weekly.map((w: any) => ({ x: ymd(w.w), y: r2(Number(w.v)) })) }] }]
      : [],
    tables: [
      {
        title: "Alerts fixed by purchase orders",
        columns: [
          { key: "title", label: "Product", unit: "text" as const },
          { key: "po_number", label: "Order", unit: "text" as const },
          { key: "revenue", label: "Protected", unit: "money" as Unit },
        ],
        rows: rows.slice(0, 20).map((r: any) => ({ variant_id: r.variant_id != null ? Number(r.variant_id) : null, title: r.product ?? r.title, sku: r.sku, po_number: r.po_number, revenue: r2(Number(r.revenue ?? 0)), resolved_at: r.resolved_at })),
      },
    ],
  };
}

/* ---------- revenue at risk ---------- */

async function atRisk(storeId: number) {
  const rows = (await allForecasts(storeId)).filter((r) => r.revenue_at_risk > 0).sort((a, b) => b.revenue_at_risk - a.revenue_at_risk);
  const total = rows.reduce((s, r) => s + r.revenue_at_risk, 0);
  const now = rows.filter((r) => r.status === "reorder_now");
  const watch = rows.filter((r) => r.status === "watch");
  const sum = (a: typeof rows) => r2(a.reduce((s, r) => s + r.revenue_at_risk, 0));
  return {
    title: "Revenue at risk",
    summary: rows.length
      ? `${rows.length} products could lose about ${r0(total).toLocaleString()} of sales over the next 8 weeks if nothing more is ordered. ${now.length} need an order now.`
      : "No sales are at risk over the next 8 weeks.",
    headline: [
      { label: "All products", value: r2(total), unit: "money" as Unit, sub: "next 8 weeks" },
      { label: "Reorder now", value: sum(now), unit: "money" as Unit, sub: `${now.length} products` },
      { label: "Watch", value: sum(watch), unit: "money" as Unit, sub: `${watch.length} products` },
    ],
    charts: [{ type: "hbar" as const, title: "Revenue at risk by product", unit: "money" as Unit, series: [{ name: "At risk", points: rows.slice(0, 8).map((r) => ({ x: r.title, y: r2(r.revenue_at_risk) })) }] }],
    tables: [
      {
        title: "Products at risk",
        columns: [
          { key: "title", label: "Product", unit: "text" as const },
          { key: "runs_out_on", label: "Runs out", unit: "date" as const },
          { key: "suggested_quantity", label: "Order", unit: "units" as Unit },
          { key: "revenue_at_risk", label: "At risk", unit: "money" as Unit },
        ],
        rows: rows.slice(0, 20).map((r) => ({ variant_id: r.variant_id, title: r.title, sku: r.sku, status: r.status, runs_out_on: r.runs_out_on, suggested_quantity: r.suggested_quantity, revenue_at_risk: r2(r.revenue_at_risk) })),
      },
    ],
  };
}

function empty(title: string, summary: string) {
  return { title, summary, headline: [], charts: [], tables: [] };
}
