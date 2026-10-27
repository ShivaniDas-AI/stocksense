import { Router } from "express";
import { query, queryOne } from "../db";
import { getSessionStoreId } from "./auth";

export const apiRouter = Router();

/** Auth middleware: resolve store from the session cookie or Bearer token (or ?store_id in dev). */
apiRouter.use((req: any, res, next) => {
  let storeId = getSessionStoreId(req);
  if (!storeId && process.env.NODE_ENV !== "production" && req.query.store_id) {
    storeId = parseInt(String(req.query.store_id), 10);
  }
  if (!storeId) return res.status(401).json({ error: "Not authenticated" });
  req.storeId = storeId;
  next();
});

/** GET /api/store — store info + sync status (+ the last sync error, if any) */
apiRouter.get("/store", async (req: any, res) => {
  const s = await queryOne(
    "SELECT id, platform, store_domain, currency, sync_status FROM stores WHERE id=$1",
    [req.storeId]
  );
  if (!s) return res.status(404).json({ error: "not found" });
  let sync_error: string | null = null;
  if (s.sync_status === "error") {
    const job = await queryOne(
      `SELECT error FROM sync_jobs WHERE store_id=$1 AND job_type='initial_sync'
       ORDER BY id DESC LIMIT 1`,
      [req.storeId]
    );
    sync_error = job?.error ?? null;
  }
  res.json({ ...s, sync_error });
});

/** Variant counts the dashboard uses to explain an empty or partial forecast. */
async function variantCounts(storeId: number) {
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

/** GET /api/summary — dashboard header cards */
apiRouter.get("/summary", async (req: any, res) => {
  const run = await queryOne(
    "SELECT MAX(run_date) AS run_date FROM stock_risk WHERE store_id=$1",
    [req.storeId]
  );
  const runDate = run?.run_date;
  if (!runDate) {
    // No forecast rows yet. Tell the dashboard whether a forecast is queued,
    // running, finished with nothing to show, or failed, so it can explain
    // instead of spinning.
    const job = await queryOne(
      `SELECT status, finished_at, error FROM sync_jobs
       WHERE store_id=$1 AND job_type='forecast' ORDER BY id DESC LIMIT 1`,
      [req.storeId]
    );
    return res.json({
      ready: false,
      forecast_job: job?.status ?? null,
      forecast_finished_at: job?.finished_at ?? null,
      forecast_error: job?.error ?? null,
      ...(await variantCounts(req.storeId)),
    });
  }

  const rows = await query(
    `SELECT risk_level, COUNT(*)::int AS n, COALESCE(SUM(revenue_at_risk),0)::float AS rev
     FROM stock_risk WHERE store_id=$1 AND run_date=$2 GROUP BY risk_level`,
    [req.storeId, runDate]
  );
  const by: Record<string, { n: number; rev: number }> = {};
  rows.forEach((r: any) => (by[r.risk_level] = { n: r.n, rev: r.rev }));
  const total = rows.reduce((a: number, r: any) => a + r.n, 0);
  const untracked = by.untracked?.n || 0;
  res.json({
    ready: true,
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
    ...(await variantCounts(req.storeId)),
    kpis: await computeKpis(req.storeId, runDate),
  });
});

/**
 * Inventory KPIs for the latest forecast run. All money figures are at
 * retail price (unit cost is not synced from the platforms), and all
 * stock-based figures exclude variants whose platform does not track stock.
 *
 *  - revenue_at_risk     sales lost in the 8-week horizon if at-risk SKUs are not reordered
 *  - units_on_hand / inventory_value   stock currently held (retail value)
 *  - sales_30d / sales_prev_30d        realised sales, for trend
 *  - forecast_30d        projected demand for the next 30 days
 *  - reorder_units/value suggested purchase for critical + low-stock SKUs
 *  - overstock_units/value             stock beyond 120 days of forecast demand
 *  - median_cover_days   typical days of stock across tracked SKUs with demand
 *  - sell_through_30d    units sold in 30d / (sold + on hand)
 *  - next_stockout       earliest projected stockout among at-risk SKUs
 */
async function computeKpis(storeId: number, runDate: string) {
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
        `SELECT v.title, v.sku FROM stock_risk sr JOIN variants v ON v.id = sr.variant_id
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
    sales_30d: { units: units30, revenue: sales?.revenue_30 ?? 0 },
    sales_prev_30d: { units: sales?.units_prev ?? 0, revenue: sales?.revenue_prev ?? 0 },
    forecast_30d: { units: Math.round(fc?.units ?? 0), revenue: fc?.revenue ?? 0 },
    sell_through_30d: units30 + onHand > 0 ? Math.round((100 * units30) / (units30 + onHand)) : null,
  };
}

/** GET /api/risks?level=critical,low_stock&q=air&limit=50&offset=0 */
apiRouter.get("/risks", async (req: any, res) => {
  const run = await queryOne(
    "SELECT MAX(run_date) AS run_date FROM stock_risk WHERE store_id=$1",
    [req.storeId]
  );
  if (!run?.run_date) return res.json({ items: [] });

  const levels = String(req.query.level || "critical,low_stock,healthy,overstocked,no_demand,untracked")
    .split(",")
    .filter(Boolean);
  const q = String(req.query.q || "").trim();
  const limit = Math.min(parseInt(String(req.query.limit || "100"), 10), 500);
  const offset = parseInt(String(req.query.offset || "0"), 10);

  const params: any[] = [req.storeId, run.run_date, levels];
  let where = "sr.store_id=$1 AND sr.run_date=$2 AND sr.risk_level = ANY($3)";
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (v.title ILIKE $${params.length} OR v.sku ILIKE $${params.length})`;
  }
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
     ORDER BY CASE sr.risk_level
                WHEN 'critical' THEN 0 WHEN 'low_stock' THEN 1
                WHEN 'healthy' THEN 2 WHEN 'overstocked' THEN 3
                WHEN 'untracked' THEN 4 ELSE 5 END,
              sr.days_of_stock ASC NULLS LAST
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ run_date: run.run_date, items });
});

/** GET /api/variants/:id — detail: 90d history + forecast curve */
apiRouter.get("/variants/:id", async (req: any, res) => {
  const vid = parseInt(req.params.id, 10);
  const v = await queryOne(
    `SELECT v.*, p.title AS product_title, p.image_url
     FROM variants v JOIN products p ON p.id=v.product_id
     WHERE v.id=$1 AND v.store_id=$2`,
    [vid, req.storeId]
  );
  if (!v) return res.status(404).json({ error: "not found" });

  const history = await query(
    `SELECT sale_date, units_sold FROM daily_sales
     WHERE variant_id=$1 AND sale_date >= CURRENT_DATE - INTERVAL '90 days'
     ORDER BY sale_date`,
    [vid]
  );
  const fc = await queryOne(
    `SELECT run_date, model_used, daily_forecast, avg_daily_demand
     FROM forecasts WHERE variant_id=$1 ORDER BY run_date DESC LIMIT 1`,
    [vid]
  );
  const risk = await queryOne(
    `SELECT * FROM stock_risk WHERE variant_id=$1 ORDER BY run_date DESC LIMIT 1`,
    [vid]
  );
  res.json({ variant: v, history, forecast: fc, risk });
});

/** PATCH /api/variants/:id — merchant edits lead time / safety stock */
apiRouter.patch("/variants/:id", async (req: any, res) => {
  const vid = parseInt(req.params.id, 10);
  const { lead_time_days, safety_stock } = req.body ?? {};
  const lt = lead_time_days != null ? Math.max(1, parseInt(lead_time_days, 10)) : null;
  const ss = safety_stock != null ? Math.max(0, parseInt(safety_stock, 10)) : null;
  await query(
    `UPDATE variants SET
       lead_time_days = COALESCE($1, lead_time_days),
       safety_stock = COALESCE($2, safety_stock)
     WHERE id=$3 AND store_id=$4`,
    [lt, ss, vid, req.storeId]
  );
  res.json({ ok: true });
});

/** GET /api/alerts — recent alerts */
apiRouter.get("/alerts", async (req: any, res) => {
  const items = await query(
    `SELECT a.id, a.alert_type, a.risk_level, a.sent_at, a.acknowledged,
            v.title, v.sku
     FROM alerts a JOIN variants v ON v.id=a.variant_id
     WHERE a.store_id=$1 ORDER BY a.sent_at DESC LIMIT 50`,
    [req.storeId]
  );
  res.json({ items });
});

/** POST /api/alerts/:id/ack */
apiRouter.post("/alerts/:id/ack", async (req: any, res) => {
  await query("UPDATE alerts SET acknowledged=true WHERE id=$1 AND store_id=$2", [
    parseInt(req.params.id, 10),
    req.storeId,
  ]);
  res.json({ ok: true });
});
