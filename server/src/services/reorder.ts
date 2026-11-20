/**
 * The reorder screen (guide chapter 6) as an API: compare every supplier,
 * show the quantity calculation line by line, the effect on stock with and
 * without the order, warnings, other products from the same supplier, and
 * save the preferred supplier and ordering rules.
 */
import { query, queryOne } from "../db";
import { boolField, intField, invalid, notFound, numField, onlyFields } from "./errors";
import {
  addDays, computeQuantity, demandSeries, demandStdDev, loadVariantContext, QuantityInputs, STATUS_SQL, todayYmd, walkStock,
} from "./forecasts";
import { latestRunDate, queueForecast } from "./inventory";

const r1 = (v: number) => Math.round(v * 10) / 10;

export interface ReorderParams {
  supplier_id?: number;
  coverage_days?: number;
  lead_time_days?: number;
  case_pack?: number;
  min_order_qty?: number;
}

export function parseReorderParams(q: any): ReorderParams {
  return {
    supplier_id: intField(q, "supplier_id", { min: 1 }),
    coverage_days: intField(q, "coverage_days", { min: 1, max: 365 }),
    lead_time_days: intField(q, "lead_time_days", { min: 1, max: 365 }),
    case_pack: intField(q, "case_pack", { min: 1, max: 10000 }),
    min_order_qty: intField(q, "min_order_qty", { min: 0, max: 1000000 }),
  };
}

export async function getReorderPlan(storeId: number, variantId: number, params: ReorderParams = {}) {
  const ctx = await loadVariantContext(storeId, variantId);
  const { v, risk, fc, daily, settings } = ctx;
  const today = todayYmd();
  const avg = Number(fc?.avg_daily_demand ?? 0);
  const onHand = Number(v.current_stock ?? 0);
  const onOrder = Number(v.on_order ?? 0);
  const { std: demandStd } = await demandStdDev(variantId);

  const coverage = params.coverage_days ?? settings.coverage_days;
  const casePack = params.case_pack ?? Number(v.case_pack);
  const moq = params.min_order_qty ?? Number(v.min_order_qty);
  const overrideLT = params.lead_time_days ?? (v.lead_time_override != null ? Number(v.lead_time_override) : undefined);

  const suppliers = await query(
    `SELECT s.*, sls.effective_days, sls.deliveries_90d, sls.stddev_days
       FROM suppliers s JOIN supplier_lead_stats sls ON sls.supplier_id = s.id
      WHERE s.store_id=$1 ORDER BY s.name`,
    [storeId]
  );
  const catPref = v.product_type
    ? await queryOne("SELECT supplier_id FROM supplier_categories WHERE store_id=$1 AND category=$2", [storeId, v.product_type])
    : null;
  const vendorMaker = v.vendor
    ? await queryOne("SELECT supplier_id FROM supplier_vendors WHERE store_id=$1 AND vendor=$2", [storeId, v.vendor])
    : null;

  const currentId = v.resolved_supplier_id ? Number(v.resolved_supplier_id) : null;
  const chosenId = params.supplier_id ?? currentId;
  if (params.supplier_id && !suppliers.some((s: any) => Number(s.id) === params.supplier_id)) {
    throw invalid("unknown_supplier", `No supplier ${params.supplier_id} in this store.`, "supplier_id");
  }

  const horizonFor = (lt: number) => Math.max(56, lt + coverage + 14);
  const calc = (lt: number, ltStd: number) => {
    const series = demandSeries(daily, today, horizonFor(lt), avg);
    const inputs: QuantityInputs = { lead_time_days: lt, coverage_days: coverage, case_pack: casePack, min_order_qty: moq };
    return {
      series,
      ...computeQuantity({
        series, onHand, onOrder, inputs, demandStd, leadTimeStd: ltStd,
        serviceLevel: settings.service_level, minSafetyStock: Number(v.safety_stock ?? 0),
      }),
    };
  };

  // Step 1: every supplier side by side. Slower suppliers need bigger orders.
  const rows = suppliers.map((s: any) => {
    const lt = overrideLT ?? Number(s.effective_days);
    const q = calc(lt, Number(s.stddev_days ?? 0));
    return {
      supplier_id: Number(s.id),
      name: s.name,
      lead_time_days: lt,
      lead_time_basis: overrideLT ? "this product" : Number(s.deliveries_90d) > 0 ? `${s.deliveries_90d} deliveries` : "supplier setting",
      arrives_on: addDays(today, lt),
      quantity: q.suggested_quantity,
      unit_cost: v.cost != null ? Number(v.cost) : null,
      min_order_value: s.min_order_value != null ? Number(s.min_order_value) : null,
      tags: [
        ...(Number(s.id) === currentId ? ["current"] : []),
        ...(catPref && Number(catPref.supplier_id) === Number(s.id) ? ["preferred_for_category"] : []),
        ...(vendorMaker && Number(vendorMaker.supplier_id) === Number(s.id) ? ["makes_vendor"] : []),
      ],
      selected: Number(s.id) === chosenId,
    };
  });

  const chosen = suppliers.find((s: any) => Number(s.id) === chosenId);
  const lt = overrideLT ?? (chosen ? Number(chosen.effective_days) : settings.default_lead_time_days);
  const main = calc(lt, chosen ? Number(chosen.stddev_days ?? 0) : 0);
  const arrivesOn = addDays(today, lt);

  // Step 3: stock with and without the order, day by day.
  const existing = (
    await query(
      `SELECT COALESCE(po.expected_at, CURRENT_DATE + $2::int) AS date, SUM(GREATEST(l.quantity - l.received_qty,0))::int AS qty
         FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
        WHERE l.variant_id=$1 AND po.status IN ('approved','sent','partial') GROUP BY 1`,
      [variantId, lt]
    )
  ).map((a: any) => ({ date: String(a.date).slice(0, 10), qty: Number(a.qty) }));
  const without = walkStock(main.series, onHand, existing);
  const withOrder = walkStock(main.series, onHand, [...existing, { date: arrivesOn, qty: main.suggested_quantity }]);
  const effect = main.series.map((p, i) => ({
    date: p.date,
    without_order: without.curve[i].stock,
    with_order: withOrder.curve[i].stock,
    safety_stock: main.breakdown.safety_stock,
  }));

  // Warnings.
  const warnings: { code: string; message: string }[] = [];
  const outDays = without.runsOutInDays;
  if (outDays !== null && outDays < lt) {
    const fastest = rows.slice().sort((a, b) => a.lead_time_days - b.lead_time_days)[0];
    warnings.push({
      code: "stockout_before_arrival",
      message: `Runs out in ${outDays} day${outDays === 1 ? "" : "s"}, ${lt - outDays} day${lt - outDays === 1 ? "" : "s"} before an order placed today can arrive.` +
        (fastest && fastest.supplier_id !== chosenId ? ` Fastest supplier: ${fastest.name} (${fastest.lead_time_days} days). Consider a small rush order or moving stock from another location.` : " Consider a small rush order or moving stock from another location."),
    });
  }
  const openPos = await query(
    `SELECT po.id, po.number, po.status, l.quantity FROM purchase_order_lines l
       JOIN purchase_orders po ON po.id = l.purchase_order_id
      WHERE l.variant_id=$1 AND po.status IN ('draft','approved','sent','partial') ORDER BY po.created_at DESC`,
    [variantId]
  );
  if (openPos.length) {
    warnings.push({
      code: "already_on_order",
      message: `Already on ${openPos.map((p: any) => `PO-${p.number} (${p.status}, ${p.quantity} units)`).join(", ")}.`,
    });
  }
  if (!chosen) warnings.push({ code: "no_supplier", message: "No supplier is set for this product. Pick one to create a purchase order." });

  // Step 4: other products from the same supplier that need stock.
  const runDate = await latestRunDate(storeId);
  const also = chosenId && runDate
    ? (
        await query(
          `SELECT v.id, v.title, v.sku, v.cost, sr.reorder_qty, ${STATUS_SQL} AS status
             FROM variant_supply vs JOIN variants v ON v.id = vs.variant_id
             JOIN stock_risk sr ON sr.variant_id = v.id AND sr.run_date = $3
            WHERE vs.supplier_id=$1 AND v.store_id=$2 AND v.id <> $4 AND sr.reorder_qty > 0
              AND ${STATUS_SQL} IN ('reorder_now','watch')
            ORDER BY CASE WHEN ${STATUS_SQL} = 'reorder_now' THEN 0 ELSE 1 END, sr.revenue_at_risk DESC NULLS LAST LIMIT 20`,
          [chosenId, storeId, runDate, variantId]
        )
      ).map((r: any) => ({
        variant_id: Number(r.id), title: r.title, sku: r.sku, status: r.status,
        suggested_quantity: Number(r.reorder_qty), unit_cost: r.cost != null ? Number(r.cost) : null,
      }))
    : [];

  const drafts = chosenId
    ? (await query(
        "SELECT id, number, created_at FROM purchase_orders WHERE store_id=$1 AND supplier_id=$2 AND status='draft' ORDER BY created_at DESC",
        [storeId, chosenId]
      )).map((d: any) => ({ id: Number(d.id), number: `PO-${d.number}`, created_at: d.created_at }))
    : [];

  return {
    variant_id: Number(v.id),
    title: v.title || v.product_title,
    sku: v.sku,
    category: v.product_type,
    vendor: v.vendor,
    status: risk?.status_out ?? null,
    confidence: risk?.confidence ?? null,
    top: {
      on_hand: onHand,
      on_order: onOrder,
      forecast_per_day: Math.round(avg * 100) / 100,
      runs_out_on: without.runsOutInDays !== null ? addDays(today, without.runsOutInDays) : null,
      arrives_on: arrivesOn,
      suggested_quantity: main.suggested_quantity,
    },
    supplier_id: chosenId,
    suppliers: rows,
    inputs: {
      coverage_days: coverage,
      lead_time_days: lt,
      lead_time_is_override: overrideLT !== undefined,
      case_pack: casePack,
      min_order_qty: moq,
    },
    quantity: main.breakdown,
    suggested_quantity: main.suggested_quantity,
    reorder_point: main.reorder_point,
    effect,
    warnings,
    also_order: also,
    open_drafts: drafts,
    revenue_at_risk: Number(risk?.revenue_at_risk ?? 0),
  };
}

/**
 * Save supplier and rules only (no order): the preferred supplier for this
 * product and/or its whole category, plus ordering rules.
 */
export async function saveReorderPreferences(storeId: number, variantId: number, body: any) {
  onlyFields(body, ["supplier_id", "save_for_product", "make_category_preferred", "case_pack", "min_order_qty", "lead_time_days", "unit_cost"]);
  const v = await queryOne(
    "SELECT v.id, p.product_type FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND v.store_id=$2",
    [variantId, storeId]
  );
  if (!v) throw notFound("product variant", variantId);
  const sid = intField(body, "supplier_id", { min: 1 });
  if (sid !== undefined) {
    const s = await queryOne("SELECT id FROM suppliers WHERE id=$1 AND store_id=$2", [sid, storeId]);
    if (!s) throw invalid("unknown_supplier", `No supplier ${sid} in this store.`, "supplier_id");
  }
  const forProduct = boolField(body, "save_for_product") ?? true;
  const forCategory = boolField(body, "make_category_preferred") ?? false;
  if (forCategory && !v.product_type) {
    throw invalid("no_category", "This product has no category (product type), so it cannot have a category preference.", "make_category_preferred");
  }
  if ((forProduct || forCategory) && sid === undefined) throw invalid("missing_field", "supplier_id is required to save a preferred supplier.", "supplier_id");

  const sets: string[] = [];
  const params: any[] = [variantId];
  const push = (col: string, val: any) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (sid !== undefined && forProduct) push("supplier_id", sid);
  const cp = intField(body, "case_pack", { min: 1, max: 10000 });
  if (cp !== undefined) push("case_pack", cp);
  const moq = intField(body, "min_order_qty", { min: 0 });
  if (moq !== undefined) push("min_order_qty", moq);
  const lt = body.lead_time_days === null ? null : intField(body, "lead_time_days", { min: 1, max: 365 });
  if (lt !== undefined) push("lead_time_override", lt);
  const cost = numField(body, "unit_cost", { min: 0 });
  if (cost !== undefined) push("cost", cost);
  if (sets.length) await query(`UPDATE variants SET ${sets.join(", ")} WHERE id=$1`, params);

  let categoryProducts = 0;
  if (forCategory && sid !== undefined) {
    await query(
      `INSERT INTO supplier_categories (store_id, category, supplier_id) VALUES ($1,$2,$3)
       ON CONFLICT (store_id, category) DO UPDATE SET supplier_id = EXCLUDED.supplier_id`,
      [storeId, v.product_type, sid]
    );
    categoryProducts = (await queryOne(
      "SELECT COUNT(*)::int AS n FROM variant_supply WHERE store_id=$1 AND category=$2 AND supplier_id=$3",
      [storeId, v.product_type, sid]
    ))?.n ?? 0;
  }
  const job = await queueForecast(storeId);
  return {
    variant_id: variantId,
    saved_for_product: sid !== undefined && forProduct,
    category: forCategory ? { name: v.product_type, supplier_id: sid, products_now_using: categoryProducts } : null,
    rebuild_job_id: Number(job.id),
  };
}

export { r1 };
