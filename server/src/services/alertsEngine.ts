/**
 * Alerts that actually matter (guide chapter 9).
 *
 *   stockout_risk    stock runs out before the supplier could deliver a normal order   urgent
 *   reorder_point    stock (with stock on order) is at or below the reorder point      urgent
 *   velocity_shift   last 3 days sell much faster or slower than the 4-week pace       Scale+
 *   lead_time_drift  a supplier's latest delivery took noticeably longer               Scale+
 *   overstock        cover far beyond the overstock limit, tying up cash
 *
 * One alert per problem: it opens once, updates while the problem lasts,
 * and resolves itself when the problem goes away. If a purchase order for
 * the product was approved meanwhile, it is recorded as the resolver; that
 * feeds "Revenue protected" on the dashboard.
 */
import { afterCommit, query, queryOne, withTransaction } from "../db";
import { hasFeature } from "../plans";
import { conflict, invalid, notFound, onlyFields, strField } from "./errors";
import { STATUS_SQL } from "./forecasts";
import { latestRunDate } from "./inventory";
import { getForecastSettings } from "./settings";
import { emit } from "./webhooksOut";
import { notifyNewAlerts } from "./notifications";

export const ALERT_TYPES = ["stockout_risk", "reorder_point", "velocity_shift", "lead_time_drift", "overstock"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const WHAT_TO_DO: Record<AlertType, string> = {
  stockout_risk: "Reorder now; consider a faster supplier or a transfer.",
  reorder_point: "Open the reorder screen and create the order.",
  velocity_shift: "Check for a promotion or viral post; reorder early if it lasts.",
  lead_time_drift: "Talk to the supplier; forecasts already plan on the slower time.",
  overstock: "Pause orders, discount or transfer it.",
};

interface Candidate {
  type: AlertType;
  variant_id: number | null;
  supplier_id: number | null;
  urgent: boolean;
  title: string;
  message: string;
  revenue_at_risk: number;
  data: any;
}

const money = (v: number) => Math.round(v * 100) / 100;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

async function candidates(storeId: number): Promise<Candidate[]> {
  const runDate = await latestRunDate(storeId);
  if (!runDate) return [];
  const settings = await getForecastSettings(storeId);
  const velocity = await hasFeature(storeId, "velocity_alerts");
  const leadTime = await hasFeature(storeId, "lead_time_alerts");
  const out: Candidate[] = [];

  const rows = await query(
    `SELECT sr.*, ${STATUS_SQL} AS st, v.title, v.sku, v.cost, v.price, vs.on_order AS live_on_order,
            COALESCE(sr.lead_time_days, vs.lead_time_days) AS lt, f.avg_daily_demand
       FROM stock_risk sr JOIN variants v ON v.id = sr.variant_id JOIN variant_supply vs ON vs.variant_id = v.id
       LEFT JOIN forecasts f ON f.variant_id = sr.variant_id AND f.run_date = sr.run_date
      WHERE sr.store_id=$1 AND sr.run_date=$2 AND v.track_inventory`,
    [storeId, runDate]
  );
  for (const r of rows) {
    const st = r.st;
    if (st === "no_sales" || st === "untracked") continue;
    const vid = Number(r.variant_id);
    const name = r.title + (r.sku ? ` (${r.sku})` : "");
    const cover = r.days_of_stock != null ? Number(r.days_of_stock) : null;
    const lt = Number(r.lt);
    const stock = Number(r.current_stock);
    const onOrder = Number(r.live_on_order ?? r.on_order ?? 0);
    const rp = r.reorder_point != null ? Number(r.reorder_point) : null;
    const risk = Number(r.revenue_at_risk ?? 0);
    const avg = Number(r.avg_daily_demand ?? 0);

    const stockout = cover !== null && cover < lt;
    if (stockout) {
      out.push({
        type: "stockout_risk", variant_id: vid, supplier_id: null, urgent: true,
        title: `${r.title} runs out before a reorder can arrive`,
        message: `${name} has ${plural(stock, "unit")} left, about ${Math.round(cover!)} days of cover, but the lead time is ${lt} days.`,
        revenue_at_risk: risk,
        data: { cover_days: cover, lead_time_days: lt, on_hand: stock, on_order: onOrder, runs_out_on: r.stockout_date, suggested_quantity: Number(r.reorder_qty ?? 0) },
      });
    } else if (rp !== null && stock + onOrder <= rp && avg > 0.01) {
      out.push({
        type: "reorder_point", variant_id: vid, supplier_id: null, urgent: true,
        title: `${r.title} is below its reorder point`,
        message: `${name}: ${plural(stock, "unit")} on hand${onOrder ? ` and ${onOrder} on order` : ""}, reorder point ${rp}.`,
        revenue_at_risk: risk,
        data: { on_hand: stock, on_order: onOrder, reorder_point: rp, suggested_quantity: Number(r.reorder_qty ?? 0) },
      });
    }

    if (cover !== null && avg > 0.01 && cover > settings.overstock_days * 1.5) {
      const excess = Math.max(stock - avg * settings.overstock_days, 0);
      const unit = Number(r.cost ?? r.unit_cost ?? r.price ?? 0);
      out.push({
        type: "overstock", variant_id: vid, supplier_id: null, urgent: false,
        title: `${r.title} is heavily overstocked`,
        message: `${name} has ${Math.round(cover)} days of cover against a limit of ${settings.overstock_days}; about ${Math.round(excess)} units are beyond it.`,
        revenue_at_risk: 0,
        data: { cover_days: cover, overstock_days: settings.overstock_days, excess_units: Math.round(excess), cash_tied_up: money(excess * unit), cost_basis: r.cost != null ? "cost" : "price" },
      });
    }
  }

  if (velocity) {
    const vel = await query(
      `SELECT v.id, v.title, v.sku,
              COALESCE(SUM(ds.units_sold) FILTER (WHERE ds.sale_date >= CURRENT_DATE - 3), 0)::float AS last3,
              COALESCE(SUM(ds.units_sold) FILTER (WHERE ds.sale_date < CURRENT_DATE - 3 AND ds.sale_date >= CURRENT_DATE - 31), 0)::float AS prev28
         FROM variants v LEFT JOIN daily_sales ds ON ds.variant_id = v.id AND ds.sale_date >= CURRENT_DATE - 31
        WHERE v.store_id = $1 GROUP BY v.id, v.title, v.sku`,
      [storeId]
    );
    const risk = new Map(rows.map((r: any) => [Number(r.variant_id), Number(r.revenue_at_risk ?? 0)]));
    for (const r of vel) {
      const normal = (Number(r.prev28) / 28) * 3; // expected units over 3 days at the 4-week pace
      const last3 = Number(r.last3);
      if (normal < 1.5 && last3 < 5) continue; // too little volume to call a shift
      const ratio = normal > 0 ? last3 / normal : Infinity;
      if (ratio >= settings.velocity_threshold || ratio <= 1 / settings.velocity_threshold) {
        const faster = ratio > 1;
        const shown = Number.isFinite(ratio) ? (faster ? ratio : 1 / ratio).toFixed(1) : "many";
        out.push({
          type: "velocity_shift", variant_id: Number(r.id), supplier_id: null, urgent: false,
          title: `${r.title} is selling ${faster ? "faster" : "slower"} than usual`,
          message: `${r.title}${r.sku ? ` (${r.sku})` : ""} sold ${last3} units in the last 3 days, ${shown}x ${faster ? "above" : "below"} its 4-week pace of ${normal.toFixed(1)}.`,
          revenue_at_risk: risk.get(Number(r.id)) ?? 0,
          data: { last_3_days: last3, expected_3_days: Math.round(normal * 10) / 10, ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null, threshold: settings.velocity_threshold, direction: faster ? "faster" : "slower" },
        });
      }
    }
  }

  if (leadTime) {
    const drift = await query(
      `WITH ranked AS (
         SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.supplier_id ORDER BY r.received_at DESC) AS rn
           FROM supplier_receipts r JOIN suppliers s ON s.id = r.supplier_id
          WHERE s.store_id = $1 AND r.received_at > now() - interval '180 days')
       SELECT s.id, s.name, latest.lead_time_days AS latest, prior.avg_days, prior.n
         FROM suppliers s
         JOIN ranked latest ON latest.supplier_id = s.id AND latest.rn = 1
         JOIN LATERAL (SELECT AVG(lead_time_days) AS avg_days, COUNT(*) AS n FROM ranked p WHERE p.supplier_id = s.id AND p.rn > 1) prior ON true
        WHERE s.store_id = $1`,
      [storeId]
    );
    for (const d of drift) {
      if (!Number(d.n) || d.avg_days == null) continue;
      const latest = Number(d.latest), avg = Number(d.avg_days);
      if (latest >= avg * 1.25 && latest - avg >= 2) {
        const exposed = await queryOne(
          `SELECT COALESCE(SUM(sr.revenue_at_risk),0)::float AS risk, COUNT(*)::int AS n
             FROM variant_supply vs JOIN stock_risk sr ON sr.variant_id = vs.variant_id AND sr.run_date = $2
            WHERE vs.supplier_id = $1`,
          [d.id, runDate]
        );
        out.push({
          type: "lead_time_drift", variant_id: null, supplier_id: Number(d.id), urgent: false,
          title: `${d.name} is getting slower`,
          message: `${d.name}'s latest delivery took ${latest} days against a usual ${avg.toFixed(1)}. Forecasts already plan on the slower time for ${plural(exposed?.n ?? 0, "product")}.`,
          revenue_at_risk: Number(exposed?.risk ?? 0),
          data: { latest_days: latest, usual_days: Math.round(avg * 10) / 10, products: exposed?.n ?? 0 },
        });
      }
    }
  }
  return out;
}

const key = (c: { type: string; variant_id: any; supplier_id: any }) => `${c.type}:${Number(c.variant_id ?? 0)}:${Number(c.supplier_id ?? 0)}`;

/** Open, update and resolve alerts for one store. Returns the newly opened ones. */
export async function evaluateAlerts(storeId: number) {
  const opened: any[] = [];
  let resolved = 0;
  await withTransaction(async () => {
    const cands = await candidates(storeId);
    const existing = await query("SELECT * FROM inventory_alerts WHERE store_id=$1 AND status <> 'resolved'", [storeId]);
    const byKey = new Map(existing.map((a: any) => [key(a), a]));
    const live = new Set<string>();

    for (const c of cands) {
      const k = key(c);
      live.add(k);
      const ex = byKey.get(k);
      if (ex) {
        await query(
          "UPDATE inventory_alerts SET title=$2, message=$3, revenue_at_risk=$4, data=$5, urgent=$6, updated_at=now() WHERE id=$1",
          [ex.id, c.title, c.message, money(c.revenue_at_risk), c.data, c.urgent]
        );
      } else {
        const a = await queryOne(
          `INSERT INTO inventory_alerts (store_id, type, variant_id, supplier_id, urgent, title, message, revenue_at_risk, data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [storeId, c.type, c.variant_id, c.supplier_id, c.urgent, c.title, c.message, money(c.revenue_at_risk), c.data]
        );
        opened.push(a);
      }
    }

    for (const a of existing) {
      if (live.has(key(a))) continue;
      // Closed by a purchase order approved since the alert opened?
      const po = a.variant_id
        ? await queryOne(
            `SELECT po.id FROM purchase_orders po JOIN purchase_order_lines l ON l.purchase_order_id = po.id
              WHERE l.variant_id=$1 AND po.status IN ('approved','sent','partial','received') AND po.approved_at >= $2
              ORDER BY po.approved_at LIMIT 1`,
            [a.variant_id, a.opened_at]
          )
        : null;
      await query(
        "UPDATE inventory_alerts SET status='resolved', resolved_at=now(), updated_at=now(), resolved_by_po_id=$2 WHERE id=$1",
        [a.id, po?.id ?? null]
      );
      resolved++;
    }
    await query("UPDATE stores SET alerts_evaluated_at = now() WHERE id=$1", [storeId]);

    for (const a of opened) await emit(storeId, `alert.${a.type}`, await alertOut(a));
  });
  if (opened.length) {
    // Only once the alerts are committed (never for a sandbox request).
    afterCommit(() => notifyNewAlerts(storeId, opened.map((a) => a.id)).then(() => undefined));
  }
  return { opened: opened.length, resolved };
}

/* ---------------- API ---------------- */

export async function alertOut(a: any) {
  const v = a.variant_id ? await queryOne("SELECT id, title, sku FROM variants WHERE id=$1", [a.variant_id]) : null;
  const s = a.supplier_id ? await queryOne("SELECT id, name FROM suppliers WHERE id=$1", [a.supplier_id]) : null;
  const po = a.resolved_by_po_id ? await queryOne("SELECT id, number FROM purchase_orders WHERE id=$1", [a.resolved_by_po_id]) : null;
  return {
    id: Number(a.id),
    type: a.type,
    status: a.status,
    urgent: a.urgent,
    title: a.title,
    message: a.message,
    what_to_do: WHAT_TO_DO[a.type as AlertType],
    revenue_at_risk: Number(a.revenue_at_risk),
    product: v ? { variant_id: Number(v.id), title: v.title, sku: v.sku } : null,
    supplier: s ? { id: Number(s.id), name: s.name } : null,
    data: a.data,
    opened_at: a.opened_at,
    updated_at: a.updated_at,
    dismissed_at: a.dismissed_at,
    resolved_at: a.resolved_at,
    resolved_by_purchase_order: po ? { id: Number(po.id), number: `PO-${po.number}` } : null,
  };
}

export async function listInventoryAlerts(storeId: number, opts: { status?: string; type?: string[]; page?: number; limit?: number }) {
  const status = opts.status ?? "open";
  if (!["open", "dismissed", "resolved", "all"].includes(status)) throw invalid("invalid_status", "status must be open, dismissed, resolved or all.", "status");
  const bad = opts.type?.find((t) => !(ALERT_TYPES as readonly string[]).includes(t));
  if (bad) throw invalid("invalid_type", `Unknown type '${bad}'. Use any of: ${ALERT_TYPES.join(", ")}.`, "type");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 250);
  const page = Math.max(opts.page ?? 1, 1);
  const params: any[] = [storeId];
  let where = "store_id=$1";
  if (status !== "all") { params.push(status); where += ` AND status=$${params.length}`; }
  if (opts.type?.length) { params.push(opts.type); where += ` AND type = ANY($${params.length})`; }
  const total = (await queryOne(`SELECT COUNT(*)::int AS n FROM inventory_alerts WHERE ${where}`, params))?.n ?? 0;
  const counts = Object.fromEntries(
    (await query("SELECT status, COUNT(*)::int AS n FROM inventory_alerts WHERE store_id=$1 GROUP BY status", [storeId])).map((r: any) => [r.status, r.n])
  );
  params.push(limit, (page - 1) * limit);
  const rows = await query(
    `SELECT * FROM inventory_alerts WHERE ${where}
      ORDER BY urgent DESC, revenue_at_risk DESC, opened_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const data = [];
  for (const r of rows) data.push(await alertOut(r));
  return { data, page, limit, total, has_more: page * limit < total, counts: { open: counts.open ?? 0, dismissed: counts.dismissed ?? 0, resolved: counts.resolved ?? 0 } };
}

export async function getInventoryAlert(storeId: number, id: number) {
  const a = await queryOne("SELECT * FROM inventory_alerts WHERE id=$1 AND store_id=$2", [id, storeId]);
  if (!a) throw notFound("alert", id);
  return alertOut(a);
}

/** POST /alerts/:id {"action": "dismiss" | "reopen"} */
export async function inventoryAlertAction(storeId: number, id: number, body: any) {
  onlyFields(body, ["action"]);
  const action = strField(body, "action", { required: true });
  const a = await queryOne("SELECT * FROM inventory_alerts WHERE id=$1 AND store_id=$2", [id, storeId]);
  if (!a) throw notFound("alert", id);
  if (action === "dismiss") {
    if (a.status !== "open") throw conflict("invalid_transition", `Alert ${id} is ${a.status}; only open alerts can be dismissed.`);
    await query("UPDATE inventory_alerts SET status='dismissed', dismissed_at=now(), updated_at=now() WHERE id=$1", [id]);
  } else if (action === "reopen") {
    if (a.status !== "dismissed") throw conflict("invalid_transition", `Alert ${id} is ${a.status}; only dismissed alerts can be reopened.`);
    await query("UPDATE inventory_alerts SET status='open', dismissed_at=NULL, updated_at=now() WHERE id=$1", [id]);
  } else {
    throw invalid("invalid_action", "action must be dismiss or reopen.", "action");
  }
  return getInventoryAlert(storeId, id);
}
