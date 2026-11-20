/**
 * The dashboard (guide chapter 3): what needs ordering today, and what is
 * it worth? Whole business or one location.
 */
import { query, queryOne } from "../db";
import { addDays, listForecasts, STATUS_SQL, todayYmd } from "./forecasts";
import { latestRunDate } from "./inventory";
import { getForecastSettings } from "./settings";
import { getLocation } from "./locations";
import { listPurchaseOrders } from "./purchaseOrders";

const money = (v: number) => Math.round(v * 100) / 100;

export async function getDashboard(storeId: number, opts: { location_id?: number } = {}) {
  const runDate = await latestRunDate(storeId);
  const settings = await getForecastSettings(storeId);
  if (opts.location_id) await getLocation(storeId, opts.location_id);
  if (!runDate) return { ready: false, run_date: null };

  // Per-location numbers come from the localised forecast list.
  const all = await listForecasts(storeId, { location_id: opts.location_id, limit: 250, page: 1 });
  let rows = all.data;
  for (let p = 2; (p - 1) * 250 < all.total; p++) rows = rows.concat((await listForecasts(storeId, { location_id: opts.location_id, limit: 250, page: p })).data);
  const forecastable = rows.filter((r) => r.status !== "untracked");

  const drafts = await queryOne("SELECT COUNT(*)::int AS n FROM purchase_orders WHERE store_id=$1 AND status='draft'", [storeId]);

  // Cash in overstock: value at cost of stock beyond the overstock limit.
  let overstockCash = 0, overstockUnits = 0, costBasisPrice = false;
  for (const r of rows) {
    if (r.on_hand === null || !r.forecast_per_day || r.forecast_per_day <= 0) continue;
    const excess = r.on_hand - r.forecast_per_day * settings.overstock_days;
    if (excess <= 0) continue;
    const unit = r.unit_cost ?? r.price ?? 0;
    if (r.unit_cost === null) costBasisPrice = true;
    overstockUnits += excess;
    overstockCash += excess * unit;
  }

  // Forecast accuracy: weighted by volume over the last four weeks, and its change this month.
  const acc = await queryOne(
    `SELECT SUM(accuracy * GREATEST(rate_14d, 0.01)) / NULLIF(SUM(GREATEST(rate_14d, 0.01)), 0) AS a
       FROM stock_risk WHERE store_id=$1 AND run_date=$2 AND accuracy IS NOT NULL`,
    [storeId, runDate]
  );
  const accPrev = await queryOne(
    `SELECT SUM(accuracy * GREATEST(rate_14d, 0.01)) / NULLIF(SUM(GREATEST(rate_14d, 0.01)), 0) AS a
       FROM stock_risk WHERE store_id=$1 AND accuracy IS NOT NULL
        AND run_date = (SELECT MAX(run_date) FROM stock_risk WHERE store_id=$1 AND run_date < date_trunc('month', CURRENT_DATE))`,
    [storeId]
  );

  // Revenue protected: revenue at risk on alerts resolved by a purchase order in the last 90 days.
  const protectedRev = await queryOne(
    `SELECT COALESCE(SUM(revenue_at_risk),0)::float AS v, COUNT(*)::int AS n FROM inventory_alerts
      WHERE store_id=$1 AND status='resolved' AND resolved_by_po_id IS NOT NULL AND resolved_at > now() - interval '90 days'`,
    [storeId]
  );

  // Units sold against forecast: 12 weeks of sales next to 4 weeks of forecast.
  const varFilter = opts.location_id ? rows.map((r) => r.variant_id) : null;
  const weeksPast = await query(
    `SELECT date_trunc('week', ds.sale_date)::date AS week, SUM(ds.units_sold)::int AS units
       FROM daily_sales ds WHERE ds.store_id=$1 AND ds.sale_date >= date_trunc('week', CURRENT_DATE) - interval '12 weeks'
        AND ds.sale_date < date_trunc('week', CURRENT_DATE) ${varFilter ? "AND ds.variant_id = ANY($2)" : ""}
      GROUP BY 1 ORDER BY 1`,
    varFilter ? [storeId, varFilter] : [storeId]
  );
  const fcDaily = await query(
    `SELECT (e->>'d')::date AS d, SUM((e->>'y')::numeric)::float AS y
       FROM forecasts f CROSS JOIN LATERAL jsonb_array_elements(f.daily_forecast) e
      WHERE f.store_id=$1 AND f.run_date=$2 ${varFilter ? "AND f.variant_id = ANY($3)" : ""}
      GROUP BY 1`,
    varFilter ? [storeId, runDate, varFilter] : [storeId, runDate]
  );
  const fcMap = new Map(fcDaily.map((r: any) => [String(r.d).slice(0, 10), Number(r.y)]));
  const today = todayYmd();
  const weeksAhead = [];
  for (let w = 0; w < 4; w++) {
    let units = 0;
    for (let d = 0; d < 7; d++) units += fcMap.get(addDays(today, w * 7 + d)) ?? 0;
    weeksAhead.push({ week_start: addDays(today, w * 7), units: Math.round(units), forecast: true });
  }

  const critical = forecastable.filter((r) => r.status === "reorder_now" && r.cover_days !== null && r.cover_days < r.lead_time_days).length;
  const reorder = forecastable.filter((r) => r.status === "reorder_now");
  const suggested = await listPurchaseOrders(storeId, { status: ["draft"], limit: 1 });

  return {
    ready: true,
    run_date: runDate,
    location_id: opts.location_id ?? null,
    cards: {
      skus_tracked: { value: forecastable.length, critical },
      need_reordering: { value: reorder.length, draft_purchase_orders: drafts?.n ?? 0 },
      cash_in_overstock: { value: money(overstockCash), units: Math.round(overstockUnits), overstock_days: settings.overstock_days, basis: costBasisPrice ? "cost where known, else price" : "cost" },
      forecast_accuracy: {
        value: acc?.a != null ? Math.round(Number(acc.a) * 1000) / 10 : null,
        change_this_month: acc?.a != null && accPrev?.a != null ? Math.round((Number(acc.a) - Number(accPrev.a)) * 1000) / 10 : null,
        unit: "percent",
      },
      revenue_protected: { value: money(Number(protectedRev?.v ?? 0)), alerts: protectedRev?.n ?? 0, period_days: 90 },
    },
    units_sold_vs_forecast: [
      ...weeksPast.map((w: any) => ({ week_start: String(w.week).slice(0, 10), units: Number(w.units), forecast: false })),
      ...weeksAhead,
    ],
    running_low: forecastable
      .filter((r) => r.cover_days !== null && r.status !== "no_sales")
      .sort((a, b) => a.cover_days! - b.cover_days!)
      .slice(0, 8)
      .map((r) => ({ variant_id: r.variant_id, title: r.title, sku: r.sku, cover_days: r.cover_days, runs_out_on: r.runs_out_on, status: r.status })),
    attention_needed: forecastable
      .filter((r) => r.revenue_at_risk > 0 || r.status === "reorder_now" || r.status === "watch")
      .sort((a, b) => b.revenue_at_risk - a.revenue_at_risk)
      .slice(0, 10)
      .map((r) => ({ variant_id: r.variant_id, title: r.title, sku: r.sku, status: r.status, revenue_at_risk: r.revenue_at_risk, suggested_quantity: r.suggested_quantity, supplier: r.supplier })),
    suggested_order: suggested.data[0] ?? null,
  };
}

/** Plan usage for Settings > General: SKUs, locations and Ask questions this month. */
export async function planUsage(storeId: number) {
  const skus = await queryOne("SELECT COUNT(*)::int AS n FROM variants WHERE store_id=$1 AND track_inventory", [storeId]);
  const locations = await queryOne("SELECT COUNT(*)::int AS n FROM locations WHERE store_id=$1 AND active", [storeId]);
  const ask = await queryOne(
    `SELECT COUNT(*)::int AS n FROM ask_messages m JOIN ask_conversations c ON c.id = m.conversation_id
      WHERE c.store_id=$1 AND m.role='user' AND m.created_at >= date_trunc('month', now())`,
    [storeId]
  );
  return { skus: skus?.n ?? 0, locations: locations?.n ?? 0, ask_questions_this_month: ask?.n ?? 0 };
}

export { STATUS_SQL };
