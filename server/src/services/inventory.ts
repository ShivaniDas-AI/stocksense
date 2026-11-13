/**
 * Inventory queries shared by the app API (/api, session auth) and the
 * public API (/v1, API-key auth), so both always return the same numbers.
 * Every function is scoped to one store id.
 */
import { query, queryOne } from "../db";

export const ALL_LEVELS = ["critical", "low_stock", "healthy", "overstocked", "no_demand", "untracked"] as const;
export type RiskLevel = (typeof ALL_LEVELS)[number];

export async function latestRunDate(storeId: number): Promise<string | null> {
  const run = await queryOne("SELECT MAX(run_date) AS run_date FROM stock_risk WHERE store_id=$1", [storeId]);
  return run?.run_date ?? null;
}

/* ---------------- store ---------------- */

export async function getStoreInfo(storeId: number) {
  const s = await queryOne(
    "SELECT id, platform, store_domain, currency, sync_status FROM stores WHERE id=$1",
    [storeId]
  );
  if (!s) return null;
  let sync_error: string | null = null;
  if (s.sync_status === "error") {
    const job = await queryOne(
      `SELECT error FROM sync_jobs WHERE store_id=$1 AND job_type='initial_sync'
       ORDER BY id DESC LIMIT 1`,
      [storeId]
    );
    sync_error = job?.error ?? null;
  }
  return { ...s, sync_error };
}

/* ---------------- summary + KPIs ---------------- */

/** Variant counts the dashboard uses to explain an empty or partial forecast. */
export async function variantCounts(storeId: number) {
  const c = await queryOne(
    `SELECT COUNT(*)::int AS variants_total,
            COUNT(*) FILTER (WHERE track_inventory)::int AS variants_tracked,
            EXISTS (SELECT 1 FROM daily_sales WHERE store_id=$1) AS has_sales
     FROM variants WHERE store_id=$1`,
    [storeId]
  );
  return {
    variants_total: c?.variants_total ?? 0,
    variants_tracked: c?.variants_tracked ?? 0,
    has_sales: !!c?.has_sales,
  };
}

export async function getSummary(storeId: number) {
  const runDate = await latestRunDate(storeId);
  if (!runDate) {
    // No forecast rows yet: say whether a forecast is queued, running,
    // finished with nothing to show, or failed.
    const job = await queryOne(
      `SELECT status, finished_at, error FROM sync_jobs
       WHERE store_id=$1 AND job_type='forecast' ORDER BY id DESC LIMIT 1`,
      [storeId]
    );
    return {
      ready: false as const,
      forecast_job: job?.status ?? null,
      forecast_finished_at: job?.finished_at ?? null,
      forecast_error: job?.error ?? null,
      ...(await variantCounts(storeId)),
    };
  }

  const rows = await query(
    `SELECT risk_level, COUNT(*)::int AS n, COALESCE(SUM(revenue_at_risk),0)::float AS rev
     FROM stock_risk WHERE store_id=$1 AND run_date=$2 GROUP BY risk_level`,
    [storeId, runDate]
  );
  const by: Record<string, { n: number; rev: number }> = {};
  rows.forEach((r: any) => (by[r.risk_level] = { n: r.n, rev: r.rev }));
  const total = rows.reduce((a: number, r: any) => a + r.n, 0);
  const untracked = by.untracked?.n || 0;
  return {
    ready: true as const,
    run_date: runDate,
    skus_forecasted: total,
    skus_tracked: total - untracked,
    untracked,
    at_risk: (by.critical?.n || 0) + (by.low_stock?.n || 0),
    critical: by.critical?.n || 0,
    low_stock: by.low_stock?.n || 0,
    healthy: by.healthy?.n || 0,
    overstocked: by.overstocked?.n || 0,
    no_demand: by.no_demand?.n || 0,
    revenue_at_risk: (by.critical?.rev || 0) + (by.low_stock?.rev || 0),
    ...(await variantCounts(storeId)),
    kpis: await computeKpis(storeId, runDate),
  };
}

/**
 * Inventory KPIs for the latest forecast run. All money figures are at
 * retail price (unit cost is not synced from the platforms), and all
 * stock-based figures exclude variants whose platform does not track stock.
 */
export async function computeKpis(storeId: number, runDate: string) {
  const risk = await queryOne(
    `WITH r AS (
       SELECT sr.*, v.price, v.title, f.avg_daily_demand
       FROM stock_risk sr
       JOIN variants v ON v.id = sr.variant_id
       LEFT JOIN forecasts f ON f.variant_id = sr.variant_id AND f.run_date = sr.run_date
       WHERE sr.store_id = $1 AND sr.run_date = $2
     )
     SELECT
       COUNT(*)::int AS forecasted,
       COUNT(*) FILTER (WHERE risk_level <> 'untracked')::int AS tracked,
       COUNT(*) FILTER (WHERE risk_level = 'healthy')::int AS healthy,
       COALESCE(SUM(GREATEST(current_stock, 0)) FILTER (WHERE risk_level <> 'untracked'), 0)::int AS units_on_hand,
       COALESCE(SUM(GREATEST(current_stock, 0) * COALESCE(price, 0)) FILTER (WHERE risk_level <> 'untracked'), 0)::float AS inventory_value,
       COALESCE(SUM(reorder_qty) FILTER (WHERE risk_level IN ('critical','low_stock')), 0)::int AS reorder_units,
       COALESCE(SUM(reorder_qty * COALESCE(price, 0)) FILTER (WHERE risk_level IN ('critical','low_stock')), 0)::float AS reorder_value,
       COALESCE(SUM(GREATEST(current_stock - avg_daily_demand * 120, 0)) FILTER (WHERE risk_level = 'overstocked'), 0)::float AS overstock_units,
       COALESCE(SUM(GREATEST(current_stock - avg_daily_demand * 120, 0) * COALESCE(price, 0)) FILTER (WHERE risk_level = 'overstocked'), 0)::float AS overstock_value,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY days_of_stock)
         FILTER (WHERE days_of_stock IS NOT NULL AND risk_level <> 'untracked') AS median_cover_days,
       MIN(stockout_date) FILTER (WHERE risk_level IN ('critical','low_stock')) AS next_stockout_date
     FROM r`,
    [storeId, runDate]
  );
  const nextOut = risk?.next_stockout_date
    ? await queryOne(
        `SELECT v.id, v.title, v.sku FROM stock_risk sr JOIN variants v ON v.id = sr.variant_id
         WHERE sr.store_id = $1 AND sr.run_date = $2 AND sr.stockout_date = $3
           AND sr.risk_level IN ('critical','low_stock')
         ORDER BY sr.revenue_at_risk DESC NULLS LAST LIMIT 1`,
        [storeId, runDate, risk.next_stockout_date]
      )
    : null;
  const fc = await queryOne(
    `SELECT COALESCE(SUM(d.y), 0)::float AS units,
            COALESCE(SUM(d.y * COALESCE(v.price, 0)), 0)::float AS revenue
     FROM forecasts f
     JOIN variants v ON v.id = f.variant_id
     CROSS JOIN LATERAL (
       SELECT SUM((e->>'y')::numeric) AS y
       FROM jsonb_array_elements(f.daily_forecast) WITH ORDINALITY AS t(e, i)
       WHERE i <= 30
     ) d
     WHERE f.store_id = $1 AND f.run_date = $2`,
    [storeId, runDate]
  );
  const sales = await queryOne(
    `SELECT
       COALESCE(SUM(units_sold) FILTER (WHERE sale_date >= CURRENT_DATE - 30), 0)::int AS units_30,
       COALESCE(SUM(revenue)    FILTER (WHERE sale_date >= CURRENT_DATE - 30), 0)::float AS revenue_30,
       COALESCE(SUM(units_sold) FILTER (WHERE sale_date <  CURRENT_DATE - 30), 0)::int AS units_prev,
       COALESCE(SUM(revenue)    FILTER (WHERE sale_date <  CURRENT_DATE - 30), 0)::float AS revenue_prev
     FROM daily_sales WHERE store_id = $1 AND sale_date >= CURRENT_DATE - 60`,
    [storeId]
  );
  const units30 = sales?.units_30 ?? 0;
  const onHand = risk?.units_on_hand ?? 0;
  return {
    healthy_pct: risk?.tracked ? Math.round((100 * risk.healthy) / risk.tracked) : null,
    units_on_hand: onHand,
    inventory_value: risk?.inventory_value ?? 0,
    reorder_units: risk?.reorder_units ?? 0,
    reorder_value: risk?.reorder_value ?? 0,
    overstock_units: Math.round(risk?.overstock_units ?? 0),
    overstock_value: risk?.overstock_value ?? 0,
    median_cover_days: risk?.median_cover_days != null ? Math.round(Number(risk.median_cover_days)) : null,
    next_stockout_date: risk?.next_stockout_date ?? null,
    next_stockout_title: nextOut?.title ?? null,
    next_stockout_variant_id: nextOut?.id != null ? Number(nextOut.id) : null,
    sales_30d: { units: units30, revenue: sales?.revenue_30 ?? 0 },
    sales_prev_30d: { units: sales?.units_prev ?? 0, revenue: sales?.revenue_prev ?? 0 },
    forecast_30d: { units: Math.round(fc?.units ?? 0), revenue: fc?.revenue ?? 0 },
    sell_through_30d: units30 + onHand > 0 ? Math.round((100 * units30) / (units30 + onHand)) : null,
  };
}

/* ---------------- risk rows ---------------- */

export type RiskSort = "risk" | "stockout" | "revenue_at_risk" | "stock" | "name";

const SORT_SQL: Record<RiskSort, string> = {
  risk: `CASE sr.risk_level WHEN 'critical' THEN 0 WHEN 'low_stock' THEN 1 WHEN 'healthy' THEN 2
           WHEN 'overstocked' THEN 3 WHEN 'untracked' THEN 4 ELSE 5 END, sr.days_of_stock ASC NULLS LAST, sr.variant_id`,
  stockout: "sr.stockout_date ASC NULLS LAST, sr.variant_id",
  revenue_at_risk: "sr.revenue_at_risk DESC NULLS LAST, sr.variant_id",
  stock: "CASE WHEN sr.risk_level = 'untracked' THEN 1 ELSE 0 END, sr.current_stock ASC, sr.variant_id",
  name: "v.title ASC, sr.variant_id",
};

export async function listRisks(
  storeId: number,
  opts: { levels?: string[]; q?: string; limit?: number; offset?: number; sort?: RiskSort }
) {
  const runDate = await latestRunDate(storeId);
  if (!runDate) return { run_date: null as string | null, items: [] as any[], total: 0 };

  const levels = (opts.levels?.length ? opts.levels : [...ALL_LEVELS]).filter((l) => (ALL_LEVELS as readonly string[]).includes(l));
  const q = (opts.q || "").trim();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const params: any[] = [storeId, runDate, levels];
  let where = "sr.store_id=$1 AND sr.run_date=$2 AND sr.risk_level = ANY($3)";
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (v.title ILIKE $${params.length} OR v.sku ILIKE $${params.length})`;
  }
  const countRow = await queryOne(
    `SELECT COUNT(*)::int AS n FROM stock_risk sr JOIN variants v ON v.id = sr.variant_id WHERE ${where}`,
    params
  );
  params.push(limit, offset);

  const items = await query(
    `SELECT sr.variant_id, v.sku, v.title, p.image_url,
            sr.current_stock, sr.days_of_stock, sr.stockout_date,
            sr.reorder_point, sr.reorder_qty, sr.revenue_at_risk, sr.risk_level,
            v.lead_time_days, v.safety_stock, v.price,
            f.avg_daily_demand, f.model_used
     FROM stock_risk sr
     JOIN variants v ON v.id = sr.variant_id
     JOIN products p ON p.id = v.product_id
     LEFT JOIN forecasts f ON f.variant_id = sr.variant_id AND f.run_date = sr.run_date
     WHERE ${where}
     ORDER BY ${SORT_SQL[opts.sort ?? "risk"]}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { run_date: runDate, items, total: countRow?.n ?? 0 };
}

/* ---------------- one variant ---------------- */

export async function getVariantDetail(storeId: number, variantId: number, historyDays = 90) {
  const v = await queryOne(
    `SELECT v.*, p.title AS product_title, p.image_url
     FROM variants v JOIN products p ON p.id=v.product_id
     WHERE v.id=$1 AND v.store_id=$2`,
    [variantId, storeId]
  );
  if (!v) return null;
  const days = Math.min(Math.max(historyDays, 1), 365);
  const history = await query(
    `SELECT sale_date, units_sold FROM daily_sales
     WHERE variant_id=$1 AND sale_date >= CURRENT_DATE - ($2::int * INTERVAL '1 day')
     ORDER BY sale_date`,
    [variantId, days]
  );
  const forecast = await queryOne(
    `SELECT run_date, model_used, daily_forecast, avg_daily_demand
     FROM forecasts WHERE variant_id=$1 ORDER BY run_date DESC LIMIT 1`,
    [variantId]
  );
  const risk = await queryOne(
    `SELECT * FROM stock_risk WHERE variant_id=$1 ORDER BY run_date DESC LIMIT 1`,
    [variantId]
  );
  return { variant: v, history, forecast, risk };
}

/** Returns false when the variant does not belong to the store. */
export async function updateVariantSettings(
  storeId: number,
  variantId: number,
  body: { lead_time_days?: unknown; safety_stock?: unknown }
): Promise<boolean> {
  const lt = body.lead_time_days != null ? Math.max(1, parseInt(String(body.lead_time_days), 10)) : null;
  const ss = body.safety_stock != null ? Math.max(0, parseInt(String(body.safety_stock), 10)) : null;
  const rows = await query(
    `UPDATE variants SET
       lead_time_days = COALESCE($1, lead_time_days),
       safety_stock = COALESCE($2, safety_stock)
     WHERE id=$3 AND store_id=$4 RETURNING id`,
    [Number.isFinite(lt) ? lt : null, Number.isFinite(ss) ? ss : null, variantId, storeId]
  );
  return rows.length > 0;
}

/* ---------------- alerts ---------------- */

export async function listAlerts(storeId: number, opts: { unacknowledged?: boolean; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return query(
    `SELECT a.id, a.variant_id, a.alert_type, a.risk_level, a.sent_at, a.acknowledged,
            v.title, v.sku
     FROM alerts a JOIN variants v ON v.id=a.variant_id
     WHERE a.store_id=$1 ${opts.unacknowledged ? "AND NOT a.acknowledged" : ""}
     ORDER BY a.sent_at DESC LIMIT $2`,
    [storeId, limit]
  );
}

export async function acknowledgeAlert(storeId: number, alertId: number): Promise<boolean> {
  const rows = await query(
    "UPDATE alerts SET acknowledged=true WHERE id=$1 AND store_id=$2 RETURNING id",
    [alertId, storeId]
  );
  return rows.length > 0;
}

/* ---------------- forecast jobs ---------------- */

export async function queueForecast(storeId: number) {
  return queryOne(
    `INSERT INTO sync_jobs (store_id, job_type, status) VALUES ($1, 'forecast', 'queued')
     RETURNING id, status, started_at, finished_at, error`,
    [storeId]
  );
}

export async function getForecastJob(storeId: number, jobId: number) {
  return queryOne(
    `SELECT id, status, started_at, finished_at, error FROM sync_jobs
     WHERE id=$1 AND store_id=$2 AND job_type='forecast'`,
    [jobId, storeId]
  );
}
