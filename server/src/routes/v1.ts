/**
 * StockSense public API, version 1.
 *
 *   Auth      Authorization: Bearer ss_live_...   (or X-API-Key: ss_live_...)
 *   Scope     each key sees exactly one store
 *   Limits    120 requests per minute per key (X-RateLimit-* headers)
 *   Objects   { "data": {...} }
 *   Lists     { "data": [...], "has_more": bool, "next_offset": n | null, "total": n }
 *   Errors    { "error": { "type", "code", "message" } } with a matching HTTP status
 *
 * Spec: GET /v1/openapi.json   Docs: GET /docs
 */
import crypto from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import { verifyApiKey } from "../apikeys";
import { openApiSpec } from "../openapi";
import {
  acknowledgeAlert,
  ALL_LEVELS,
  getForecastJob,
  getStoreInfo,
  getSummary,
  getVariantDetail,
  listAlerts,
  listRisks,
  queueForecast,
  RiskSort,
  updateVariantSettings,
} from "../services/inventory";

export const v1Router = Router();

type Req = Request & { storeId?: number; keyId?: number; requestId?: string };

/* ---------------- helpers ---------------- */

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const int = (v: unknown, fallback: number) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
};

function fail(res: Response, status: number, type: string, code: string, message: string) {
  return res.status(status).json({ error: { type, code, message } });
}

/** Express 4 does not catch rejected promises; route them to the error handler. */
const wrap = (fn: (req: Req, res: Response) => Promise<unknown>) => (req: Req, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

/* ---------------- public: spec ---------------- */

v1Router.get("/openapi.json", (_req, res) => res.json(openApiSpec()));

/* ---------------- request id, auth, rate limit ---------------- */

v1Router.use((req: Req, res, next) => {
  req.requestId = "req_" + crypto.randomBytes(8).toString("hex");
  res.setHeader("X-Request-Id", req.requestId);
  next();
});

v1Router.use((req: Req, res, next) => {
  (async () => {
    const auth = req.get("authorization") || "";
    const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const secret = bearer || req.get("x-api-key")?.trim() || "";
    if (!secret) {
      return fail(res, 401, "authentication_error", "missing_api_key", "Send your key as 'Authorization: Bearer ss_live_...' or 'X-API-Key'. Create keys in the StockSense app under Settings > API keys.");
    }
    const key = await verifyApiKey(secret);
    if (!key) {
      return fail(res, 401, "authentication_error", "invalid_api_key", "This API key is not valid or has been revoked.");
    }
    req.storeId = key.storeId;
    req.keyId = key.id;
    next();
  })().catch(next);
});

const LIMIT = 120;
const WINDOW_MS = 60_000;
const buckets = new Map<number, { start: number; count: number }>();

v1Router.use((req: Req, res, next) => {
  const now = Date.now();
  const id = req.keyId!;
  let b = buckets.get(id);
  if (!b || now - b.start >= WINDOW_MS) {
    b = { start: now, count: 0 };
    buckets.set(id, b);
  }
  b.count++;
  const reset = Math.ceil((b.start + WINDOW_MS) / 1000);
  res.setHeader("X-RateLimit-Limit", String(LIMIT));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, LIMIT - b.count)));
  res.setHeader("X-RateLimit-Reset", String(reset));
  if (b.count > LIMIT) {
    res.setHeader("Retry-After", String(Math.max(1, reset - Math.floor(now / 1000))));
    return fail(res, 429, "rate_limit_error", "rate_limited", `Limit of ${LIMIT} requests per minute reached. Retry after the time in the Retry-After header.`);
  }
  next();
});

/* ---------------- formatters (stable public shapes, numbers as numbers) ---------------- */

function productFromRisk(r: any) {
  const tracked = r.risk_level !== "untracked";
  return {
    id: Number(r.variant_id),
    sku: r.sku ?? null,
    title: r.title,
    image_url: r.image_url ?? null,
    price: num(r.price),
    risk_level: r.risk_level,
    stock: { on_hand: tracked ? Number(r.current_stock) : null, tracked },
    days_of_cover: num(r.days_of_stock),
    stockout_date: r.stockout_date ?? null,
    reorder_point: num(r.reorder_point),
    reorder_quantity: num(r.reorder_qty),
    revenue_at_risk: num(r.revenue_at_risk) ?? 0,
    demand: { avg_daily: num(r.avg_daily_demand), model: r.model_used ?? null },
    settings: { lead_time_days: Number(r.lead_time_days), safety_stock: Number(r.safety_stock) },
  };
}

function productFromDetail(d: NonNullable<Awaited<ReturnType<typeof getVariantDetail>>>) {
  const { variant: v, history, forecast: f, risk: r } = d;
  const tracked = r ? r.risk_level !== "untracked" : !!v.track_inventory;
  const daily = f ? ((typeof f.daily_forecast === "string" ? JSON.parse(f.daily_forecast) : f.daily_forecast) as { d: string; y: number }[]) : [];
  return {
    id: Number(v.id),
    sku: v.sku ?? null,
    title: v.title || v.product_title,
    product_title: v.product_title,
    image_url: v.image_url ?? null,
    price: num(v.price),
    risk_level: r?.risk_level ?? null,
    stock: { on_hand: tracked ? Number(r?.current_stock ?? v.current_stock ?? 0) : null, tracked },
    days_of_cover: num(r?.days_of_stock),
    stockout_date: r?.stockout_date ?? null,
    reorder_point: num(r?.reorder_point),
    reorder_quantity: num(r?.reorder_qty),
    revenue_at_risk: num(r?.revenue_at_risk) ?? 0,
    settings: { lead_time_days: Number(v.lead_time_days), safety_stock: Number(v.safety_stock) },
    forecast: f
      ? {
          run_date: f.run_date,
          model: f.model_used,
          avg_daily_demand: num(f.avg_daily_demand),
          daily: daily.map((p) => ({ date: p.d, units: Number(p.y) })),
        }
      : null,
    sales_history: history.map((h: any) => ({ date: h.sale_date, units: Number(h.units_sold) })),
  };
}

function storeOut(s: any) {
  return {
    id: Number(s.id),
    platform: s.platform,
    domain: s.store_domain,
    currency: s.currency,
    sync_status: s.sync_status,
    sync_error: s.sync_error ?? null,
  };
}

function jobOut(j: any) {
  return {
    id: Number(j.id),
    status: j.status,
    started_at: j.started_at ?? null,
    finished_at: j.finished_at ?? null,
    error: j.error ?? null,
  };
}

/* ---------------- routes ---------------- */

v1Router.get(
  "/store",
  wrap(async (req, res) => {
    const s = await getStoreInfo(req.storeId!);
    if (!s) return fail(res, 404, "not_found", "store_not_found", "The store for this key no longer exists.");
    res.json({ data: storeOut(s) });
  })
);

v1Router.get(
  "/summary",
  wrap(async (req, res) => {
    const s: any = await getSummary(req.storeId!);
    if (!s.ready) {
      return res.json({
        data: {
          ready: false,
          forecast_job_status: s.forecast_job,
          forecast_error: s.forecast_error,
          variants_total: s.variants_total,
          variants_tracked: s.variants_tracked,
          has_sales: s.has_sales,
        },
      });
    }
    res.json({
      data: {
        ready: true,
        run_date: s.run_date,
        counts: {
          forecasted: s.skus_forecasted,
          tracked: s.skus_tracked,
          at_risk: s.at_risk,
          critical: s.critical,
          low_stock: s.low_stock,
          healthy: s.healthy,
          overstocked: s.overstocked,
          no_demand: s.no_demand,
          untracked: s.untracked,
        },
        revenue_at_risk: s.revenue_at_risk,
        kpis: s.kpis,
      },
    });
  })
);

const SORTS: RiskSort[] = ["risk", "stockout", "revenue_at_risk", "stock", "name"];

v1Router.get(
  "/products",
  wrap(async (req, res) => {
    const risk = req.query.risk_level ? String(req.query.risk_level).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const bad = risk?.find((l) => !(ALL_LEVELS as readonly string[]).includes(l));
    if (bad) return fail(res, 400, "invalid_request_error", "invalid_risk_level", `Unknown risk_level '${bad}'. Use any of: ${ALL_LEVELS.join(", ")}.`);
    const sort = String(req.query.sort || "risk") as RiskSort;
    if (!SORTS.includes(sort)) return fail(res, 400, "invalid_request_error", "invalid_sort", `Unknown sort '${sort}'. Use one of: ${SORTS.join(", ")}.`);
    const limit = Math.min(Math.max(int(req.query.limit, 50), 1), 200);
    const offset = Math.max(int(req.query.offset, 0), 0);

    const r = await listRisks(req.storeId!, { levels: risk, q: String(req.query.q || ""), limit, offset, sort });
    const hasMore = offset + r.items.length < r.total;
    res.json({
      data: r.items.map(productFromRisk),
      run_date: r.run_date,
      total: r.total,
      has_more: hasMore,
      next_offset: hasMore ? offset + r.items.length : null,
    });
  })
);

v1Router.get(
  "/products/:id",
  wrap(async (req, res) => {
    const id = int(req.params.id, NaN);
    if (!Number.isFinite(id)) return fail(res, 400, "invalid_request_error", "invalid_id", "Product id must be a number.");
    const d = await getVariantDetail(req.storeId!, id, int(req.query.history_days, 90));
    if (!d) return fail(res, 404, "not_found", "product_not_found", `No product ${id} in this store.`);
    res.json({ data: productFromDetail(d) });
  })
);

v1Router.patch(
  "/products/:id",
  wrap(async (req, res) => {
    const id = int(req.params.id, NaN);
    if (!Number.isFinite(id)) return fail(res, 400, "invalid_request_error", "invalid_id", "Product id must be a number.");
    const body = req.body ?? {};
    const keys = Object.keys(body);
    const allowed = ["lead_time_days", "safety_stock"];
    const unknown = keys.find((k) => !allowed.includes(k));
    if (!keys.length || unknown) {
      return fail(res, 400, "invalid_request_error", "invalid_body", `Send a JSON body with lead_time_days and/or safety_stock${unknown ? `; '${unknown}' is not a settable field` : ""}.`);
    }
    for (const k of keys) {
      const v = Number(body[k]);
      const min = k === "lead_time_days" ? 1 : 0;
      if (!Number.isInteger(v) || v < min) return fail(res, 400, "invalid_request_error", "invalid_value", `${k} must be a whole number of at least ${min}.`);
    }
    const ok = await updateVariantSettings(req.storeId!, id, body);
    if (!ok) return fail(res, 404, "not_found", "product_not_found", `No product ${id} in this store.`);
    const d = await getVariantDetail(req.storeId!, id);
    res.json({ data: productFromDetail(d!) });
  })
);

v1Router.get(
  "/alerts",
  wrap(async (req, res) => {
    const items = await listAlerts(req.storeId!, {
      unacknowledged: String(req.query.unacknowledged) === "true",
      limit: int(req.query.limit, 50),
    });
    res.json({
      data: items.map((a: any) => ({
        id: Number(a.id),
        product_id: Number(a.variant_id),
        product_title: a.title,
        sku: a.sku ?? null,
        type: a.alert_type,
        risk_level: a.risk_level,
        sent_at: a.sent_at,
        acknowledged: !!a.acknowledged,
      })),
      has_more: false,
      next_offset: null,
    });
  })
);

v1Router.post(
  "/alerts/:id/acknowledge",
  wrap(async (req, res) => {
    const id = int(req.params.id, NaN);
    if (!Number.isFinite(id)) return fail(res, 400, "invalid_request_error", "invalid_id", "Alert id must be a number.");
    const ok = await acknowledgeAlert(req.storeId!, id);
    if (!ok) return fail(res, 404, "not_found", "alert_not_found", `No alert ${id} in this store.`);
    res.json({ data: { id, acknowledged: true } });
  })
);

v1Router.post(
  "/forecasts",
  wrap(async (req, res) => {
    const job = await queueForecast(req.storeId!);
    res.status(202).json({ data: jobOut(job) });
  })
);

v1Router.get(
  "/forecasts/:id",
  wrap(async (req, res) => {
    const id = int(req.params.id, NaN);
    if (!Number.isFinite(id)) return fail(res, 400, "invalid_request_error", "invalid_id", "Job id must be a number.");
    const job = await getForecastJob(req.storeId!, id);
    if (!job) return fail(res, 404, "not_found", "job_not_found", `No forecast job ${id} for this store.`);
    res.json({ data: jobOut(job) });
  })
);

/* ---------------- fallthrough + errors ---------------- */

v1Router.use((req: Req, res) => fail(res, 404, "not_found", "route_not_found", `No route ${req.method} ${req.originalUrl}. See /docs.`));

v1Router.use((err: any, req: Req, res: Response, _next: NextFunction) => {
  console.error(`[v1 ${req.requestId}]`, err?.message || err);
  if (err?.type === "entity.parse.failed") return fail(res, 400, "invalid_request_error", "invalid_json", "The request body is not valid JSON.");
  fail(res, 500, "api_error", "internal_error", `Something went wrong. Quote request id ${req.requestId} when reporting it.`);
});
