import { pool, query, queryOne, getStore } from "../db";
import { getAdapter } from "../platforms";
import { config } from "../config";
import { PlatformOrderLine, PlatformProduct, StoreCreds } from "../platforms/types";

function toCreds(s: any): StoreCreds {
  return {
    id: s.id,
    storeDomain: s.store_domain,
    storeHash: s.store_hash,
    accessToken: s.access_token,
  };
}

/** Upsert products + variants from a platform fetch. */
export async function syncProducts(storeId: number, products: PlatformProduct[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of products) {
      const pr = await client.query(
        `INSERT INTO products (store_id, external_id, title, image_url, status)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (store_id, external_id) DO UPDATE SET
           title = EXCLUDED.title, image_url = EXCLUDED.image_url, status = EXCLUDED.status
         RETURNING id`,
        [storeId, p.externalId, p.title, p.imageUrl ?? null, p.status ?? "active"]
      );
      const productId = pr.rows[0].id;
      for (const v of p.variants) {
        await client.query(
          `INSERT INTO variants
             (store_id, product_id, external_id, sku, title, price, inventory_item_id, current_stock, track_inventory)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (store_id, external_id) DO UPDATE SET
             product_id = EXCLUDED.product_id,
             sku = EXCLUDED.sku,
             title = EXCLUDED.title,
             price = EXCLUDED.price,
             inventory_item_id = EXCLUDED.inventory_item_id,
             current_stock = COALESCE(EXCLUDED.current_stock, variants.current_stock),
             track_inventory = EXCLUDED.track_inventory`,
          [
            storeId,
            productId,
            v.externalId,
            v.sku ?? null,
            v.title ?? p.title,
            v.price ?? null,
            v.inventoryItemId ?? null,
            v.currentStock,
            v.currentStock !== null && v.currentStock !== undefined,
          ]
        );
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Insert order lines (idempotent) and re-aggregate affected days into daily_sales. */
export async function ingestOrderLines(storeId: number, lines: PlatformOrderLine[]) {
  if (lines.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const CHUNK = 500;
    for (let i = 0; i < lines.length; i += CHUNK) {
      const chunk = lines.slice(i, i + CHUNK);
      const values: any[] = [];
      const ph: string[] = [];
      chunk.forEach((l, j) => {
        const b = j * 5;
        ph.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}, $${chunk.length * 5 + 1})`);
        values.push(l.externalOrderId, l.variantExternalId, l.quantity, l.lineRevenue, l.orderedAt);
      });
      await client.query(
        `INSERT INTO order_lines
           (external_order_id, variant_external_id, quantity, line_revenue, ordered_at, store_id)
         VALUES ${ph.join(",")}
         ON CONFLICT (store_id, external_order_id, variant_external_id) DO UPDATE SET
           quantity = EXCLUDED.quantity, line_revenue = EXCLUDED.line_revenue`,
        [...values, storeId]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  await aggregateDailySales(storeId);
}

/** Rebuild daily_sales from order_lines (full rebuild; cheap at MVP scale). */
export async function aggregateDailySales(storeId: number) {
  await query(
    `INSERT INTO daily_sales (store_id, variant_id, sale_date, units_sold, revenue)
     SELECT ol.store_id, v.id, ol.ordered_at::date,
            SUM(ol.quantity), SUM(ol.line_revenue)
     FROM order_lines ol
     JOIN variants v
       ON v.store_id = ol.store_id AND v.external_id = ol.variant_external_id
     WHERE ol.store_id = $1
     GROUP BY ol.store_id, v.id, ol.ordered_at::date
     ON CONFLICT (variant_id, sale_date) DO UPDATE SET
       units_sold = EXCLUDED.units_sold, revenue = EXCLUDED.revenue`,
    [storeId]
  );
}

/** Full initial sync: products -> orders backfill -> aggregate -> webhooks -> ready. */
export async function startInitialSync(storeId: number) {
  // Run async; caller doesn't wait.
  (async () => {
    const job = await queryOne(
      `INSERT INTO sync_jobs (store_id, job_type, status, started_at)
       VALUES ($1, 'initial_sync', 'running', now()) RETURNING id`,
      [storeId]
    );
    try {
      await query("UPDATE stores SET sync_status='syncing' WHERE id=$1", [storeId]);
      const store = await getStore(storeId);
      if (!store) throw new Error("store not found");
      const adapter = getAdapter(store.platform);
      const creds = toCreds(store);

      console.log(`[sync ${storeId}] fetching products...`);
      const products = await adapter.fetchProducts(creds);
      await syncProducts(storeId, products);
      console.log(`[sync ${storeId}] ${products.length} products synced`);

      const since = new Date();
      since.setMonth(since.getMonth() - config.backfillMonths);
      console.log(`[sync ${storeId}] backfilling orders since ${since.toISOString()}...`);
      const lines = await adapter.fetchOrderLines(creds, since.toISOString());
      await ingestOrderLines(storeId, lines);
      console.log(`[sync ${storeId}] ${lines.length} order lines ingested`);

      // Webhooks only speed up updates (the nightly sync covers everything),
      // so a missing webhook permission must not fail the whole sync.
      try {
        await adapter.registerWebhooks(creds, config.appUrl);
      } catch (e: any) {
        console.warn(
          `[sync ${storeId}] webhook registration skipped:`,
          e.response?.status || "",
          JSON.stringify(e.response?.data || e.message).slice(0, 300)
        );
      }
      await query("UPDATE stores SET sync_status='ready' WHERE id=$1", [storeId]);
      await query(
        "UPDATE sync_jobs SET status='done', finished_at=now() WHERE id=$1",
        [job!.id]
      );
      // Ask the worker to forecast this store now rather than at the nightly run.
      await query(
        "INSERT INTO sync_jobs (store_id, job_type, status) VALUES ($1, 'forecast', 'queued')",
        [storeId]
      );
      console.log(`[sync ${storeId}] done, forecast queued`);
    } catch (e: any) {
      console.error(`[sync ${storeId}] failed:`, e.response?.data || e.message);
      await query("UPDATE stores SET sync_status='error' WHERE id=$1", [storeId]);
      await query(
        "UPDATE sync_jobs SET status='error', finished_at=now(), error=$2 WHERE id=$1",
        [job!.id, String(e.message).slice(0, 500)]
      );
    }
  })();
}

/**
 * Incremental: pull last N days of orders + refresh products/stock.
 * Used by the nightly cron as a safety net (the forecast worker runs right
 * after it) and by webhooks, which pass refreshForecast=true so stock or
 * tracking changes show on the dashboard within a minute instead of tonight.
 * The worker collapses several queued jobs for a store into one run.
 */
export async function incrementalSync(storeId: number, days = 3, refreshForecast = false) {
  const store = await getStore(storeId);
  if (!store) return;
  const adapter = getAdapter(store.platform);
  const creds = toCreds(store);
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const [products, lines] = await Promise.all([
    adapter.fetchProducts(creds),
    adapter.fetchOrderLines(creds, since),
  ]);
  await syncProducts(storeId, products);
  await ingestOrderLines(storeId, lines);
  if (refreshForecast) {
    await query(
      "INSERT INTO sync_jobs (store_id, job_type, status) VALUES ($1, 'forecast', 'queued')",
      [storeId]
    );
  }
}
