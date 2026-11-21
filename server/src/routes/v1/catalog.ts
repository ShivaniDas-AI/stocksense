/** Store, plan, insights, forecasts, reorder, locations, transfers, promotions, jobs. */
import { Router } from "express";
import { queryOne } from "../../db";
import { PLANS, storePlan } from "../../plans";
import { getDashboard, planUsage } from "../../services/dashboard";
import { getKpiDetail } from "../../services/insights";
import { notFound } from "../../services/errors";
import {
  forecastsCsv, getForecastDetail, listForecasts, updateOrderingSettings,
} from "../../services/forecasts";
import {
  getForecastJob, getStoreInfo, getSummary, getVariantDetail, listRisks, queueForecast, RiskSort, ALL_LEVELS, updateVariantSettings,
} from "../../services/inventory";
import {
  createLocation, listLocations, locationInventory, setLocationInventory, updateLocation,
} from "../../services/locations";
import { createPromotion, deletePromotion, listPromotions, updatePromotion } from "../../services/promotions";
import { createPurchaseOrder, addToDraft } from "../../services/purchaseOrders";
import { getReorderPlan, parseReorderParams, saveReorderPreferences } from "../../services/reorder";
import { createTransfer, getTransfer, listTransfers, transferAction, transferSuggestions } from "../../services/transfers";
import { boolField, intField, invalid, onlyFields, strField } from "../../services/errors";
import { boolQuery, h, idParam, intQuery, listParam, one, Req } from "./core";

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

export function registerCatalog(r: Router) {
  /* ---------- store and plan ---------- */
  r.get("/store", h(async (req) => {
    const s: any = await getStoreInfo(req.storeId!);
    if (!s) throw notFound("store", req.storeId!);
    const extra = await queryOne("SELECT name, plan, plan_interval, trial_ends_at, is_demo FROM stores WHERE id=$1", [req.storeId]);
    return one({
      id: Number(s.id), name: extra?.name ?? null, platform: s.platform, domain: s.store_domain, currency: s.currency,
      sync_status: s.sync_status, sync_error: s.sync_error ?? null, plan: extra?.plan, demo: !!extra?.is_demo,
    });
  }));

  r.get("/plan", h(async (req) => {
    const plan = await storePlan(req.storeId!);
    const s = await queryOne("SELECT plan_interval, trial_ends_at FROM stores WHERE id=$1", [req.storeId]);
    const usage = await planUsage(req.storeId!);
    return one({
      plan: plan.id, name: plan.name, interval: s?.plan_interval, trial_ends_at: s?.trial_ends_at,
      price: s?.plan_interval === "yearly" ? plan.price_yearly : plan.price_monthly,
      limits: { skus: plan.sku_limit, locations: plan.location_limit, ask_questions_per_month: plan.ask_monthly_limit, forecast_rebuild: plan.rebuild },
      usage,
      features: plan.features,
      all_plans: Object.values(PLANS).map((p) => ({ id: p.id, name: p.name, price_monthly: p.price_monthly, price_yearly: p.price_yearly })),
    });
  }));

  /* ---------- insights ---------- */
  r.get("/summary", h(async (req) => {
    const s: any = await getSummary(req.storeId!);
    if (!s.ready) {
      return one({ ready: false, forecast_job_status: s.forecast_job, forecast_error: s.forecast_error, variants_total: s.variants_total, variants_tracked: s.variants_tracked, has_sales: s.has_sales });
    }
    return one({
      ready: true, run_date: s.run_date,
      counts: { forecasted: s.skus_forecasted, tracked: s.skus_tracked, at_risk: s.at_risk, critical: s.critical, low_stock: s.low_stock, healthy: s.healthy, overstocked: s.overstocked, no_demand: s.no_demand, untracked: s.untracked },
      revenue_at_risk: s.revenue_at_risk, kpis: s.kpis,
    });
  }));

  r.get("/dashboard", h(async (req) => one(await getDashboard(req.storeId!, { location_id: intQuery(req, "location_id", { min: 1 }) }))));
  r.get("/kpis/:metric", h(async (req) => one(await getKpiDetail(req.storeId!, String(req.params.metric)))));

  /* ---------- forecasts (guide chapters 4 and 5) ---------- */
  r.get("/forecasts.csv", (req: Req, res, next) => {
    forecastsCsv(req.storeId!, { status: listParam(req, "status"), location_id: intQuery(req, "location_id", { min: 1 }), q: String(req.query.q || "") })
      .then((csv) => {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="forecasts-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(csv);
      })
      .catch(next);
  });

  r.get("/forecasts", h(async (req) =>
    listForecasts(req.storeId!, {
      status: listParam(req, "status"),
      location_id: intQuery(req, "location_id", { min: 1 }),
      q: String(req.query.q || "").trim() || undefined,
      limit: intQuery(req, "limit", { min: 1, max: 250 }),
      page: intQuery(req, "page", { min: 1 }),
      sort: req.query.sort ? String(req.query.sort) : undefined,
    })
  ));

  // Rebuild every forecast now. POST /forecasts (no body) is kept as an alias.
  const rebuild = h(async (req) => {
    const job = await queueForecast(req.storeId!);
    return one({ id: Number(job.id), status: job.status, started_at: job.started_at, finished_at: job.finished_at, error: job.error });
  }, { status: 202 });
  r.post("/forecasts/rebuild", rebuild);
  r.post("/forecasts", rebuild);

  r.get("/forecasts/:variantId", h(async (req) => one(await getForecastDetail(req.storeId!, idParam(req, "variantId"), { location_id: intQuery(req, "location_id", { min: 1 }) }))));
  r.patch("/forecasts/:variantId/settings", h(async (req) => one(await updateOrderingSettings(req.storeId!, idParam(req, "variantId"), req.body ?? {}))));

  r.get("/jobs/:id", h(async (req) => {
    const job = await getForecastJob(req.storeId!, idParam(req));
    if (!job) throw notFound("job", req.params.id);
    return one({ id: Number(job.id), status: job.status, started_at: job.started_at, finished_at: job.finished_at, error: job.error });
  }));

  /* ---------- reorder (guide chapter 6) ---------- */
  r.get("/reorder/:variantId", h(async (req) => one(await getReorderPlan(req.storeId!, idParam(req, "variantId"), parseReorderParams(req.query)))));
  r.post("/reorder/:variantId/preferences", h(async (req) => one(await saveReorderPreferences(req.storeId!, idParam(req, "variantId"), req.body ?? {}))));

  /**
   * Step 5: create the purchase order from the reorder screen.
   * { supplier_id?, quantity?, unit_cost?, add_to?: "new" | <draft id>, notes?, also?: [{variant_id, quantity}],
   *   save_preferences?: true, coverage_days?, lead_time_days?, case_pack?, min_order_qty? }
   */
  r.post("/reorder/:variantId/purchase-order", h(async (req) => {
    const vid = idParam(req, "variantId");
    const b = req.body ?? {};
    onlyFields(b, ["supplier_id", "quantity", "unit_cost", "add_to", "notes", "also", "save_preferences", "coverage_days", "lead_time_days", "case_pack", "min_order_qty", "location_id"]);
    const plan = await getReorderPlan(req.storeId!, vid, parseReorderParams(b));
    const supplierId = plan.supplier_id;
    if (!supplierId) throw invalid("no_supplier", "Choose a supplier (supplier_id) to create a purchase order.", "supplier_id");
    const qty = intField(b, "quantity", { min: 1 }) ?? plan.suggested_quantity;
    if (!qty) throw invalid("nothing_to_order", "The suggested quantity is 0. Send quantity to order anyway.", "quantity");
    const lines = [{ variant_id: vid, quantity: qty, unit_cost: b.unit_cost }];
    if (b.also !== undefined) {
      if (!Array.isArray(b.also)) throw invalid("invalid_value", "also must be a list of {variant_id, quantity}.", "also");
      for (const a of b.also) lines.push({ variant_id: a.variant_id, quantity: a.quantity, unit_cost: a.unit_cost });
    }
    if (boolField(b, "save_preferences") ?? true) {
      await saveReorderPreferences(req.storeId!, vid, {
        supplier_id: supplierId,
        ...(b.case_pack !== undefined ? { case_pack: b.case_pack } : {}),
        ...(b.min_order_qty !== undefined ? { min_order_qty: b.min_order_qty } : {}),
        ...(b.lead_time_days !== undefined ? { lead_time_days: b.lead_time_days } : {}),
      });
    }
    const addTo = b.add_to === undefined || b.add_to === "new" ? null : intField(b, "add_to", { min: 1 });
    const po = addTo
      ? await addToDraft(req.storeId!, addTo, lines, strField(b, "notes", { max: 2000 }))
      : await createPurchaseOrder(req.storeId!, { supplier_id: supplierId, lines, notes: b.notes, location_id: b.location_id });
    return one(po);
  }, { status: 201 }));

  /* ---------- products (v1 shape kept for existing integrations) ---------- */
  r.get("/products", h(async (req) => {
    const risk = listParam(req, "risk_level");
    const bad = risk?.find((l) => !(ALL_LEVELS as readonly string[]).includes(l));
    if (bad) throw invalid("invalid_risk_level", `Unknown risk_level '${bad}'. Use any of: ${ALL_LEVELS.join(", ")}.`, "risk_level");
    const sort = String(req.query.sort || "risk") as RiskSort;
    if (!["risk", "stockout", "revenue_at_risk", "stock", "name"].includes(sort)) throw invalid("invalid_sort", "sort must be risk, stockout, revenue_at_risk, stock or name.", "sort");
    const limit = intQuery(req, "limit", { min: 1, max: 200 }) ?? 50;
    const offset = intQuery(req, "offset", { min: 0 }) ?? 0;
    const x = await listRisks(req.storeId!, { levels: risk, q: String(req.query.q || ""), limit, offset, sort });
    const more = offset + x.items.length < x.total;
    return {
      data: x.items.map((p: any) => {
        const tracked = p.risk_level !== "untracked";
        return {
          id: Number(p.variant_id), sku: p.sku ?? null, title: p.title, image_url: p.image_url ?? null, price: num(p.price), risk_level: p.risk_level,
          stock: { on_hand: tracked ? Number(p.current_stock) : null, tracked }, days_of_cover: num(p.days_of_stock), stockout_date: p.stockout_date ?? null,
          reorder_point: num(p.reorder_point), reorder_quantity: num(p.reorder_qty), revenue_at_risk: num(p.revenue_at_risk) ?? 0,
          demand: { avg_daily: num(p.avg_daily_demand), model: p.model_used ?? null },
          settings: { lead_time_days: Number(p.lead_time_days), safety_stock: Number(p.safety_stock) },
        };
      }),
      run_date: x.run_date, total: x.total, has_more: more, next_offset: more ? offset + x.items.length : null,
    };
  }));
  r.get("/products/:id", h(async (req) => {
    const id = idParam(req);
    const d = await getVariantDetail(req.storeId!, id, intQuery(req, "history_days", { min: 1, max: 365 }) ?? 90);
    if (!d) throw notFound("product", id);
    const { variant: v, history, forecast: f, risk: rk } = d;
    const daily = f ? (typeof f.daily_forecast === "string" ? JSON.parse(f.daily_forecast) : f.daily_forecast) : [];
    const tracked = rk ? rk.risk_level !== "untracked" : !!v.track_inventory;
    return one({
      id: Number(v.id), sku: v.sku ?? null, title: v.title || v.product_title, product_title: v.product_title, image_url: v.image_url ?? null,
      price: num(v.price), risk_level: rk?.risk_level ?? null, stock: { on_hand: tracked ? Number(rk?.current_stock ?? v.current_stock ?? 0) : null, tracked },
      days_of_cover: num(rk?.days_of_stock), stockout_date: rk?.stockout_date ?? null, reorder_point: num(rk?.reorder_point), reorder_quantity: num(rk?.reorder_qty),
      revenue_at_risk: num(rk?.revenue_at_risk) ?? 0, settings: { lead_time_days: Number(v.lead_time_days), safety_stock: Number(v.safety_stock) },
      forecast: f ? { run_date: f.run_date, model: f.model_used, avg_daily_demand: num(f.avg_daily_demand), daily: daily.map((p: any) => ({ date: p.d, units: Number(p.y) })) } : null,
      sales_history: history.map((x: any) => ({ date: x.sale_date, units: Number(x.units_sold) })),
    });
  }));
  r.patch("/products/:id", h(async (req) => {
    const id = idParam(req);
    const body = req.body ?? {};
    onlyFields(body, ["lead_time_days", "safety_stock"]);
    if (!Object.keys(body).length) throw invalid("invalid_body", "Send lead_time_days and/or safety_stock.");
    intField(body, "lead_time_days", { min: 1, max: 365 });
    intField(body, "safety_stock", { min: 0 });
    if (!(await updateVariantSettings(req.storeId!, id, body))) throw notFound("product", id);
    if (body.lead_time_days !== undefined) await updateOrderingSettings(req.storeId!, id, { lead_time_days: body.lead_time_days });
    const d = await getVariantDetail(req.storeId!, id);
    return one({ id, settings: { lead_time_days: Number(d!.variant.lead_time_days), safety_stock: Number(d!.variant.safety_stock) } });
  }));

  /* ---------- locations ---------- */
  r.get("/locations", h(async (req) => ({ data: await listLocations(req.storeId!) })));
  r.post("/locations", h(async (req) => one(await createLocation(req.storeId!, req.body ?? {})), { status: 201 }));
  r.patch("/locations/:id", h(async (req) => one(await updateLocation(req.storeId!, idParam(req), req.body ?? {}))));
  r.get("/locations/:id/inventory", h(async (req) => ({ data: await locationInventory(req.storeId!, idParam(req)) })));
  r.put("/locations/:id/inventory", h(async (req) => one(await setLocationInventory(req.storeId!, idParam(req), req.body ?? {}))));

  /* ---------- transfers (guide chapter 10) ---------- */
  r.get("/transfers/suggestions", h(async (req) => one(await transferSuggestions(req.storeId!))));
  r.get("/transfers", h(async (req) => listTransfers(req.storeId!, { status: req.query.status ? String(req.query.status) : undefined, page: intQuery(req, "page", { min: 1 }), limit: intQuery(req, "limit", { min: 1, max: 250 }) })));
  r.post("/transfers", h(async (req) => one(await createTransfer(req.storeId!, req.body ?? {})), { status: 201 }));
  r.get("/transfers/:id", h(async (req) => one(await getTransfer(req.storeId!, idParam(req)))));
  r.post("/transfers/:id", h(async (req) => one(await transferAction(req.storeId!, idParam(req), req.body ?? {}))));

  /* ---------- promotions ---------- */
  r.get("/promotions", h(async (req) => ({ data: await listPromotions(req.storeId!, { include_past: boolQuery(req, "include_past") }) })));
  r.post("/promotions", h(async (req) => one(await createPromotion(req.storeId!, req.body ?? {})), { status: 201 }));
  r.patch("/promotions/:id", h(async (req) => one(await updatePromotion(req.storeId!, idParam(req), req.body ?? {}))));
  r.delete("/promotions/:id", h(async (req) => one(await deletePromotion(req.storeId!, idParam(req)))));
}
