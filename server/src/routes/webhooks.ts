import { Router } from "express";
import { query, queryOne, getStore } from "../db";
import { verifyShopifyWebhook } from "../platforms/shopify";
import { incrementalSync } from "../sync/sync";

export const webhooksRouter = Router();

/**
 * Webhook strategy (MVP): webhooks are *triggers*, not sources of truth.
 * On any relevant event we debounce and run a small incremental sync for
 * that store (last 3 days of orders + product/stock refresh). This avoids
 * per-platform payload parsing bugs and self-heals missed events.
 */

const pending = new Map<number, NodeJS.Timeout>();

function scheduleSync(storeId: number) {
  if (pending.has(storeId)) return; // already queued
  const t = setTimeout(async () => {
    pending.delete(storeId);
    try {
      await incrementalSync(storeId, 3, true);
      console.log(`[webhook] incremental sync done for store ${storeId}, forecast queued`);
    } catch (e: any) {
      console.error(`[webhook] incremental sync failed for store ${storeId}:`, e.message);
    }
  }, 60_000); // debounce 60s — bursts of webhooks collapse into one sync
  pending.set(storeId, t);
}

async function markUninstalled(storeId: number) {
  await query("UPDATE stores SET uninstalled_at = now(), sync_status='uninstalled' WHERE id=$1", [
    storeId,
  ]);
  console.log(`[webhook] store ${storeId} uninstalled`);
}

/* ---- Shopify (needs raw body for HMAC; mounted with express.raw) ---- */
webhooksRouter.post("/shopify/:storeId", async (req: any, res) => {
  const storeId = parseInt(req.params.storeId, 10);
  const hmac = req.get("X-Shopify-Hmac-Sha256") || "";
  if (!verifyShopifyWebhook(req.body as Buffer, hmac)) {
    return res.status(401).send("invalid hmac");
  }
  const topic = req.get("X-Shopify-Topic") || "";
  res.status(200).send("ok"); // ack fast
  if (topic === "app/uninstalled") return void markUninstalled(storeId);
  scheduleSync(storeId);
});

/* ---- BigCommerce ---- */
webhooksRouter.post("/bigcommerce/:storeId", async (req: any, res) => {
  const storeId = parseInt(req.params.storeId, 10);
  const store = await getStore(storeId);
  if (!store) return res.status(404).send("unknown store");
  res.status(200).send("ok");
  const scope: string = req.body?.scope || "";
  if (scope === "store/app/uninstalled") return void markUninstalled(storeId);
  scheduleSync(storeId);
});

/* ---- WooCommerce ---- */
webhooksRouter.post("/woocommerce/:storeId", async (req: any, res) => {
  const storeId = parseInt(req.params.storeId, 10);
  const store = await getStore(storeId);
  if (!store) return res.status(404).send("unknown store");
  res.status(200).send("ok");
  scheduleSync(storeId);
});
