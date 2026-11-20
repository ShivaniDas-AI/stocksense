/**
 * Purchase orders (guide chapter 7).
 *
 *   draft     editable; automatic drafts follow each rebuild until someone edits them
 *   approved  locked, ready to send
 *   sent      ordered; emailed to the supplier with a CSV when it has an email
 *   partial   some units received
 *   received  all units in; stock added at the destination location
 *   cancelled no longer counted as on order
 *
 * Every receipt records the supplier's real lead time.
 */
import axios from "axios";
import { afterCommit, query, queryOne } from "../db";
import { config } from "../config";
import { requireFeature } from "../plans";
import { getAdapter } from "../platforms";
import { boolField, conflict, dateField, intField, invalid, notFound, numField, onlyFields, strField } from "./errors";
import { addDays, STATUS_SQL, todayYmd } from "./forecasts";
import { latestRunDate, queueForecast } from "./inventory";
import { addStock, ensureDefaultLocation } from "./locations";
import { emit } from "./webhooksOut";

export const PO_STATUSES = ["draft", "approved", "sent", "partial", "received", "cancelled"] as const;
const OPEN = ["approved", "sent", "partial"];

const n = (v: any) => (v === null || v === undefined ? null : Number(v));
const money = (v: number) => Math.round(v * 100) / 100;

/* ---------------- read ---------------- */

export async function getPurchaseOrder(storeId: number, id: number) {
  const po = await queryOne(
    `SELECT po.*, s.email AS supplier_email, s.min_order_value, s.currency AS supplier_currency, l.name AS location_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN locations l ON l.id = po.location_id
      WHERE po.id=$1 AND po.store_id=$2`,
    [id, storeId]
  );
  if (!po) throw notFound("purchase order", id);
  return poOut(po);
}

async function poOut(po: any) {
  const lines = await query(
    `SELECT l.*, v.title, v.sku, v.price FROM purchase_order_lines l JOIN variants v ON v.id = l.variant_id
      WHERE l.purchase_order_id=$1 ORDER BY v.title`,
    [po.id]
  );
  const outLines = lines.map((l: any) => ({
    variant_id: Number(l.variant_id),
    title: l.title,
    sku: l.sku,
    quantity: Number(l.quantity),
    received_quantity: Number(l.received_qty),
    unit_cost: n(l.unit_cost),
    line_total: money(Number(l.quantity) * Number(l.unit_cost ?? 0)),
  }));
  const total = money(outLines.reduce((a, l) => a + l.line_total, 0));
  const units = outLines.reduce((a, l) => a + l.quantity, 0);
  const warnings: { code: string; message: string }[] = [];
  if (po.min_order_value != null && total < Number(po.min_order_value) && ["draft", "approved"].includes(po.status)) {
    warnings.push({
      code: "below_minimum_order_value",
      message: `Total ${total} is below ${po.supplier_name}'s minimum order value of ${Number(po.min_order_value)}.`,
    });
  }
  if (outLines.some((l) => l.unit_cost === null)) {
    warnings.push({ code: "missing_unit_cost", message: "Some lines have no unit cost, so the total is incomplete." });
  }
  return {
    id: Number(po.id),
    number: `PO-${po.number}`,
    status: po.status,
    automatic: po.is_auto && !po.auto_edited,
    supplier: { id: n(po.supplier_id), name: po.supplier_name, email: po.supplier_email ?? null },
    location: po.location_id ? { id: Number(po.location_id), name: po.location_name } : null,
    expected_at: po.expected_at,
    notes: po.notes,
    currency: po.currency,
    lines: outLines,
    line_count: outLines.length,
    units,
    total,
    warnings,
    created_at: po.created_at,
    updated_at: po.updated_at,
    approved_at: po.approved_at,
    sent_at: po.sent_at,
    emailed_at: po.emailed_at,
    received_at: po.received_at,
    cancelled_at: po.cancelled_at,
    platform_sync: po.platform_sync ?? null,
  };
}

export async function listPurchaseOrders(
  storeId: number,
  opts: { status?: string[]; supplier_id?: number; page?: number; limit?: number } = {}
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 250);
  const page = Math.max(opts.page ?? 1, 1);
  const bad = opts.status?.find((s) => !(PO_STATUSES as readonly string[]).includes(s));
  if (bad) throw invalid("invalid_status", `Unknown status '${bad}'. Use any of: ${PO_STATUSES.join(", ")}.`, "status");
  const params: any[] = [storeId];
  let where = "po.store_id=$1";
  if (opts.status?.length) { params.push(opts.status); where += ` AND po.status = ANY($${params.length})`; }
  if (opts.supplier_id) { params.push(opts.supplier_id); where += ` AND po.supplier_id = $${params.length}`; }
  const total = (await queryOne(`SELECT COUNT(*)::int AS n FROM purchase_orders po WHERE ${where}`, params))?.n ?? 0;
  params.push(limit, (page - 1) * limit);
  const rows = await query(
    `SELECT po.*, s.email AS supplier_email, s.min_order_value, l.name AS location_name
       FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN locations l ON l.id = po.location_id
      WHERE ${where} ORDER BY po.created_at DESC, po.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const data = [];
  for (const r of rows) data.push(await poOut(r));
  return { data, page, limit, total, has_more: page * limit < total };
}

/* ---------------- create / edit ---------------- */

async function nextNumber(storeId: number): Promise<number> {
  // Serialise numbering per store inside the request's transaction.
  await query("SELECT pg_advisory_xact_lock(42, $1::int)", [storeId]);
  const r = await queryOne("SELECT COALESCE(MAX(number), 1000) + 1 AS n FROM purchase_orders WHERE store_id=$1", [storeId]);
  return Number(r.n);
}

interface LineInput { variant_id: number; quantity: number; unit_cost?: number | null }

async function validateLines(storeId: number, lines: any, opts: { allowZero?: boolean } = {}): Promise<LineInput[]> {
  if (!Array.isArray(lines)) throw invalid("invalid_lines", "lines must be a list of {variant_id, quantity, unit_cost?}.", "lines");
  if (lines.length > 500) throw invalid("too_many_lines", "A purchase order can have at most 500 lines.", "lines");
  const seen = new Set<number>();
  const out: LineInput[] = [];
  for (const [i, l] of lines.entries()) {
    const vid = intField(l, "variant_id", { required: true, min: 1 })!;
    const qty = intField(l, "quantity", { required: true, min: opts.allowZero ? 0 : 1, max: 1_000_000 })!;
    const cost = numField(l, "unit_cost", { min: 0 });
    if (seen.has(vid)) throw invalid("duplicate_line", `lines[${i}]: variant ${vid} appears twice.`, `lines[${i}].variant_id`);
    seen.add(vid);
    const v = await queryOne("SELECT id, cost FROM variants WHERE id=$1 AND store_id=$2", [vid, storeId]);
    if (!v) throw invalid("unknown_variant", `lines[${i}].variant_id ${vid} is not a product variant in this store.`, `lines[${i}].variant_id`);
    out.push({ variant_id: vid, quantity: qty, unit_cost: cost ?? (v.cost != null ? Number(v.cost) : null) });
  }
  return out;
}

async function resolveLocation(storeId: number, locationId?: number) {
  if (locationId === undefined) return (await ensureDefaultLocation(storeId)).id;
  const l = await queryOne("SELECT id FROM locations WHERE id=$1 AND store_id=$2 AND active", [locationId, storeId]);
  if (!l) throw invalid("unknown_location", `No active location ${locationId} in this store.`, "location_id");
  return l.id;
}

/** POST /purchase-orders: create a draft. */
export async function createPurchaseOrder(storeId: number, body: any, opts: { auto?: boolean } = {}) {
  await requireFeature(storeId, "draft_purchase_orders");
  onlyFields(body, ["supplier_id", "location_id", "notes", "expected_at", "lines"]);
  const supplierId = intField(body, "supplier_id", { required: true, min: 1 })!;
  const s = await queryOne(
    "SELECT s.*, sls.effective_days FROM suppliers s JOIN supplier_lead_stats sls ON sls.supplier_id = s.id WHERE s.id=$1 AND s.store_id=$2",
    [supplierId, storeId]
  );
  if (!s) throw invalid("unknown_supplier", `No supplier ${supplierId} in this store.`, "supplier_id");
  const locationId = await resolveLocation(storeId, intField(body, "location_id", { min: 1 }));
  const lines = await validateLines(storeId, body.lines ?? []);
  const expected = dateField(body, "expected_at") ?? addDays(todayYmd(), Number(s.effective_days));
  const store = await queryOne("SELECT currency FROM stores WHERE id=$1", [storeId]);

  const number = await nextNumber(storeId);
  const po = await queryOne(
    `INSERT INTO purchase_orders (store_id, number, supplier_id, supplier_name, location_id, status, is_auto, expected_at, notes, currency)
     VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9) RETURNING id`,
    [storeId, number, supplierId, s.name, locationId, !!opts.auto, expected, strField(body, "notes", { max: 2000 }) ?? null, s.currency || store?.currency || "USD"]
  );
  for (const l of lines) {
    await query("INSERT INTO purchase_order_lines (purchase_order_id, variant_id, quantity, unit_cost) VALUES ($1,$2,$3,$4)", [po!.id, l.variant_id, l.quantity, l.unit_cost]);
  }
  return getPurchaseOrder(storeId, Number(po!.id));
}

async function getDraft(storeId: number, id: number) {
  const po = await queryOne("SELECT * FROM purchase_orders WHERE id=$1 AND store_id=$2", [id, storeId]);
  if (!po) throw notFound("purchase order", id);
  if (po.status !== "draft") throw conflict("not_a_draft", `PO-${po.number} is ${po.status}; only drafts can be changed.`);
  return po;
}

/**
 * PATCH a draft. lines replace quantities for the variants given
 * (0 removes a line); other lines stay. An edited automatic draft is no
 * longer updated by rebuilds.
 */
export async function updateDraft(storeId: number, id: number, body: any) {
  onlyFields(body, ["lines", "location_id", "expected_at", "notes", "supplier_id"]);
  const po = await getDraft(storeId, id);
  if (body.lines !== undefined) {
    const lines = await validateLines(storeId, body.lines, { allowZero: true });
    for (const l of lines) {
      if (l.quantity === 0) await query("DELETE FROM purchase_order_lines WHERE purchase_order_id=$1 AND variant_id=$2", [id, l.variant_id]);
      else {
        await query(
          `INSERT INTO purchase_order_lines (purchase_order_id, variant_id, quantity, unit_cost) VALUES ($1,$2,$3,$4)
           ON CONFLICT (purchase_order_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity,
             unit_cost = COALESCE($5, purchase_order_lines.unit_cost)`,
          [id, l.variant_id, l.quantity, l.unit_cost, (body.lines.find((x: any) => Number(x.variant_id) === l.variant_id) ?? {}).unit_cost ?? null]
        );
      }
    }
  }
  const sets: string[] = ["updated_at = now()"];
  const params: any[] = [id];
  if (body.location_id !== undefined) { params.push(await resolveLocation(storeId, intField(body, "location_id", { min: 1 }))); sets.push(`location_id = $${params.length}`); }
  if (body.expected_at !== undefined) { params.push(dateField(body, "expected_at") ?? null); sets.push(`expected_at = $${params.length}`); }
  if (body.notes !== undefined) { params.push(strField(body, "notes", { max: 2000 }) ?? null); sets.push(`notes = $${params.length}`); }
  if (body.supplier_id !== undefined) {
    const sid = intField(body, "supplier_id", { required: true, min: 1 })!;
    const s = await queryOne("SELECT id, name FROM suppliers WHERE id=$1 AND store_id=$2", [sid, storeId]);
    if (!s) throw invalid("unknown_supplier", `No supplier ${sid} in this store.`, "supplier_id");
    params.push(sid, s.name);
    sets.push(`supplier_id = $${params.length - 1}`, `supplier_name = $${params.length}`);
  }
  if (po.is_auto) sets.push("auto_edited = true");
  await query(`UPDATE purchase_orders SET ${sets.join(", ")} WHERE id=$1`, params);
  return getPurchaseOrder(storeId, id);
}

/** Reorder screen: add lines to an existing draft for the supplier instead of opening a second order. */
export async function addToDraft(storeId: number, id: number, lines: any[], notes?: string | null) {
  const po = await getDraft(storeId, id);
  const valid = await validateLines(storeId, lines);
  for (const l of valid) {
    await query(
      `INSERT INTO purchase_order_lines (purchase_order_id, variant_id, quantity, unit_cost) VALUES ($1,$2,$3,$4)
       ON CONFLICT (purchase_order_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity, unit_cost = EXCLUDED.unit_cost`,
      [id, l.variant_id, l.quantity, l.unit_cost]
    );
  }
  await query(
    `UPDATE purchase_orders SET updated_at = now(), auto_edited = is_auto,
       notes = CASE WHEN $2::text IS NULL THEN notes ELSE $2 END WHERE id=$1`,
    [id, notes ?? null]
  );
  return getPurchaseOrder(storeId, Number(po.id));
}

/* ---------------- lifecycle actions ---------------- */

/**
 * POST /purchase-orders/:id {"action": "approve" | "send" | "cancel" | "receive", ...}
 *   send:    {"email_supplier": true}
 *   receive: {"lines": [{"variant_id", "quantity"}]} units received now; omit lines to receive everything outstanding
 */
export async function purchaseOrderAction(storeId: number, id: number, body: any) {
  onlyFields(body, ["action", "email_supplier", "lines"]);
  const action = strField(body, "action", { required: true });
  const po = await queryOne("SELECT * FROM purchase_orders WHERE id=$1 AND store_id=$2 FOR UPDATE", [id, storeId]);
  if (!po) throw notFound("purchase order", id);
  const label = `PO-${po.number}`;
  const not = (allowed: string[]) => {
    if (!allowed.includes(po.status)) throw conflict("invalid_transition", `${label} is ${po.status}; ${action} needs it to be ${allowed.join(" or ")}.`);
  };

  switch (action) {
    case "approve": {
      not(["draft"]);
      const lines = await queryOne("SELECT COUNT(*)::int AS n FROM purchase_order_lines WHERE purchase_order_id=$1", [id]);
      if (!lines?.n) throw conflict("empty_order", `${label} has no lines to approve.`);
      if (!po.supplier_id) throw conflict("no_supplier", `${label} has no supplier.`);
      await query("UPDATE purchase_orders SET status='approved', approved_at=now(), updated_at=now() WHERE id=$1", [id]);
      await queueForecast(storeId); // on-order stock changes reorder suggestions
      const out = await getPurchaseOrder(storeId, id);
      await emit(storeId, "purchase_order.approved", out);
      return out;
    }
    case "send": {
      not(["approved"]);
      const email = boolField(body, "email_supplier") ?? true;
      await query("UPDATE purchase_orders SET status='sent', sent_at=now(), updated_at=now() WHERE id=$1", [id]);
      const out: any = await getPurchaseOrder(storeId, id);
      out.email = { requested: email, status: "skipped" as string, reason: null as string | null };
      if (email) {
        if (!out.supplier.email) out.email.reason = "The supplier has no order email.";
        else if (!config.alerts.resendApiKey) out.email.reason = "Email is not configured on the server (RESEND_API_KEY).";
        else {
          out.email.status = "queued";
          afterCommit(() => emailPurchaseOrder(storeId, id));
        }
      }
      await emit(storeId, "purchase_order.sent", out);
      return out;
    }
    case "cancel": {
      not(["draft", "approved", "sent"]);
      await query("UPDATE purchase_orders SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1", [id]);
      if (po.status !== "draft") await queueForecast(storeId);
      return getPurchaseOrder(storeId, id);
    }
    case "receive":
      not(["approved", "sent", "partial"]);
      return receive(storeId, po, body.lines);
    default:
      throw invalid("invalid_action", "action must be one of: approve, send, cancel, receive.", "action");
  }
}

async function receive(storeId: number, po: any, linesIn: any) {
  const id = Number(po.id);
  const lines = await query("SELECT * FROM purchase_order_lines WHERE purchase_order_id=$1", [id]);
  const byVariant = new Map(lines.map((l: any) => [Number(l.variant_id), l]));
  let receipts: { variant_id: number; qty: number }[];
  if (linesIn === undefined) {
    receipts = lines.map((l: any) => ({ variant_id: Number(l.variant_id), qty: Math.max(Number(l.quantity) - Number(l.received_qty), 0) }));
  } else {
    if (!Array.isArray(linesIn) || !linesIn.length) throw invalid("invalid_lines", "lines must be a list of {variant_id, quantity} received now.", "lines");
    receipts = linesIn.map((l: any, i: number) => {
      const vid = intField(l, "variant_id", { required: true, min: 1 })!;
      const qty = intField(l, "quantity", { required: true, min: 0, max: 1_000_000 })!;
      if (!byVariant.has(vid)) throw invalid("not_on_order", `lines[${i}]: variant ${vid} is not on PO-${po.number}.`, `lines[${i}].variant_id`);
      return { variant_id: vid, qty };
    });
  }
  receipts = receipts.filter((r) => r.qty > 0);
  if (!receipts.length) throw invalid("nothing_received", "No units to receive.", "lines");

  const locationId = po.location_id ?? (await ensureDefaultLocation(storeId)).id;
  for (const r of receipts) {
    await query("UPDATE purchase_order_lines SET received_qty = received_qty + $3 WHERE purchase_order_id=$1 AND variant_id=$2", [id, r.variant_id, r.qty]);
    await addStock(r.variant_id, Number(locationId), r.qty);
  }
  const after = await queryOne(
    "SELECT SUM(quantity)::int AS ordered, SUM(LEAST(received_qty, quantity))::int AS received FROM purchase_order_lines WHERE purchase_order_id=$1",
    [id]
  );
  const complete = Number(after.received) >= Number(after.ordered);
  const firstReceipt = po.status !== "partial";
  await query(
    `UPDATE purchase_orders SET status=$2, updated_at=now(), received_at = CASE WHEN $3 THEN now() ELSE received_at END WHERE id=$1`,
    [id, complete ? "received" : "partial", complete]
  );

  // Record how long the supplier actually took (first delivery of the order).
  if (firstReceipt && po.supplier_id) {
    const orderedAt = po.sent_at ?? po.approved_at ?? po.created_at;
    const days = Math.max((Date.now() - new Date(orderedAt).getTime()) / 86_400_000, 0);
    const onTime = po.expected_at ? todayYmd() <= String(po.expected_at).slice(0, 10) : null;
    await query(
      `INSERT INTO supplier_receipts (supplier_id, purchase_order_id, ordered_at, received_at, lead_time_days, on_time, fill_rate)
       VALUES ($1,$2,$3,now(),$4,$5,$6)`,
      [po.supplier_id, id, orderedAt, Math.round(days * 10) / 10, onTime, Number(after.ordered) ? Number(after.received) / Number(after.ordered) : null]
    );
  } else if (complete && po.supplier_id) {
    await query(
      "UPDATE supplier_receipts SET fill_rate = $2 WHERE purchase_order_id=$1",
      [id, Number(after.ordered) ? Number(after.received) / Number(after.ordered) : null]
    );
  }

  // Add the stock in the store platform too, after the transaction commits.
  afterCommit(() => pushReceiptToPlatform(storeId, id, Number(locationId), receipts));
  await queueForecast(storeId);
  const out = await getPurchaseOrder(storeId, id);
  await emit(storeId, "purchase_order.received", { ...out, received_now: receipts.map((r) => ({ variant_id: r.variant_id, quantity: r.qty })) });
  return out;
}

async function pushReceiptToPlatform(storeId: number, poId: number, locationId: number, receipts: { variant_id: number; qty: number }[]) {
  const store = await queryOne("SELECT * FROM stores WHERE id=$1", [storeId]);
  const loc = await queryOne("SELECT external_id FROM locations WHERE id=$1", [locationId]);
  let result: any;
  try {
    const adapter = getAdapter(store.platform);
    if (store.is_demo) result = { status: "skipped", message: "Demo store: stock was added in StockSense only." };
    else if (!adapter.adjustInventory) result = { status: "skipped", message: `${store.platform} stock is not updated automatically yet; add the units in your store admin.` };
    else if (!loc?.external_id) result = { status: "skipped", message: "The destination location is not linked to a store location; add the units in your store admin." };
    else {
      const creds = { id: store.id, storeDomain: store.store_domain, storeHash: store.store_hash, accessToken: store.access_token };
      for (const r of receipts) {
        const v = await queryOne("SELECT inventory_item_id FROM variants WHERE id=$1", [r.variant_id]);
        if (!v?.inventory_item_id) continue;
        await adapter.adjustInventory(creds, v.inventory_item_id, loc.external_id, r.qty);
      }
      result = { status: "done", message: `Added ${receipts.reduce((a, r) => a + r.qty, 0)} units in ${store.platform}.` };
    }
  } catch (e: any) {
    const status = e.response?.status;
    result = {
      status: "failed",
      message: status === 403 || status === 401
        ? "The store did not allow the stock update. Re-approve the app with inventory write access, or add the units in your store admin."
        : `Store update failed: ${e.message}`,
    };
  }
  await query("UPDATE purchase_orders SET platform_sync = $2 WHERE id=$1", [poId, { ...result, at: new Date().toISOString() }]);
}

/* ---------------- email ---------------- */

export function purchaseOrderCsv(po: any) {
  const esc = (v: any) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["sku", "title", "quantity", "unit_cost", "line_total"].join(",")];
  for (const l of po.lines) rows.push([l.sku, l.title, l.quantity, l.unit_cost, l.line_total].map(esc).join(","));
  return rows.join("\n") + "\n";
}

async function emailPurchaseOrder(storeId: number, id: number) {
  const po = await getPurchaseOrder(storeId, id);
  const store = await queryOne("SELECT name, store_domain FROM stores WHERE id=$1", [storeId]);
  const supplierNotes = (await queryOne("SELECT notes FROM suppliers WHERE id=$1", [po.supplier.id]))?.notes;
  const rows = po.lines
    .map((l) => `<tr><td>${l.sku ?? ""}</td><td>${l.title}</td><td align="right">${l.quantity}</td><td align="right">${l.unit_cost ?? ""}</td></tr>`)
    .join("");
  const html = `
    <div style="font-family:Arial,sans-serif;color:#111">
      <h2>Purchase order ${po.number}</h2>
      <p>From ${store?.name || store?.store_domain}. Expected delivery ${po.expected_at ?? "as soon as possible"}${po.location ? ` to ${po.location.name}` : ""}.</p>
      <table cellpadding="6" style="border-collapse:collapse"><tr><th align="left">SKU</th><th align="left">Product</th><th>Qty</th><th>Unit cost</th></tr>${rows}</table>
      <p><b>Total ${po.total} ${po.currency ?? ""}</b> · ${po.units} units</p>
      ${po.notes ? `<p>${po.notes}</p>` : ""}${supplierNotes ? `<p>${supplierNotes}</p>` : ""}
      <p>The order is attached as a CSV.</p>
    </div>`;
  try {
    await axios.post(
      "https://api.resend.com/emails",
      {
        from: config.alerts.fromEmail,
        to: [po.supplier.email],
        subject: `Purchase order ${po.number} from ${store?.name || store?.store_domain}`,
        html,
        attachments: [{ filename: `${po.number}.csv`, content: Buffer.from(purchaseOrderCsv(po)).toString("base64") }],
      },
      { headers: { Authorization: `Bearer ${config.alerts.resendApiKey}` }, timeout: 15000 }
    );
    await query("UPDATE purchase_orders SET emailed_at=now() WHERE id=$1", [id]);
  } catch (e: any) {
    console.error(`[po] email for PO ${id} failed:`, e.response?.data || e.message);
  }
}

/* ---------------- automatic drafts ---------------- */

/**
 * Refresh suggested drafts: one automatic draft per supplier holding every
 * product that hit its reorder point and is not already on an open order.
 * Drafts someone has edited are left alone.
 */
export async function refreshAutoDrafts(storeId: number) {
  const plan = await queryOne("SELECT plan FROM stores WHERE id=$1", [storeId]);
  if (plan?.plan === "launch") return { created: 0, updated: 0, removed: 0 };
  const runDate = await latestRunDate(storeId);
  if (!runDate) return { created: 0, updated: 0, removed: 0 };
  const needs = await query(
    `SELECT vs.supplier_id, v.id AS variant_id, sr.reorder_qty, v.cost
       FROM stock_risk sr JOIN variants v ON v.id = sr.variant_id JOIN variant_supply vs ON vs.variant_id = v.id
      WHERE sr.store_id=$1 AND sr.run_date=$2 AND ${STATUS_SQL} = 'reorder_now' AND sr.reorder_qty > 0
        AND vs.supplier_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
                         WHERE l.variant_id = v.id AND po.status IN ('approved','sent','partial'))
        AND NOT EXISTS (SELECT 1 FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
                         WHERE l.variant_id = v.id AND po.status = 'draft' AND (NOT po.is_auto OR po.auto_edited))`,
    [storeId, runDate]
  );
  const bySupplier = new Map<number, any[]>();
  for (const r of needs) {
    const sid = Number(r.supplier_id);
    if (!bySupplier.has(sid)) bySupplier.set(sid, []);
    bySupplier.get(sid)!.push(r);
  }
  let created = 0, updated = 0, removed = 0;
  const autos = await query("SELECT * FROM purchase_orders WHERE store_id=$1 AND status='draft' AND is_auto AND NOT auto_edited", [storeId]);
  for (const a of autos) {
    if (!bySupplier.has(Number(a.supplier_id))) {
      await query("DELETE FROM purchase_orders WHERE id=$1", [a.id]);
      removed++;
    }
  }
  for (const [sid, rows] of bySupplier) {
    const existing = autos.find((a: any) => Number(a.supplier_id) === sid);
    const lines = rows.map((r: any) => ({ variant_id: Number(r.variant_id), quantity: Number(r.reorder_qty), unit_cost: r.cost != null ? Number(r.cost) : null }));
    if (existing) {
      await query("DELETE FROM purchase_order_lines WHERE purchase_order_id=$1", [existing.id]);
      for (const l of lines) {
        await query("INSERT INTO purchase_order_lines (purchase_order_id, variant_id, quantity, unit_cost) VALUES ($1,$2,$3,$4)", [existing.id, l.variant_id, l.quantity, l.unit_cost]);
      }
      await query("UPDATE purchase_orders SET updated_at=now() WHERE id=$1", [existing.id]);
      updated++;
    } else {
      await createPurchaseOrder(storeId, { supplier_id: sid, lines }, { auto: true });
      created++;
    }
  }
  return { created, updated, removed };
}

export { OPEN };
