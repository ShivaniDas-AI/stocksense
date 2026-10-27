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
    overstocked: by.overstocked?.n || 0,
    revenue_at_risk: (by.critical?.rev || 0) + (by.low_stock?.rev || 0),
    ...(await variantCounts(req.storeId)),
  });
});

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
