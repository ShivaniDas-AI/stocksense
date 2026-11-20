/** Suppliers, purchase orders, alerts, settings, webhooks, data & sync, API keys. */
import { Router } from "express";
import { createApiKey, listApiKeys, revokeApiKey } from "../../apikeys";
import { evaluateAlerts, getInventoryAlert, inventoryAlertAction, listInventoryAlerts } from "../../services/alertsEngine";
import { rebuild, reimport, syncStatus } from "../../services/dataSync";
import { loadDemoData, removeDemoData } from "../../services/demo";
import { boolField, invalid, notFound, onlyFields, strField } from "../../services/errors";
import { sendTestAlert } from "../../services/notifications";
import {
  createPurchaseOrder, getPurchaseOrder, listPurchaseOrders, purchaseOrderAction, purchaseOrderCsv, refreshAutoDrafts, updateDraft,
} from "../../services/purchaseOrders";
import {
  getForecastSettings, getNotificationSettings, updateForecastSettings, updateNotificationSettings,
} from "../../services/settings";
import {
  deleteSupplier, getSupplier, listCategories, listSuppliers, listVendors, updateSupplier, upsertSupplier,
} from "../../services/suppliers";
import {
  createEndpoint, deleteEndpoint, EVENTS, listDeliveries, listEndpoints, sendTest, updateEndpoint,
} from "../../services/webhooksOut";
import { h, idParam, intQuery, listParam, one, Req, sessionOnly } from "./core";

export function registerOps(r: Router) {
  /* ---------- suppliers (guide chapter 8) ---------- */
  r.get("/suppliers", h(async (req) => listSuppliers(req.storeId!, { q: req.query.q ? String(req.query.q) : undefined, page: intQuery(req, "page", { min: 1 }), limit: intQuery(req, "limit", { min: 1, max: 250 }) })));
  // Create, or update when id is given (guide chapter 14).
  r.post("/suppliers", h(async (req, res) => {
    const out = await upsertSupplier(req.storeId!, req.body ?? {});
    res.status(out.created ? 201 : 200);
    return one(out.supplier);
  }));
  r.get("/suppliers/:id", h(async (req) => one(await getSupplier(req.storeId!, idParam(req)))));
  r.patch("/suppliers/:id", h(async (req) => one(await updateSupplier(req.storeId!, idParam(req), req.body ?? {}))));
  r.delete("/suppliers/:id", h(async (req) => one(await deleteSupplier(req.storeId!, idParam(req)))));
  r.get("/vendors", h(async (req) => ({ data: await listVendors(req.storeId!) })));
  r.get("/categories", h(async (req) => ({ data: await listCategories(req.storeId!) })));

  /* ---------- purchase orders (guide chapter 7) ---------- */
  r.get("/purchase-orders", h(async (req) => listPurchaseOrders(req.storeId!, {
    status: listParam(req, "status"), supplier_id: intQuery(req, "supplier_id", { min: 1 }),
    page: intQuery(req, "page", { min: 1 }), limit: intQuery(req, "limit", { min: 1, max: 250 }),
  })));
  r.post("/purchase-orders", h(async (req) => one(await createPurchaseOrder(req.storeId!, req.body ?? {})), { status: 201 }));
  r.post("/purchase-orders/refresh-drafts", h(async (req) => one(await refreshAutoDrafts(req.storeId!))));
  r.get("/purchase-orders/:id", h(async (req) => one(await getPurchaseOrder(req.storeId!, idParam(req)))));
  r.get("/purchase-orders/:id/csv", (req: Req, res, next) => {
    getPurchaseOrder(req.storeId!, idParam(req))
      .then((po) => {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${po.number}.csv"`);
        res.send(purchaseOrderCsv(po));
      })
      .catch(next);
  });
  r.patch("/purchase-orders/:id", h(async (req) => one(await updateDraft(req.storeId!, idParam(req), req.body ?? {}))));
  // {"action": "approve" | "send" | "cancel" | "receive", "email_supplier": true, "lines": [...]}
  r.post("/purchase-orders/:id", h(async (req) => one(await purchaseOrderAction(req.storeId!, idParam(req), req.body ?? {}))));

  /* ---------- alerts (guide chapter 9) ---------- */
  r.get("/alerts", h(async (req) => listInventoryAlerts(req.storeId!, {
    status: req.query.status ? String(req.query.status).toLowerCase() : undefined,
    type: listParam(req, "type"),
    page: intQuery(req, "page", { min: 1 }), limit: intQuery(req, "limit", { min: 1, max: 250 }),
  })));
  r.post("/alerts/check", h(async (req) => one(await evaluateAlerts(req.storeId!))));
  r.get("/alerts/:id", h(async (req) => one(await getInventoryAlert(req.storeId!, idParam(req)))));
  r.post("/alerts/:id", h(async (req) => one(await inventoryAlertAction(req.storeId!, idParam(req), req.body ?? {}))));
  r.post("/alerts/:id/acknowledge", h(async (req) => one(await inventoryAlertAction(req.storeId!, idParam(req), { action: "dismiss" }))));

  /* ---------- settings (guide chapter 12) ---------- */
  r.get("/settings/forecasting", h(async (req) => one(await getForecastSettings(req.storeId!))));
  r.patch("/settings/forecasting", h(async (req) => one(await updateForecastSettings(req.storeId!, req.body ?? {}))));
  r.get("/settings/notifications", h(async (req) => one(await getNotificationSettings(req.storeId!))));
  r.patch("/settings/notifications", h(async (req) => one(await updateNotificationSettings(req.storeId!, req.body ?? {}))));
  r.post("/settings/notifications/test", h(async (req) => one(await sendTestAlert(req.storeId!))));

  /* ---------- webhooks (guide chapter 14, Pro) ---------- */
  r.get("/webhooks", h(async (req) => ({ data: await listEndpoints(req.storeId!), events: EVENTS })));
  r.post("/webhooks", h(async (req) => one(await createEndpoint(req.storeId!, req.body ?? {})), { status: 201 }));
  r.patch("/webhooks/:id", h(async (req) => one(await updateEndpoint(req.storeId!, idParam(req), req.body ?? {}))));
  r.delete("/webhooks/:id", h(async (req) => one(await deleteEndpoint(req.storeId!, idParam(req)))));
  r.post("/webhooks/:id/test", h(async (req) => one(await sendTest(req.storeId!, idParam(req)))));
  r.get("/webhooks/:id/deliveries", h(async (req) => ({ data: await listDeliveries(req.storeId!, idParam(req), intQuery(req, "limit", { min: 1, max: 200 }) ?? 50) })));

  /* ---------- data & sync ---------- */
  r.get("/data/status", h(async (req) => one(await syncStatus(req.storeId!))));
  r.post("/data/rebuild", h(async (req) => one(await rebuild(req.storeId!)), { status: 202 }));
  r.post("/data/reimport", h(async (req) => one(await reimport(req.storeId!)), { status: 202 }));
  r.post("/data/demo", h(async (req) => one(await loadDemoData(req.storeId!)), { status: 201 }));
  r.delete("/data/demo", h(async (req) => one(await removeDemoData(req.storeId!))));

  /* ---------- API keys (app session only) ---------- */
  r.get("/api-keys", sessionOnly, h(async (req) => ({ data: await listApiKeys(req.storeId!) })));
  r.post("/api-keys", sessionOnly, h(async (req) => {
    const b = req.body ?? {};
    onlyFields(b, ["name", "sandbox"]);
    const name = strField(b, "name", { required: true, max: 60 })!;
    const sandbox = boolField(b, "sandbox") ?? false;
    return one(await createApiKey(req.storeId!, name, sandbox ? "sandbox" : "live"));
  }, { status: 201 }));
  r.delete("/api-keys/:id", sessionOnly, h(async (req) => {
    const id = idParam(req);
    if (!(await revokeApiKey(req.storeId!, id))) throw notFound("API key", id);
    return one({ id, revoked: true });
  }));
}

export { invalid };
