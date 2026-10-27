import axios from "axios";
import { config } from "../config";
import { query } from "../db";

/**
 * Daily alert digest. For each ready store:
 *  - find critical / low_stock SKUs from the latest run
 *  - skip SKUs alerted in the last 7 days (alerts table)
 *  - send one digest email via Resend (free tier) and log alerts
 *
 * Store owner email: for MVP we read ALERT_TO_EMAIL from env per deployment;
 * in production, store it per-store (add owner_email to stores).
 */

export async function sendDailyAlerts() {
  const stores = await query(
    "SELECT id, store_domain FROM stores WHERE sync_status='ready' AND uninstalled_at IS NULL"
  );
  for (const s of stores) {
    try {
      await sendStoreDigest(s.id, s.store_domain);
    } catch (e: any) {
      console.error(`[alerts] store ${s.id} failed:`, e.message);
    }
  }
}

async function sendStoreDigest(storeId: number, domain: string) {
  const rows = await query(
    `SELECT sr.variant_id, v.title, v.sku, sr.risk_level, sr.current_stock,
            sr.days_of_stock, sr.stockout_date, sr.reorder_qty, sr.revenue_at_risk
     FROM stock_risk sr
     JOIN variants v ON v.id = sr.variant_id
     WHERE sr.store_id = $1
       AND sr.run_date = (SELECT MAX(run_date) FROM stock_risk WHERE store_id=$1)
       AND sr.risk_level IN ('critical','low_stock')
       AND NOT EXISTS (
         SELECT 1 FROM alerts a
         WHERE a.variant_id = sr.variant_id
           AND a.sent_at > now() - INTERVAL '7 days'
       )
     ORDER BY CASE sr.risk_level WHEN 'critical' THEN 0 ELSE 1 END, sr.days_of_stock ASC
     LIMIT 50`,
    [storeId]
  );
  if (rows.length === 0) return;

  const to = process.env.ALERT_TO_EMAIL;
  if (!to || !config.alerts.resendApiKey) {
    console.log(`[alerts] store ${storeId}: ${rows.length} alertable SKUs (email not configured)`);
    return;
  }

  const critical = rows.filter((r: any) => r.risk_level === "critical");
  const low = rows.filter((r: any) => r.risk_level === "low_stock");
  const fmtRow = (r: any) =>
    `<tr>
       <td style="padding:6px 10px;border-bottom:1px solid #223;">${r.title}${r.sku ? ` (${r.sku})` : ""}</td>
       <td style="padding:6px 10px;border-bottom:1px solid #223;text-align:right;">${r.current_stock}</td>
       <td style="padding:6px 10px;border-bottom:1px solid #223;text-align:right;">${r.days_of_stock ?? "-"} d</td>
       <td style="padding:6px 10px;border-bottom:1px solid #223;text-align:right;">${r.reorder_qty}</td>
     </tr>`;

  const html = `
    <div style="font-family:Arial,sans-serif;color:#111;">
      <h2>StockSense daily alert — ${domain}</h2>
      ${critical.length ? `<h3 style="color:#d33;">Critical — will stock out before a reorder can arrive (${critical.length})</h3>
        <table style="border-collapse:collapse;width:100%;"><tr><th align="left">SKU</th><th align="right">Stock</th><th align="right">Cover</th><th align="right">Reorder qty</th></tr>${critical.map(fmtRow).join("")}</table>` : ""}
      ${low.length ? `<h3 style="color:#e8a020;">Low stock — at or below reorder point (${low.length})</h3>
        <table style="border-collapse:collapse;width:100%;"><tr><th align="left">SKU</th><th align="right">Stock</th><th align="right">Cover</th><th align="right">Reorder qty</th></tr>${low.map(fmtRow).join("")}</table>` : ""}
      <p><a href="${config.appUrl}/dashboard">Open StockSense dashboard</a></p>
    </div>`;

  await axios.post(
    "https://api.resend.com/emails",
    {
      from: config.alerts.fromEmail,
      to: [to],
      subject: `StockSense: ${critical.length} critical, ${low.length} low-stock SKUs`,
      html,
    },
    { headers: { Authorization: `Bearer ${config.alerts.resendApiKey}` } }
  );

  // Log so we don't re-alert daily.
  for (const r of rows) {
    await query(
      `INSERT INTO alerts (store_id, variant_id, alert_type, risk_level, channel)
       VALUES ($1,$2,'stockout_risk',$3,'email')`,
      [storeId, r.variant_id, r.risk_level]
    );
  }
  console.log(`[alerts] store ${storeId}: digest sent (${rows.length} SKUs)`);
}
