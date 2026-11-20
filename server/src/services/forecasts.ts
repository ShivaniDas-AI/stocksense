/**
 * Forecasts in the user guide's terms (chapters 4, 5 and 15): status
 * (reorder_now / watch / healthy / overstocked / no_sales), rate per day over
 * 14 days, cover, run-out date, reorder point, suggested order, revenue at
 * risk; and per variant the daily series, stock curve and ordering rules.
 */
import { query, queryOne } from "../db";
import { getForecastSettings, zForServiceLevel } from "./settings";
import { boolField, intField, invalid, notFound, numField, onlyFields } from "./errors";
import { demandShares, ensureDefaultLocation, getLocation, shareFor } from "./locations";
import { latestRunDate, queueForecast } from "./inventory";

export const STATUSES = ["reorder_now", "watch", "healthy", "overstocked", "no_sales", "untracked"] as const;
export type Status = (typeof STATUSES)[number];

const n = (v: any) => (v === null || v === undefined ? null : Number(v));
const r1 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

export function addDays(ymd: string, days: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const todayYmd = () => new Date().toISOString().slice(0, 10);

/** Status from the worker, or derived from the older risk level for rows written before it existed. */
export const STATUS_SQL = `COALESCE(sr.status, CASE sr.risk_level
  WHEN 'critical' THEN 'reorder_now' WHEN 'low_stock' THEN 'reorder_now'
  WHEN 'healthy' THEN 'healthy' WHEN 'overstocked' THEN 'overstocked'
  WHEN 'no_demand' THEN 'no_sales' ELSE sr.risk_level END)`;

/* ---------------- daily series ---------------- */

export interface DayPoint { date: string; units: number; lo: number; hi: number }

/**
 * Daily demand from the latest forecast, extended past its 56-day horizon at
 * the average of its last 28 days, so lead time + coverage always fits.
 */
export function demandSeries(daily: any[], start: string, days: number, avg: number): DayPoint[] {
  const pts: DayPoint[] = (daily || []).map((p: any) => ({
    date: p.d,
    units: Number(p.y) || 0,
    lo: p.lo != null ? Number(p.lo) : Math.max(0, (Number(p.y) || 0) * 0.6),
    hi: p.hi != null ? Number(p.hi) : (Number(p.y) || 0) * 1.4,
  }));
  const byDate = new Map(pts.map((p) => [p.date, p]));
  const tail = pts.slice(-28);
  const tailAvg = tail.length ? tail.reduce((a, p) => a + p.units, 0) / tail.length : avg;
  const out: DayPoint[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    out.push(byDate.get(date) ?? { date, units: tailAvg, lo: tailAvg * 0.6, hi: tailAvg * 1.4 });
  }
  return out;
}

const sumUnits = (pts: DayPoint[], from: number, to: number) => pts.slice(from, to).reduce((a, p) => a + p.units, 0);

/** Standard deviation of daily units sold over the last 90 days (zero-filled). */
export async function demandStdDev(variantId: number): Promise<{ std: number; mean: number; days: number }> {
  const rows = await query(
    `SELECT d::date AS day, COALESCE(ds.units_sold, 0) AS units
       FROM generate_series(CURRENT_DATE - 90, CURRENT_DATE - 1, interval '1 day') d
       LEFT JOIN daily_sales ds ON ds.variant_id = $1 AND ds.sale_date = d::date`,
    [variantId]
  );
  const xs = rows.map((r: any) => Number(r.units));
  const mean = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(xs.length - 1, 1);
  return { std: Math.sqrt(v), mean, days: xs.length };
}

/* ---------------- variant context ---------------- */

/** Everything about one variant the forecast page and reorder screen need. */
export async function loadVariantContext(storeId: number, variantId: number) {
  const v = await queryOne(
    `SELECT v.*, p.title AS product_title, p.image_url, p.vendor, p.product_type,
            vs.supplier_id AS resolved_supplier_id, vs.supplier_source, vs.lead_time_days AS effective_lead_time,
            vs.lead_time_source, vs.lead_time_stddev, vs.on_order, vs.in_draft, vs.next_expected_at
       FROM variants v JOIN products p ON p.id = v.product_id
       JOIN variant_supply vs ON vs.variant_id = v.id
      WHERE v.id=$1 AND v.store_id=$2`,
    [variantId, storeId]
  );
  if (!v) throw notFound("product variant", variantId);
  const runDate = await latestRunDate(storeId);
  const risk = runDate
    ? await queryOne(`SELECT sr.*, ${STATUS_SQL} AS status_out FROM stock_risk sr WHERE sr.variant_id=$1 AND sr.run_date=$2`, [variantId, runDate])
    : null;
  const fc = await queryOne(
    "SELECT run_date, model_used, daily_forecast, avg_daily_demand FROM forecasts WHERE variant_id=$1 ORDER BY run_date DESC LIMIT 1",
    [variantId]
  );
  const daily = fc ? (typeof fc.daily_forecast === "string" ? JSON.parse(fc.daily_forecast) : fc.daily_forecast) : [];
  const settings = await getForecastSettings(storeId);
  return { v, risk, fc, daily, settings, runDate };
}

/* ---------------- quantity calculation (chapter 6 step 2, chapter 15) ---------------- */

export interface QuantityInputs {
  lead_time_days: number;
  coverage_days: number;
  case_pack: number;
  min_order_qty: number;
}

export function computeQuantity(opts: {
  series: DayPoint[];
  onHand: number;
  onOrder: number;
  inputs: QuantityInputs;
  demandStd: number;
  leadTimeStd: number;
  serviceLevel: number;
  minSafetyStock: number;
}) {
  const { series, inputs } = opts;
  const LT = inputs.lead_time_days;
  const leadDemand = sumUnits(series, 0, LT);
  const coverDemand = sumUnits(series, LT, LT + inputs.coverage_days);
  const d = LT ? leadDemand / LT : 0;
  const z = zForServiceLevel(opts.serviceLevel);
  // Safety stock = z x sqrt(LT x daily variation^2 + daily demand^2 x lead time variation^2)
  const statSS = z * Math.sqrt(LT * opts.demandStd ** 2 + d ** 2 * opts.leadTimeStd ** 2);
  const safety = Math.max(statSS, opts.minSafetyStock || 0);
  const stockToHave = leadDemand + coverDemand + safety;
  const have = Math.max(opts.onHand, 0) + opts.onOrder;
  const shortBy = Math.max(stockToHave - have, 0);
  let qty = Math.ceil(shortBy - 1e-9);
  const raisedToMinimum = qty > 0 && qty < inputs.min_order_qty;
  if (qty > 0) qty = Math.max(qty, inputs.min_order_qty);
  const beforePack = qty;
  if (qty > 0 && inputs.case_pack > 1) qty = Math.ceil(qty / inputs.case_pack) * inputs.case_pack;
  return {
    suggested_quantity: qty,
    reorder_point: Math.ceil(leadDemand + safety),
    breakdown: {
      sold_during_lead_time: r1(leadDemand),
      lead_time_days: LT,
      forecast_per_day: r2(d),
      sold_during_coverage: r1(coverDemand),
      coverage_days: inputs.coverage_days,
      safety_stock: r1(safety),
      safety_stock_basis: statSS >= (opts.minSafetyStock || 0) ? "calculated" : "product_minimum",
      service_level: opts.serviceLevel,
      stock_to_have: r1(stockToHave),
      on_hand: Math.max(opts.onHand, 0),
      on_order: opts.onOrder,
      short_by: r1(shortBy),
      raised_to_minimum: raisedToMinimum ? inputs.min_order_qty : null,
      rounded_to_case_pack: inputs.case_pack > 1 && qty !== beforePack ? inputs.case_pack : null,
      case_pack: inputs.case_pack,
      min_order_qty: inputs.min_order_qty,
    },
  };
}

/** First day stock reaches zero walking the daily forecast, with on-order stock landing on its date. */
export function walkStock(series: DayPoint[], onHand: number, arrivals: { date: string; qty: number }[], pick: "units" | "lo" | "hi" = "units") {
  let stock = Math.max(onHand, 0);
  const curve: { date: string; stock: number }[] = [];
  let outIdx: number | null = stock <= 0 ? 0 : null;
  for (let i = 0; i < series.length; i++) {
    for (const a of arrivals) if (a.date === series[i].date) stock += a.qty;
    stock -= series[i][pick];
    curve.push({ date: series[i].date, stock: Math.round(Math.max(stock, 0) * 10) / 10 });
    if (outIdx === null && stock <= 0) outIdx = i + 1;
  }
  return { curve, runsOutInDays: outIdx };
}

/* ---------------- list (GET /forecasts) ---------------- */

export async function listForecasts(
  storeId: number,
  opts: { status?: string[]; location_id?: number; q?: string; limit?: number; page?: number; sort?: string }
) {
  const runDate = await latestRunDate(storeId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 250);
  const page = Math.max(opts.page ?? 1, 1);
  if (!runDate) return { run_date: null, location_id: opts.location_id ?? null, data: [] as ReturnType<typeof forecastRow>[], page, limit, total: 0, has_more: false, counts: {} as Record<string, number> };
  const settings = await getForecastSettings(storeId);

  const bad = opts.status?.find((s) => !(STATUSES as readonly string[]).includes(s));
  if (bad) throw invalid("invalid_status", `Unknown status '${bad}'. Use any of: ${STATUSES.join(", ")}.`, "status");

  const rows = await query(
    `SELECT sr.*, ${STATUS_SQL} AS status_out, v.sku, v.title, v.price, v.cost, p.vendor, p.product_type, p.image_url,
            vs.supplier_id AS resolved_supplier_id, s.name AS supplier_name, vs.on_order AS live_on_order,
            vs.lead_time_days AS live_lead_time, f.avg_daily_demand, f.model_used
       FROM stock_risk sr
       JOIN variants v ON v.id = sr.variant_id
       JOIN products p ON p.id = v.product_id
       JOIN variant_supply vs ON vs.variant_id = v.id
       LEFT JOIN suppliers s ON s.id = vs.supplier_id
       LEFT JOIN forecasts f ON f.variant_id = sr.variant_id AND f.run_date = sr.run_date
      WHERE sr.store_id=$1 AND sr.run_date=$2
        ${opts.q ? "AND (v.title ILIKE $3 OR v.sku ILIKE $3 OR p.vendor ILIKE $3 OR p.title ILIKE $3)" : ""}`,
    opts.q ? [storeId, runDate, `%${opts.q}%`] : [storeId, runDate]
  );

  let items = rows.map((r: any) => forecastRow(r, settings));

  if (opts.location_id) {
    const loc = await getLocation(storeId, opts.location_id);
    const shares = await demandShares(storeId);
    const levels = new Map(
      (await query("SELECT variant_id, on_hand FROM inventory_levels WHERE location_id=$1", [loc.id])).map((l: any) => [Number(l.variant_id), Number(l.on_hand)])
    );
    items = items.map((it) => localise(it, loc, levels.get(it.variant_id) ?? 0, shareFor(shares, it.variant_id, Number(loc.id)), settings));
  }

  const counts: Record<string, number> = {};
  for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;
  if (opts.status?.length) items = items.filter((it) => opts.status!.includes(it.status));

  const rank: Record<string, number> = { reorder_now: 0, watch: 1, healthy: 2, overstocked: 3, no_sales: 4, untracked: 5 };
  const sorts: Record<string, (a: any, b: any) => number> = {
    status: (a, b) => rank[a.status] - rank[b.status] || (a.cover_days ?? 1e9) - (b.cover_days ?? 1e9),
    cover: (a, b) => (a.cover_days ?? 1e9) - (b.cover_days ?? 1e9),
    revenue_at_risk: (a, b) => b.revenue_at_risk - a.revenue_at_risk,
    runs_out: (a, b) => (a.runs_out_on ?? "9999") < (b.runs_out_on ?? "9999") ? -1 : 1,
    name: (a, b) => a.title.localeCompare(b.title),
  };
  const sortKey = opts.sort ?? "status";
  if (!sorts[sortKey]) throw invalid("invalid_sort", `Unknown sort '${sortKey}'. Use one of: ${Object.keys(sorts).join(", ")}.`, "sort");
  items.sort(sorts[sortKey]);

  const total = items.length;
  const data = items.slice((page - 1) * limit, page * limit);
  return { run_date: runDate, location_id: opts.location_id ?? null, data, page, limit, total, has_more: page * limit < total, counts };
}

function forecastRow(r: any, settings: any) {
  const status = r.status_out as Status;
  const tracked = status !== "untracked";
  const cover = n(r.days_of_stock);
  return {
    variant_id: Number(r.variant_id),
    sku: r.sku ?? null,
    title: r.title,
    vendor: r.vendor ?? null,
    category: r.product_type ?? null,
    image_url: r.image_url ?? null,
    supplier: r.resolved_supplier_id ? { id: Number(r.resolved_supplier_id), name: r.supplier_name } : null,
    status,
    on_hand: tracked ? Number(r.current_stock) : null,
    on_order: Number(r.live_on_order ?? r.on_order ?? 0),
    rate_per_day: r1(n(r.rate_14d) ?? n(r.avg_daily_demand)),
    forecast_per_day: r2(n(r.avg_daily_demand)),
    cover_days: cover !== null ? r1(cover) : null,
    runs_out_on: r.stockout_date ?? null,
    reorder_point: n(r.reorder_point),
    suggested_quantity: Number(r.reorder_qty ?? 0),
    revenue_at_risk: Number(r.revenue_at_risk ?? 0),
    lead_time_days: Number(r.lead_time_days ?? r.live_lead_time ?? settings.default_lead_time_days),
    safety_stock: r1(n(r.safety_stock)),
    confidence: r.confidence ?? null,
    model: r.model_used ?? null,
    price: n(r.price),
    unit_cost: n(r.unit_cost ?? r.cost),
  };
}

/** Per-location view: stock at the location, demand by its share of sales. */
function localise(it: any, loc: any, onHand: number, share: number, settings: any) {
  const rate = (it.forecast_per_day ?? 0) * share;
  const cover = rate > 0.001 ? onHand / rate : null;
  let status: Status = it.status;
  if (status !== "untracked" && status !== "no_sales") {
    if (rate <= 0.001) status = onHand > 0 ? "overstocked" : "healthy";
    else if (cover! <= it.lead_time_days) status = "reorder_now";
    else if (cover! <= it.lead_time_days + 28) status = "watch";
    else if (cover! > settings.overstock_days) status = "overstocked";
    else status = "healthy";
  }
  return {
    ...it,
    location: { id: Number(loc.id), name: loc.name, demand_share: r2(share) },
    status,
    on_hand: it.on_hand === null ? null : onHand,
    rate_per_day: r1((it.rate_per_day ?? 0) * share),
    forecast_per_day: r2(rate),
    cover_days: cover !== null ? r1(cover) : null,
    runs_out_on: cover !== null && cover < 3650 ? addDays(todayYmd(), Math.floor(cover)) : null,
    reorder_point: it.reorder_point !== null ? Math.ceil(it.reorder_point * share) : null,
    suggested_quantity: Math.ceil(it.suggested_quantity * share),
    revenue_at_risk: r2(it.revenue_at_risk * share),
  };
}

/** CSV export of the forecast list (Forecasts > Export CSV). */
export async function forecastsCsv(storeId: number, opts: { status?: string[]; location_id?: number; q?: string }) {
  const all = await listForecasts(storeId, { ...opts, limit: 250, page: 1 });
  let rows = all.data;
  for (let p = 2; (p - 1) * 250 < all.total; p++) rows = rows.concat((await listForecasts(storeId, { ...opts, limit: 250, page: p })).data);
  const cols = ["variant_id", "sku", "title", "vendor", "supplier", "status", "on_hand", "on_order", "rate_per_day", "cover_days", "runs_out_on", "reorder_point", "suggested_quantity", "revenue_at_risk", "lead_time_days", "confidence"];
  const esc = (v: any) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => esc(c === "supplier" ? (r as any).supplier?.name : (r as any)[c])).join(","));
  return lines.join("\n") + "\n";
}

/* ---------------- detail (GET /forecasts/:variantId) ---------------- */

export async function getForecastDetail(storeId: number, variantId: number, opts: { location_id?: number } = {}) {
  const { v, risk, fc, daily, settings, runDate } = await loadVariantContext(storeId, variantId);
  const today = todayYmd();
  const LT = Number(v.effective_lead_time);
  const horizon = Math.max(56, LT + settings.coverage_days);
  const avg = Number(fc?.avg_daily_demand ?? 0);
  const series = demandSeries(daily, today, horizon, avg);
  const tracked = !!v.track_inventory;
  const onHand = Number(v.current_stock ?? 0);

  const arrivals = (
    await query(
      `SELECT COALESCE(po.expected_at, CURRENT_DATE + $2::int) AS date, SUM(GREATEST(l.quantity - l.received_qty,0))::int AS qty
         FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
        WHERE l.variant_id=$1 AND po.status IN ('approved','sent','partial') GROUP BY 1`,
      [variantId, LT]
    )
  ).map((a: any) => ({ date: String(a.date).slice(0, 10), qty: Number(a.qty) }));

  const mid = walkStock(series, onHand, arrivals, "units");
  const low = walkStock(series, onHand, arrivals, "hi"); // more demand -> less stock
  const high = walkStock(series, onHand, arrivals, "lo");

  // Last 21 days rebuilt from real sales and deliveries.
  const past = await query(
    `SELECT d::date AS day, COALESCE(ds.units_sold,0) AS sold,
            COALESCE((SELECT SUM(l.received_qty) FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
                       WHERE l.variant_id = $1 AND po.received_at::date = d::date),0) AS received
       FROM generate_series(CURRENT_DATE - 21, CURRENT_DATE - 1, interval '1 day') d
       LEFT JOIN daily_sales ds ON ds.variant_id = $1 AND ds.sale_date = d::date
      ORDER BY d DESC`,
    [variantId]
  );
  let s = onHand;
  const history: { date: string; stock: number; sold: number }[] = [];
  for (const p of past) {
    // Stock at the end of that day = stock after it + units sold after it - deliveries after it.
    history.unshift({ date: String(p.day).slice(0, 10), stock: Math.max(Math.round(s), 0), sold: Number(p.sold) });
    s = s + Number(p.sold) - Number(p.received);
  }

  const reorderPoint = n(risk?.reorder_point);
  const orderLands = addDays(today, LT);
  const out = mid.runsOutInDays;
  const summary = !tracked
    ? "Stock is not tracked in your store, so only demand is forecast."
    : avg <= 0.01
      ? "No sales to forecast yet."
      : out === null
        ? `Stock lasts beyond the next ${horizon} days.`
        : out === 0
          ? "Out of stock now."
          : `Reaches zero in ${out} day${out === 1 ? "" : "s"}. ${out < LT ? "An order placed today lands after it sells out." : "An order placed today lands before it sells out."}`;

  // Weekly demand: last 12 weeks of sales next to the next 4 weeks of forecast.
  const weeksPast = await query(
    `SELECT date_trunc('week', sale_date)::date AS week, SUM(units_sold)::int AS units
       FROM daily_sales WHERE variant_id=$1 AND sale_date >= date_trunc('week', CURRENT_DATE) - interval '12 weeks'
        AND sale_date < date_trunc('week', CURRENT_DATE)
      GROUP BY 1 ORDER BY 1`,
    [variantId]
  );
  const weeksAhead: { week_start: string; units: number; forecast: true }[] = [];
  for (let w = 0; w < 4; w++) weeksAhead.push({ week_start: addDays(today, w * 7), units: r1(sumUnits(series, w * 7, w * 7 + 7))!, forecast: true });

  const byLocation = (
    await query(
      `SELECT l.id, l.name, l.is_default, COALESCE(il.on_hand,0) AS on_hand
         FROM locations l LEFT JOIN inventory_levels il ON il.location_id = l.id AND il.variant_id = $1
        WHERE l.store_id = $2 AND l.active ORDER BY l.is_default DESC, l.name`,
      [variantId, storeId]
    )
  ).map((r: any) => ({ location_id: Number(r.id), name: r.name, is_default: r.is_default, on_hand: Number(r.on_hand) }));

  const supplier = v.resolved_supplier_id
    ? await queryOne("SELECT id, name FROM suppliers WHERE id=$1", [v.resolved_supplier_id])
    : null;

  return {
    variant_id: Number(v.id),
    sku: v.sku,
    title: v.title || v.product_title,
    product_title: v.product_title,
    vendor: v.vendor,
    category: v.product_type,
    image_url: v.image_url,
    price: n(v.price),
    run_date: runDate,
    status: (risk?.status_out as Status) ?? null,
    confidence: risk?.confidence ?? null,
    accuracy: n(risk?.accuracy),
    model: fc?.model_used ?? null,
    summary,
    numbers: {
      on_hand: tracked ? onHand : null,
      on_order: Number(v.on_order),
      in_draft: Number(v.in_draft),
      rate_per_day: r1(n(risk?.rate_14d)),
      forecast_per_day: r2(avg),
      cover_days: r1(n(risk?.days_of_stock)),
      runs_out_on: risk?.stockout_date ?? null,
      reorder_point: reorderPoint,
      safety_stock: r1(n(risk?.safety_stock)),
      suggested_quantity: Number(risk?.reorder_qty ?? 0),
      revenue_at_risk: Number(risk?.revenue_at_risk ?? 0),
      lead_time_days: LT,
      order_today_lands_on: orderLands,
    },
    ordering: {
      supplier: supplier ? { id: Number(supplier.id), name: supplier.name } : null,
      supplier_source: v.supplier_source ?? null,
      case_pack: Number(v.case_pack),
      min_order_qty: Number(v.min_order_qty),
      lead_time_override_days: n(v.lead_time_override),
      lead_time_source: v.lead_time_source,
      unit_cost: n(v.cost),
      min_safety_stock: Number(v.safety_stock ?? 0),
    },
    stock_curve: {
      history,
      forecast: mid.curve.map((p, i) => ({ date: p.date, stock: p.stock, low: low.curve[i].stock, high: high.curve[i].stock })),
      markers: { today, order_today_lands: orderLands, reorder_point: reorderPoint },
      band: "80%",
    },
    daily_forecast: series.slice(0, 56).map((p) => ({ date: p.date, units: r2(p.units), low: r2(p.lo), high: r2(p.hi) })),
    weekly_demand: [
      ...weeksPast.map((w: any) => ({ week_start: String(w.week).slice(0, 10), units: Number(w.units), forecast: false })),
      ...weeksAhead,
    ],
    stock_by_location: byLocation,
  };
}

/* ---------------- ordering settings (forecast page) ---------------- */

export async function updateOrderingSettings(storeId: number, variantId: number, body: any) {
  onlyFields(body, ["supplier_id", "case_pack", "min_order_qty", "lead_time_days", "unit_cost", "min_safety_stock"]);
  const v = await queryOne("SELECT id FROM variants WHERE id=$1 AND store_id=$2", [variantId, storeId]);
  if (!v) throw notFound("product variant", variantId);
  const sets: string[] = [];
  const params: any[] = [variantId];
  const push = (col: string, val: any) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (body.supplier_id !== undefined) {
    if (body.supplier_id === null) push("supplier_id", null);
    else {
      const sid = intField(body, "supplier_id", { min: 1 })!;
      const s = await queryOne("SELECT id FROM suppliers WHERE id=$1 AND store_id=$2", [sid, storeId]);
      if (!s) throw invalid("unknown_supplier", `No supplier ${sid} in this store.`, "supplier_id");
      push("supplier_id", sid);
    }
  }
  const cp = intField(body, "case_pack", { min: 1, max: 10000 });
  if (cp !== undefined) push("case_pack", cp);
  const moq = intField(body, "min_order_qty", { min: 0, max: 1000000 });
  if (moq !== undefined) push("min_order_qty", moq);
  if (body.lead_time_days !== undefined) {
    // null clears the override: the supplier's lead time is used again.
    const lt = body.lead_time_days === null ? null : intField(body, "lead_time_days", { min: 1, max: 365 })!;
    push("lead_time_override", lt);
    if (lt !== null) push("lead_time_days", lt);
  }
  const cost = numField(body, "unit_cost", { min: 0 });
  if (cost !== undefined) push("cost", cost);
  if (body.unit_cost === null) push("cost", null);
  const ss = intField(body, "min_safety_stock", { min: 0 });
  if (ss !== undefined) push("safety_stock", ss);
  if (!sets.length) throw invalid("invalid_body", "Send at least one ordering setting to change.");

  await query(`UPDATE variants SET ${sets.join(", ")} WHERE id=$1`, params);
  // Saving recalculates the forecast in the background.
  const job = await queueForecast(storeId);
  const detail = await getForecastDetail(storeId, variantId);
  return { ordering: detail.ordering, rebuild_job_id: Number(job.id) };
}

export { boolField };
