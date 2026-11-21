/**
 * WhatsApp settings and approvals (Settings > WhatsApp):
 *   - link codes: "Send this code from the phone you want to connect. It works for 10 minutes."
 *   - connected numbers: can_approve or view_only, disconnect
 *   - "What was asked and done on WhatsApp": every change proposed by the
 *     menus or the AI, valid for 30 minutes, and whether it was approved.
 */
import crypto from "crypto";
import { query, queryOne, withTransaction } from "../db";
import { config } from "../config";
import { requireFeature } from "../plans";
import { conflict, invalid, notFound, onlyFields, strField } from "../services/errors";
import { normalisePhone } from "../services/settings";
import { createPurchaseOrder, purchaseOrderAction, getPurchaseOrder } from "../services/purchaseOrders";
import { createSupplier } from "../services/suppliers";
import { saveReorderPreferences } from "../services/reorder";
import { inventoryAlertAction } from "../services/alertsEngine";
import { createTransfer } from "../services/transfers";
import { whatsappConfigured } from "./cloud";
import { aiConfigured } from "../services/ask";

const LINK_MINUTES = 10;
const APPROVAL_MINUTES = 30;

/* ---------------- settings page ---------------- */

export async function whatsappStatus(storeId: number) {
  const numbers = await listNumbers(storeId);
  const code = await queryOne(
    "SELECT code, expires_at FROM whatsapp_link_codes WHERE store_id=$1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
    [storeId]
  );
  return {
    enabled: whatsappConfigured(),
    provider: "WhatsApp Cloud API",
    business_number: config.whatsapp.businessNumber || null,
    ai_answers: aiConfigured(),
    note: aiConfigured() ? null : "AI answers need GEMINI_API_KEY (or ANTHROPIC_API_KEY) on the server. Until then, menus work and typed text searches products.",
    link_code: code ? { code: code.code, message: `link ${code.code}`, expires_at: code.expires_at } : null,
    connected_numbers: numbers,
  };
}

/** A fresh 6-digit code; older unused codes for the store stop working. */
export async function createLinkCode(storeId: number) {
  await requireFeature(storeId, "messaging_alerts");
  await query("UPDATE whatsapp_link_codes SET expires_at = now() WHERE store_id=$1 AND used_at IS NULL AND expires_at > now()", [storeId]);
  let code = "";
  for (let i = 0; i < 5; i++) {
    code = String(crypto.randomInt(100000, 1000000));
    const r = await query(
      `INSERT INTO whatsapp_link_codes (code, store_id, expires_at) VALUES ($1,$2, now() + interval '${LINK_MINUTES} minutes')
       ON CONFLICT (code) DO NOTHING RETURNING code`,
      [code, storeId]
    );
    if (r.length) break;
    // Re-use only if the old code has expired.
    await query("DELETE FROM whatsapp_link_codes WHERE code=$1 AND (expires_at < now() - interval '1 day')", [code]);
  }
  const row = await queryOne("SELECT code, expires_at FROM whatsapp_link_codes WHERE code=$1", [code]);
  const biz = config.whatsapp.businessNumber;
  return {
    code: row.code,
    message: `link ${row.code}`,
    expires_at: row.expires_at,
    send_to: biz || null,
    open_whatsapp_url: biz ? `https://wa.me/${biz.replace(/\D/g, "")}?text=${encodeURIComponent(`link ${row.code}`)}` : null,
    instructions: `From the phone you want to connect, send "link ${row.code}"${biz ? ` to ${biz}` : ""} within ${LINK_MINUTES} minutes.`,
  };
}

export async function listNumbers(storeId: number) {
  const rows = await query("SELECT * FROM whatsapp_numbers WHERE store_id=$1 ORDER BY connected_at", [storeId]);
  return rows.map((n: any) => ({ id: Number(n.id), phone: "+" + n.phone, role: n.role, connected_at: n.connected_at, last_message_at: n.last_message_at }));
}

export async function updateNumber(storeId: number, id: number, body: any) {
  onlyFields(body, ["role"]);
  const role = strField(body, "role", { required: true });
  if (role !== "can_approve" && role !== "view_only") throw invalid("invalid_role", "role must be can_approve or view_only.", "role");
  const r = await queryOne("UPDATE whatsapp_numbers SET role=$3 WHERE id=$1 AND store_id=$2 RETURNING *", [id, storeId, role]);
  if (!r) throw notFound("connected number", id);
  return { id, phone: "+" + r.phone, role: r.role };
}

export async function disconnectNumber(storeId: number, id: number) {
  const r = await queryOne("DELETE FROM whatsapp_numbers WHERE id=$1 AND store_id=$2 RETURNING phone", [id, storeId]);
  if (!r) throw notFound("connected number", id);
  await query("DELETE FROM whatsapp_sessions WHERE phone=$1", [r.phone]);
  await query("UPDATE whatsapp_actions SET status='cancelled', decided_at=now() WHERE phone=$1 AND status='pending'", [r.phone]);
  return { id, phone: "+" + r.phone, disconnected: true };
}

// Wrong link codes per phone in the last hour, so codes cannot be guessed.
const failedLinks = new Map<string, number[]>();

/** Called by the bot when a phone sends "link 123456". */
export async function redeemLinkCode(phoneRaw: string, code: string) {
  const phone = normalisePhone(phoneRaw);
  const recent = (failedLinks.get(phone) ?? []).filter((t) => Date.now() - t < 3_600_000);
  if (recent.length >= 5) return { ok: false as const, reason: "Too many wrong codes from this number. Try again in an hour." };
  const c = await queryOne("SELECT * FROM whatsapp_link_codes WHERE code=$1 AND used_at IS NULL AND expires_at > now()", [code]);
  if (!c) {
    failedLinks.set(phone, [...recent, Date.now()]);
    return { ok: false as const, reason: "That code is not valid or has expired. Open StockSense, Settings, WhatsApp and send the new code shown there." };
  }
  await query("UPDATE whatsapp_link_codes SET used_at=now() WHERE code=$1", [code]);
  const existing = await queryOne("SELECT store_id FROM whatsapp_numbers WHERE phone=$1", [phone]);
  if (existing && Number(existing.store_id) !== Number(c.store_id)) {
    await query("UPDATE whatsapp_numbers SET store_id=$2, role='can_approve', connected_at=now() WHERE phone=$1", [phone, c.store_id]);
  } else if (!existing) {
    await query("INSERT INTO whatsapp_numbers (store_id, phone) VALUES ($1,$2)", [c.store_id, phone]);
  }
  const store = await queryOne("SELECT name, store_domain FROM stores WHERE id=$1", [c.store_id]);
  return { ok: true as const, storeId: Number(c.store_id), storeName: store?.name || store?.store_domain };
}

/* ---------------- approvals ---------------- */

export type ActionKind =
  | "create_po_draft" | "approve_po" | "send_po" | "receive_po" | "cancel_po"
  | "add_supplier" | "set_preferred_supplier" | "dismiss_alert" | "create_transfer";

const KIND_TITLE: Record<ActionKind, string> = {
  create_po_draft: "Draft purchase order",
  approve_po: "Approve purchase order",
  send_po: "Send purchase order",
  receive_po: "Receive purchase order",
  cancel_po: "Cancel purchase order",
  add_supplier: "Add supplier",
  set_preferred_supplier: "Set preferred supplier",
  dismiss_alert: "Dismiss alert",
  create_transfer: "Create transfer",
};

/** Record a proposed change; it runs only if approved within 30 minutes. */
export async function proposeAction(storeId: number, phone: string, source: "menu" | "ai", kind: ActionKind, summary: string, payload: any) {
  const a = await queryOne(
    `INSERT INTO whatsapp_actions (store_id, phone, source, kind, title, summary, payload, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '${APPROVAL_MINUTES} minutes') RETURNING *`,
    [storeId, phone, source, kind, KIND_TITLE[kind], summary, payload]
  );
  return a;
}

/** Approve (as the given phone) and run a pending action. */
export async function approveAction(storeId: number, phone: string, actionId: number) {
  const a = await queryOne("SELECT * FROM whatsapp_actions WHERE id=$1 AND store_id=$2 FOR UPDATE", [actionId, storeId]);
  if (!a) throw notFound("request", actionId);
  const n = await queryOne("SELECT role FROM whatsapp_numbers WHERE phone=$1 AND store_id=$2", [phone, storeId]);
  if (n?.role !== "can_approve") throw conflict("view_only", "This number can view but not approve changes. Ask the store owner to allow approvals in Settings, WhatsApp.");
  if (a.status !== "pending") throw conflict("not_pending", `This request was already ${a.status}.`);
  if (new Date(a.expires_at) < new Date()) {
    await query("UPDATE whatsapp_actions SET status='expired', decided_at=now() WHERE id=$1", [actionId]);
    throw conflict("expired", "This request has expired (they are valid for 30 minutes). Start again from the menu.");
  }
  let result: any;
  try {
    result = await withTransaction(() => execute(storeId, a.kind as ActionKind, a.payload));
  } catch (e: any) {
    await query("UPDATE whatsapp_actions SET status='failed', decided_at=now(), result=$2 WHERE id=$1", [actionId, { error: e.message }]);
    throw e;
  }
  await query("UPDATE whatsapp_actions SET status='done', decided_at=now(), result=$2 WHERE id=$1", [actionId, result]);
  return { action: a, result };
}

export async function cancelAction(storeId: number, actionId: number) {
  const a = await queryOne("UPDATE whatsapp_actions SET status='cancelled', decided_at=now() WHERE id=$1 AND store_id=$2 AND status='pending' RETURNING *", [actionId, storeId]);
  return a;
}

async function execute(storeId: number, kind: ActionKind, p: any): Promise<any> {
  switch (kind) {
    case "create_po_draft": {
      const po = await createPurchaseOrder(storeId, { supplier_id: p.supplier_id, lines: p.lines, notes: p.notes });
      return { purchase_order_id: po.id, number: po.number, total: po.total };
    }
    case "approve_po":
    case "send_po":
    case "receive_po":
    case "cancel_po": {
      const action = kind === "approve_po" ? "approve" : kind === "send_po" ? "send" : kind === "receive_po" ? "receive" : "cancel";
      const po: any = await purchaseOrderAction(storeId, p.purchase_order_id, action === "send" ? { action, email_supplier: true } : { action });
      return { purchase_order_id: po.id, number: po.number, status: po.status, email: po.email ?? null };
    }
    case "add_supplier": {
      const s = await createSupplier(storeId, { name: p.name, lead_time_days: p.lead_time_days, ...(p.email ? { email: p.email } : {}) });
      return { supplier_id: s.id, name: s.name };
    }
    case "set_preferred_supplier":
      return saveReorderPreferences(storeId, p.variant_id, { supplier_id: p.supplier_id, save_for_product: true });
    case "dismiss_alert": {
      const a = await inventoryAlertAction(storeId, p.alert_id, { action: "dismiss" });
      return { alert_id: a.id, status: a.status };
    }
    case "create_transfer": {
      const t = await createTransfer(storeId, p);
      return { transfer_id: t.id, number: t.number, units: t.units };
    }
  }
}

export async function listActivity(storeId: number, limit = 50) {
  const rows = await query(
    "SELECT * FROM whatsapp_actions WHERE store_id=$1 ORDER BY created_at DESC LIMIT $2",
    [storeId, Math.min(Math.max(limit, 1), 200)]
  );
  return rows.map((a: any) => ({
    id: Number(a.id),
    title: a.title,
    source: a.source,
    summary: a.summary,
    phone: "+" + a.phone,
    status: a.status,
    result: a.result,
    created_at: a.created_at,
    expires_at: a.expires_at,
    decided_at: a.decided_at,
  }));
}

export async function expireWhatsappActions() {
  await query("UPDATE whatsapp_actions SET status='expired', decided_at=now() WHERE status='pending' AND expires_at < now()");
}

export { getPurchaseOrder };
