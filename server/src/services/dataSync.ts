/** Settings > Data & sync: rebuild now, re-import history, sync health. */
import { afterCommit, query, queryOne } from "../db";
import { incrementalSync, startInitialSync } from "../sync/sync";
import { queueForecast } from "./inventory";
import { conflict } from "./errors";

/**
 * Rebuild: refresh stock, pull the last 3 days of orders and recalculate
 * everything. The sync runs in the background; poll GET /data/status.
 */
export async function rebuild(storeId: number) {
  const store = await queryOne("SELECT is_demo, sync_status FROM stores WHERE id=$1", [storeId]);
  if (store?.sync_status === "syncing") throw conflict("sync_running", "An import is already running. Try again when it finishes.");
  if (store?.is_demo) {
    const job = await queueForecast(storeId);
    return { sync_job_id: null, forecast_job_id: Number(job.id), message: "Demo store: forecasts are being rebuilt." };
  }
  const job = await queryOne(
    "INSERT INTO sync_jobs (store_id, job_type, status, started_at) VALUES ($1,'incremental','running',now()) RETURNING id",
    [storeId]
  );
  afterCommit(async () => {
    try {
      await incrementalSync(storeId, 3, true);
      await query("UPDATE sync_jobs SET status='done', finished_at=now() WHERE id=$1", [job!.id]);
    } catch (e: any) {
      await query("UPDATE sync_jobs SET status='error', finished_at=now(), error=$2 WHERE id=$1", [job!.id, String(e.message).slice(0, 500)]);
    }
  });
  return { sync_job_id: Number(job!.id), forecast_job_id: null, message: "Refreshing stock and the last 3 days of orders, then rebuilding forecasts." };
}

/** Re-import order history from the platform (the full first import again). */
export async function reimport(storeId: number) {
  const store = await queryOne("SELECT is_demo, sync_status FROM stores WHERE id=$1", [storeId]);
  if (store?.is_demo) throw conflict("demo_store", "A demo store has no platform to import from.");
  if (store?.sync_status === "syncing") throw conflict("sync_running", "An import is already running.");
  afterCommit(() => startInitialSync(storeId));
  return { started: true, message: "Re-import started. The store shows as syncing until it finishes." };
}

export async function syncStatus(storeId: number) {
  const s = await queryOne("SELECT sync_status, forecasted_at, alerts_evaluated_at, plan, is_demo FROM stores WHERE id=$1", [storeId]);
  const jobs = await query(
    "SELECT id, job_type, status, started_at, finished_at, error FROM sync_jobs WHERE store_id=$1 ORDER BY id DESC LIMIT 10",
    [storeId]
  );
  const counts = await queryOne(
    `SELECT (SELECT COUNT(*) FROM variants WHERE store_id=$1)::int AS variants,
            (SELECT COUNT(*) FROM order_lines WHERE store_id=$1)::int AS order_lines,
            (SELECT MIN(ordered_at) FROM order_lines WHERE store_id=$1) AS history_from,
            (SELECT COUNT(*) FROM products WHERE store_id=$1 AND is_demo)::int AS demo_products`,
    [storeId]
  );
  return {
    sync_status: s?.sync_status,
    demo_store: s?.is_demo ?? false,
    demo_data_loaded: (counts?.demo_products ?? 0) > 0,
    last_forecast_at: s?.forecasted_at ?? null,
    last_alert_check_at: s?.alerts_evaluated_at ?? null,
    variants: counts?.variants ?? 0,
    order_lines: counts?.order_lines ?? 0,
    history_from: counts?.history_from ?? null,
    recent_jobs: jobs.map((j: any) => ({ ...j, id: Number(j.id) })),
  };
}
