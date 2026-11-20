/**
 * Planned promotions (Settings > Promotions): dates, expected uplift and
 * scope (all products, one vendor or one product type). Forecasts rise on
 * those days; any change rebuilds forecasts.
 */
import { query, queryOne } from "../db";
import { dateField, invalid, notFound, numField, onlyFields, strField } from "./errors";
import { queueForecast } from "./inventory";

function out(p: any) {
  return {
    id: Number(p.id),
    name: p.name,
    starts_on: p.starts_on,
    ends_on: p.ends_on,
    uplift_pct: Number(p.uplift_pct),
    scope: p.scope,
    scope_value: p.scope_value,
    source: p.source,
    active_now: p.starts_on <= new Date().toISOString().slice(0, 10) && p.ends_on >= new Date().toISOString().slice(0, 10),
    created_at: p.created_at,
  };
}

async function validate(storeId: number, body: any, partial: boolean, current?: any) {
  onlyFields(body, ["name", "starts_on", "ends_on", "uplift_pct", "scope", "scope_value"]);
  const v = {
    name: strField(body, "name", { required: !partial, max: 120 }),
    starts_on: dateField(body, "starts_on", { required: !partial }),
    ends_on: dateField(body, "ends_on", { required: !partial }),
    uplift_pct: numField(body, "uplift_pct", { required: !partial, min: -99, max: 1000 }),
    scope: strField(body, "scope"),
    scope_value: strField(body, "scope_value", { max: 120 }),
  };
  const scope = v.scope ?? current?.scope ?? "all";
  if (!["all", "vendor", "product_type"].includes(scope)) throw invalid("invalid_scope", "scope must be all, vendor or product_type.", "scope");
  const scopeValue = v.scope_value !== undefined ? v.scope_value : current?.scope_value;
  if (scope !== "all" && !scopeValue) throw invalid("missing_field", `scope_value is required when scope is ${scope}.`, "scope_value");
  if (scope !== "all") {
    const col = scope === "vendor" ? "vendor" : "product_type";
    const exists = await queryOne(`SELECT 1 FROM products WHERE store_id=$1 AND ${col}=$2 LIMIT 1`, [storeId, scopeValue]);
    if (!exists) throw invalid("unknown_scope_value", `No products have ${scope === "vendor" ? "vendor" : "product type"} '${scopeValue}'.`, "scope_value");
  }
  const start = v.starts_on ?? current?.starts_on;
  const end = v.ends_on ?? current?.ends_on;
  if (start && end && end < start) throw invalid("invalid_dates", "ends_on must be on or after starts_on.", "ends_on");
  return { ...v, scope, scope_value: scope === "all" ? null : scopeValue };
}

export async function listPromotions(storeId: number, opts: { include_past?: boolean } = {}) {
  const rows = await query(
    `SELECT * FROM promotions WHERE store_id=$1 ${opts.include_past ? "" : "AND ends_on >= CURRENT_DATE"} ORDER BY starts_on`,
    [storeId]
  );
  return rows.map(out);
}

export async function createPromotion(storeId: number, body: any) {
  const v = await validate(storeId, body, false);
  const p = await queryOne(
    `INSERT INTO promotions (store_id, name, starts_on, ends_on, uplift_pct, scope, scope_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [storeId, v.name, v.starts_on, v.ends_on, v.uplift_pct, v.scope, v.scope_value]
  );
  const job = await queueForecast(storeId);
  return { promotion: out(p), rebuild_job_id: Number(job.id) };
}

export async function updatePromotion(storeId: number, id: number, body: any) {
  const cur = await queryOne("SELECT * FROM promotions WHERE id=$1 AND store_id=$2", [id, storeId]);
  if (!cur) throw notFound("promotion", id);
  const v = await validate(storeId, body, true, cur);
  const p = await queryOne(
    `UPDATE promotions SET name=COALESCE($3,name), starts_on=COALESCE($4,starts_on), ends_on=COALESCE($5,ends_on),
       uplift_pct=COALESCE($6,uplift_pct), scope=$7, scope_value=$8 WHERE id=$1 AND store_id=$2 RETURNING *`,
    [id, storeId, v.name ?? null, v.starts_on ?? null, v.ends_on ?? null, v.uplift_pct ?? null, v.scope, v.scope_value]
  );
  const job = await queueForecast(storeId);
  return { promotion: out(p), rebuild_job_id: Number(job.id) };
}

export async function deletePromotion(storeId: number, id: number) {
  const r = await query("DELETE FROM promotions WHERE id=$1 AND store_id=$2 RETURNING id", [id, storeId]);
  if (!r.length) throw notFound("promotion", id);
  const job = await queueForecast(storeId);
  return { id, deleted: true, rebuild_job_id: Number(job.id) };
}
