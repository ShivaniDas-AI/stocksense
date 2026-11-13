import { Router } from "express";
import { getSessionStoreId } from "./auth";
import {
  acknowledgeAlert,
  getStoreInfo,
  getSummary,
  getVariantDetail,
  listAlerts,
  listRisks,
  updateVariantSettings,
} from "../services/inventory";
import { createApiKey, listApiKeys, revokeApiKey } from "../apikeys";

/**
 * App API used by the web dashboard and the mobile app (session cookie or
 * session bearer token). The public, API-key-based API lives in routes/v1.ts
 * and shares its queries through services/inventory.ts.
 */
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
  const s = await getStoreInfo(req.storeId);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

/** GET /api/summary — dashboard header cards + KPIs */
apiRouter.get("/summary", async (req: any, res) => {
  res.json(await getSummary(req.storeId));
});

/** GET /api/risks?level=critical,low_stock&q=air&limit=50&offset=0 */
apiRouter.get("/risks", async (req: any, res) => {
  const r = await listRisks(req.storeId, {
    levels: req.query.level ? String(req.query.level).split(",").filter(Boolean) : undefined,
    q: String(req.query.q || ""),
    limit: parseInt(String(req.query.limit || "100"), 10),
    offset: parseInt(String(req.query.offset || "0"), 10),
  });
  if (!r.run_date) return res.json({ items: [] });
  res.json({ run_date: r.run_date, items: r.items });
});

/** GET /api/variants/:id — detail: 90d history + forecast curve */
apiRouter.get("/variants/:id", async (req: any, res) => {
  const d = await getVariantDetail(req.storeId, parseInt(req.params.id, 10));
  if (!d) return res.status(404).json({ error: "not found" });
  res.json(d);
});

/** PATCH /api/variants/:id — merchant edits lead time / safety stock */
apiRouter.patch("/variants/:id", async (req: any, res) => {
  await updateVariantSettings(req.storeId, parseInt(req.params.id, 10), req.body ?? {});
  res.json({ ok: true });
});

/** GET /api/alerts — recent alerts */
apiRouter.get("/alerts", async (req: any, res) => {
  res.json({ items: await listAlerts(req.storeId) });
});

/** POST /api/alerts/:id/ack */
apiRouter.post("/alerts/:id/ack", async (req: any, res) => {
  await acknowledgeAlert(req.storeId, parseInt(req.params.id, 10));
  res.json({ ok: true });
});

/* ---------------- API key management (for the public /v1 API) ---------------- */

/** GET /api/keys — keys for the active store (never the secret itself) */
apiRouter.get("/keys", async (req: any, res) => {
  res.json({ items: await listApiKeys(req.storeId) });
});

/** POST /api/keys { name } — create a key; the full secret is returned only here, once */
apiRouter.post("/keys", async (req: any, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 60) || "API key";
  const created = await createApiKey(req.storeId, name);
  res.status(201).json(created);
});

/** DELETE /api/keys/:id — revoke a key immediately */
apiRouter.delete("/keys/:id", async (req: any, res) => {
  const ok = await revokeApiKey(req.storeId, parseInt(req.params.id, 10));
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});
