/**
 * The StockSense WhatsApp assistant: menus for every feature, like a bank's
 * WhatsApp, plus questions in your own words. Every change asks for approval
 * first and nothing can be deleted from WhatsApp.
 *
 * handleMessage() takes one incoming message (typed text or the id of a tapped
 * button / list row) and returns the replies as OutMessage[]; the webhook
 * sends them through the Cloud API, the simulator returns them as JSON.
 */
import { query, queryOne } from "../db";
import { hasFeature } from "../plans";
import { ApiError } from "../services/errors";
import { getDashboard } from "../services/dashboard";
import { getForecastDetail, listForecasts, todayYmd, addDays } from "../services/forecasts";
import { getReorderPlan } from "../services/reorder";
import { listSuppliers, getSupplier } from "../services/suppliers";
import { getPurchaseOrder, listPurchaseOrders } from "../services/purchaseOrders";
import { getInventoryAlert, listInventoryAlerts } from "../services/alertsEngine";
import { transferSuggestions } from "../services/transfers";
import { ask, aiConfigured, createConversation } from "../services/ask";
import { OutMessage } from "./cloud";
import { chartUrl } from "./charts";
import { ActionKind, approveAction, cancelAction, proposeAction, redeemLinkCode } from "./actions";

interface Session {
  awaiting?: "quantity" | "search" | "question" | "supplier_name" | "supplier_lead" | "supplier_email";
  ctx?: any;
  conversation_id?: number;
}

interface Linked { storeId: number; phone: string; role: string; storeName: string; currency: string }

const MENU_BUTTON = { id: "menu", title: "Main menu" };

/* ---------------- helpers ---------------- */

function moneyFmt(currency: string) {
  return (v: number) => {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(v);
    } catch {
      return `${currency} ${Math.round(v).toLocaleString("en-US")}`;
    }
  };
}
const day = (ymd?: string | null) =>
  ymd ? new Date(String(ymd).slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "-";
const text = (t: string): OutMessage => ({ type: "text", text: t });
const STATUS_LABEL: Record<string, string> = {
  reorder_now: "Reorder now", watch: "Watch", healthy: "Healthy", overstocked: "Overstocked", no_sales: "No sales yet", untracked: "Untracked",
};

async function getSession(phone: string): Promise<Session> {
  const s = await queryOne("SELECT state FROM whatsapp_sessions WHERE phone=$1", [phone]);
  return (s?.state as Session) ?? {};
}
async function setSession(phone: string, s: Session) {
  await query(
    `INSERT INTO whatsapp_sessions (phone, state, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (phone) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [phone, s]
  );
}

/* ---------------- screens ---------------- */

function greeting(l: Linked): OutMessage[] {
  return [
    {
      type: "list",
      header: "StockSense",
      text: `What would you like to do for *${l.storeName}*?\n\nYou can also just type a question, like "what runs out this week?"`,
      footer: "Changes always need your approval",
      button: "Main menu",
      sections: [mainMenuSection()],
    },
  ];
}

function mainMenuSection() {
  return {
    title: "Main menu",
    rows: [
      { id: "m:summary", title: "Today's summary", description: "Stock at risk, drafts, cash in overstock" },
      { id: "m:reorder", title: "Reorder now", description: "What to order, how much and from whom" },
      { id: "m:forecast", title: "Product forecast", description: "Search by product name or SKU" },
      { id: "m:pos", title: "Purchase orders", description: "Approve, send and receive" },
      { id: "m:suppliers", title: "Suppliers", description: "Lead times, contacts, preferred supplier" },
      { id: "m:add_supplier", title: "Add a supplier" },
      { id: "m:alerts", title: "Alerts", description: "Stockout risks and other alerts" },
      { id: "m:transfers", title: "Transfers", description: "Move stock between locations" },
      { id: "m:ask", title: "Ask StockSense AI", description: "Ask anything in your own words" },
      { id: "m:help", title: "Settings and help" },
    ],
  };
}

function mainMenu(): OutMessage[] {
  return [{ type: "list", text: "Choose what to do.", button: "Main menu", sections: [mainMenuSection()] }];
}

async function summary(l: Linked): Promise<OutMessage[]> {
  const d: any = await getDashboard(l.storeId);
  const m = moneyFmt(l.currency);
  if (!d.ready) return [text("Your forecasts are not ready yet. They appear a minute or two after the first import."), ...mainMenu()];
  const open = await listInventoryAlerts(l.storeId, { status: "open", limit: 1 });
  const atRisk = d.attention_needed.reduce((a: number, r: any) => a + (r.revenue_at_risk || 0), 0);
  const lines = [
    `*Today's summary* · forecast ${day(d.run_date)}`,
    `${d.cards.need_reordering.value} products need reordering, ${d.cards.skus_tracked.critical} of them critical.`,
    `${m(atRisk)} of sales at risk.`,
    `${d.cards.need_reordering.draft_purchase_orders} draft purchase order${d.cards.need_reordering.draft_purchase_orders === 1 ? "" : "s"} ready.`,
    `${m(d.cards.cash_in_overstock.value)} cash in overstock.`,
    `${open.counts.open} open alert${open.counts.open === 1 ? "" : "s"}.`,
  ];
  if (d.running_low[0]) lines.push(`Running lowest: ${d.running_low[0].title}, ${Math.round(d.running_low[0].cover_days)} days of cover.`);
  return [{ type: "buttons", text: lines.join("\n"), buttons: [{ id: "m:reorder", title: "Reorder now" }, { id: "m:pos", title: "Purchase orders" }, MENU_BUTTON] }];
}

async function reorderList(l: Linked): Promise<OutMessage[]> {
  const f = await listForecasts(l.storeId, { status: ["reorder_now", "watch"], sort: "status", limit: 10 });
  if (!f.data.length) return [{ type: "buttons", text: "Nothing needs reordering right now.", buttons: [MENU_BUTTON] }];
  return [
    {
      type: "list",
      header: "Reorder now",
      text: "Products that need stock, most urgent first. Pick one to order.",
      button: "Choose product",
      sections: [{
        rows: f.data.map((p) => ({
          id: `p:${p.variant_id}`,
          title: p.title,
          description: `${STATUS_LABEL[p.status]} · ${p.cover_days !== null ? Math.round(p.cover_days) + " days left" : "no cover"} · order ${p.suggested_quantity}`,
        })),
      }],
    },
  ];
}

async function productCard(l: Linked, variantId: number, supplierId?: number): Promise<OutMessage[]> {
  const m = moneyFmt(l.currency);
  const d = await getForecastDetail(l.storeId, variantId);
  const plan = await getReorderPlan(l.storeId, variantId, supplierId ? { supplier_id: supplierId } : {});
  const sup = plan.suppliers.find((s) => s.supplier_id === plan.supplier_id);
  const qty = plan.suggested_quantity;
  const cost = d.ordering.unit_cost ?? 0;
  const lines = [
    `*${d.title}*`,
    `${d.status ? STATUS_LABEL[d.status] : "No forecast"}${d.confidence ? ` · ${d.confidence} confidence` : ""}`,
    `On hand ${d.numbers.on_hand ?? "not tracked"}${d.numbers.on_order ? ` (+${d.numbers.on_order} on order)` : ""}`,
    `Sells ${d.numbers.rate_per_day ?? d.numbers.forecast_per_day ?? 0} a day${d.numbers.cover_days !== null ? `, ${Math.round(d.numbers.cover_days)} days of cover` : ""}`,
    d.numbers.runs_out_on ? `Runs out *${day(d.numbers.runs_out_on)}*` : "No run-out in the forecast window",
    sup ? `Supplier *${sup.name}*, an order today arrives *${day(sup.arrives_on)}*` : "No supplier set",
    qty ? `Suggested order *${qty}* units${cost ? ` (${m(qty * cost)})` : ""}` : "No order needed now",
    d.numbers.revenue_at_risk ? `${m(d.numbers.revenue_at_risk)} of sales at risk` : "",
  ].filter(Boolean);
  for (const w of plan.warnings.filter((w) => w.code === "stockout_before_arrival")) lines.push(`⚠ ${w.message}`);
  const out: OutMessage[] = [{ type: "image", url: chartUrl(l.storeId, "product_stock", variantId), caption: `${d.title}: projected stock` }];
  const buttons = [];
  if (sup && qty) buttons.push({ id: `o:${variantId}:${sup.supplier_id}:${qty}`, title: `Order ${qty}` });
  if (sup) buttons.push({ id: `q:${variantId}:${sup.supplier_id}`, title: "Other quantity" });
  buttons.push(supplierId ? { id: `pf:${variantId}:${supplierId}`, title: "Make preferred" } : { id: `c:${variantId}`, title: "Compare suppliers" });
  out.push({ type: "buttons", text: lines.join("\n"), buttons: buttons.slice(0, 3) });
  return out;
}

async function compareSuppliers(l: Linked, variantId: number): Promise<OutMessage[]> {
  const plan = await getReorderPlan(l.storeId, variantId);
  if (!plan.suppliers.length) return [{ type: "buttons", text: "No suppliers yet. Add one first.", buttons: [{ id: "m:add_supplier", title: "Add a supplier" }, MENU_BUTTON] }];
  return [
    {
      type: "list",
      header: "Choose a supplier",
      text: "Lead time, arrival date and how many to order from each supplier.",
      button: "Suppliers",
      sections: [{
        rows: plan.suppliers.slice(0, 10).map((s) => ({
          id: `s:${variantId}:${s.supplier_id}`,
          title: s.name,
          description: `${s.lead_time_days} days, arrives ${day(s.arrives_on)}, order ${s.quantity}${s.tags.includes("current") ? " · current" : ""}`,
        })),
      }],
    },
  ];
}

async function confirmMessage(a: any): Promise<OutMessage[]> {
  return [{
    type: "buttons",
    header: "Please confirm",
    text: `${a.summary}\n\n_Valid for 30 minutes_`,
    buttons: [{ id: `ap:${a.id}`, title: "Approve" }, { id: `cx:${a.id}`, title: "Cancel" }],
  }];
}

async function propose(l: Linked, source: "menu" | "ai", kind: ActionKind, summaryText: string, payload: any): Promise<OutMessage[]> {
  if (l.role !== "can_approve") return [{ type: "buttons", text: "This number can view but not approve changes. Ask the store owner to allow approvals in Settings, WhatsApp.", buttons: [MENU_BUTTON] }];
  const a = await proposeAction(l.storeId, l.phone, source, kind, summaryText, payload);
  return confirmMessage(a);
}

async function orderProposal(l: Linked, variantId: number, supplierId: number, qty: number, source: "menu" | "ai" = "menu") {
  const m = moneyFmt(l.currency);
  const d = await getForecastDetail(l.storeId, variantId);
  const plan = await getReorderPlan(l.storeId, variantId, { supplier_id: supplierId });
  const sup = plan.suppliers.find((s) => s.supplier_id === supplierId)!;
  const cost = d.ordering.unit_cost;
  const total = cost ? qty * cost : null;
  const summaryText =
    `New draft purchase order for *${sup.name}*\n• ${qty} × ${d.title}${total !== null ? ` (${m(total)})` : ""}\n` +
    `${total !== null ? `Total *${m(total)}*, e` : "E"}xpected around ${day(sup.arrives_on)}.\nNothing is sent to the supplier.`;
  return propose(l, source, "create_po_draft", summaryText, { supplier_id: supplierId, lines: [{ variant_id: variantId, quantity: qty }] });
}

async function poList(l: Linked): Promise<OutMessage[]> {
  const r = await listPurchaseOrders(l.storeId, { status: ["draft", "approved", "sent", "partial"], limit: 10 });
  if (!r.data.length) return [{ type: "buttons", text: "No open purchase orders.", buttons: [{ id: "m:reorder", title: "Reorder now" }, MENU_BUTTON] }];
  const m = moneyFmt(l.currency);
  return [{
    type: "list",
    header: "Purchase orders",
    text: "Open purchase orders, newest first.",
    button: "Purchase orders",
    sections: [{ rows: r.data.map((p) => ({ id: `po:${p.id}`, title: `${p.number} · ${p.status}`, description: `${p.supplier.name} · ${p.line_count} line${p.line_count === 1 ? "" : "s"} · ${m(p.total)}` })) }],
  }];
}

async function poCard(l: Linked, id: number): Promise<OutMessage[]> {
  const m = moneyFmt(l.currency);
  const po = await getPurchaseOrder(l.storeId, id);
  const lines = [
    `*${po.number} · ${po.status}*`,
    po.supplier.name,
    ...po.lines.slice(0, 15).map((x) => `- ${x.quantity} × ${x.title}${x.received_quantity ? ` (${x.received_quantity} received)` : ""}`),
    po.lines.length > 15 ? `…and ${po.lines.length - 15} more` : "",
    `Total ${m(po.total)}`,
    po.expected_at ? `Expected ${day(po.expected_at)}` : "",
    po.status === "draft" ? "To change quantities, open it in the app or ask StockSense AI." : "",
    ...po.warnings.map((w) => `⚠ ${w.message}`),
  ].filter(Boolean);
  const next: { id: string; title: string }[] = [];
  if (po.status === "draft") next.push({ id: `pa:${po.id}`, title: "Approve" });
  if (po.status === "approved") next.push({ id: `ps:${po.id}`, title: "Send to supplier" });
  if (po.status === "sent" || po.status === "partial") next.push({ id: `pr:${po.id}`, title: "Receive all" });
  next.push({ id: "m:pos", title: "Purchase orders" }, MENU_BUTTON);
  return [{ type: "buttons", text: lines.join("\n"), buttons: next.slice(0, 3) }];
}

async function poActionProposal(l: Linked, id: number, kind: "approve_po" | "send_po" | "receive_po"): Promise<OutMessage[]> {
  const m = moneyFmt(l.currency);
  const po = await getPurchaseOrder(l.storeId, id);
  const base = `${po.number} for ${po.supplier.name}: ${po.line_count} line${po.line_count === 1 ? "" : "s"}, ${m(po.total)}.`;
  const msg =
    kind === "approve_po" ? `Approve ${base}\nIt is not sent until you send it.`
    : kind === "send_po" ? `Send ${base}\n${po.supplier.email ? `It is emailed to ${po.supplier.email} with a CSV.` : "The supplier has no email; it is marked as ordered."}`
    : `Receive everything still expected on ${po.number}. The stock is added at ${po.location?.name ?? "the default location"}.`;
  return propose(l, "menu", kind, msg, { purchase_order_id: id });
}

async function supplierList(l: Linked): Promise<OutMessage[]> {
  const r = await listSuppliers(l.storeId, { limit: 10 });
  if (!r.data.length) return [{ type: "buttons", text: "No suppliers yet.", buttons: [{ id: "m:add_supplier", title: "Add a supplier" }, MENU_BUTTON] }];
  return [{
    type: "list",
    header: "Suppliers",
    text: "Lead times as planned now; an arrow means the latest delivery was slower or faster.",
    button: "Suppliers",
    sections: [{ rows: r.data.map((s: any) => ({ id: `sp:${s.id}`, title: s.name, description: `${s.lead_time_effective_days} days${s.lead_time_trend === "slower" ? " ↑ slower" : s.lead_time_trend === "faster" ? " ↓ faster" : ""} · ${s.product_count} products` })) }],
  }];
}

async function supplierCard(l: Linked, id: number): Promise<OutMessage[]> {
  const s: any = await getSupplier(l.storeId, id);
  const lines = [
    `*${s.name}*`,
    `Lead time ${s.lead_time_effective_days} days (set ${s.lead_time_days}${s.lead_time_90d_days !== null ? `, 90-day average ${s.lead_time_90d_days}` : ""}${s.lead_time_latest_days !== null ? `, latest ${s.lead_time_latest_days}` : ""})`,
    s.contact_name || s.email || s.phone ? `Contact ${[s.contact_name, s.email, s.phone].filter(Boolean).join(", ")}` : "No contact details",
    `${s.product_count} products${s.vendors.length ? ` · makes ${s.vendors.join(", ")}` : ""}`,
    s.categories.length ? `Preferred for ${s.categories.join(", ")}` : "",
    s.scorecard ? `On time ${s.scorecard.on_time_rate !== null ? Math.round(s.scorecard.on_time_rate * 100) + "%" : "-"}, fill rate ${s.scorecard.fill_rate !== null ? Math.round(s.scorecard.fill_rate * 100) + "%" : "-"}` : "",
  ].filter(Boolean);
  return [{ type: "buttons", text: lines.join("\n"), buttons: [{ id: "m:suppliers", title: "Suppliers" }, MENU_BUTTON] }];
}

async function alertList(l: Linked): Promise<OutMessage[]> {
  const r = await listInventoryAlerts(l.storeId, { status: "open", limit: 10 });
  if (!r.data.length) return [{ type: "buttons", text: "No open alerts.", buttons: [MENU_BUTTON] }];
  const m = moneyFmt(l.currency);
  return [{
    type: "list",
    header: "Alerts",
    text: `${r.counts.open} open alert${r.counts.open === 1 ? "" : "s"}, most revenue at risk first.`,
    button: "Alerts",
    sections: [{ rows: r.data.map((a) => ({ id: `al:${a.id}`, title: a.title, description: `${a.type.replace(/_/g, " ")}${a.revenue_at_risk ? ` · ${m(a.revenue_at_risk)} at risk` : ""}` })) }],
  }];
}

async function alertCard(l: Linked, id: number): Promise<OutMessage[]> {
  const a = await getInventoryAlert(l.storeId, id);
  const buttons: { id: string; title: string }[] = [];
  if (a.product && (a.type === "stockout_risk" || a.type === "reorder_point" || a.type === "velocity_shift")) buttons.push({ id: `p:${a.product.variant_id}`, title: "Reorder" });
  if (a.status === "open") buttons.push({ id: `ad:${a.id}`, title: "Dismiss" });
  buttons.push(MENU_BUTTON);
  return [{ type: "buttons", text: `*${a.title}*\n${a.message}\n\n${a.what_to_do}`, buttons: buttons.slice(0, 3) }];
}

async function transfers(l: Linked): Promise<OutMessage[]> {
  if (!(await hasFeature(l.storeId, "transfers"))) return [{ type: "buttons", text: "Transfer suggestions are on the Pro plan.", buttons: [MENU_BUTTON] }];
  const s = await transferSuggestions(l.storeId);
  if (!s.routes.length) return [{ type: "buttons", text: s.message ?? "No transfers needed.", buttons: [MENU_BUTTON] }];
  const out: OutMessage[] = [];
  for (const rt of s.routes.slice(0, 3)) {
    const lines = [`*${rt.name}*`, ...rt.lines.slice(0, 10).map((x: any) => `• ${x.quantity} × ${x.title} (${x.to.cover_days_before ?? 0} → ${x.to.cover_days_after ?? 0} days of cover there)`)];
    out.push({ type: "buttons", text: lines.join("\n"), buttons: [{ id: `tr:${rt.from_location.id}:${rt.to_location.id}`, title: "Create transfer" }, MENU_BUTTON] });
  }
  return out;
}

async function transferProposal(l: Linked, fromId: number, toId: number): Promise<OutMessage[]> {
  const s = await transferSuggestions(l.storeId);
  const rt = s.routes.find((r: any) => r.from_location.id === fromId && r.to_location.id === toId);
  if (!rt) return [{ type: "buttons", text: "That suggestion is no longer needed.", buttons: [{ id: "m:transfers", title: "Transfers" }, MENU_BUTTON] }];
  const summaryText = `Draft transfer *${rt.name}*\n${rt.lines.map((x: any) => `• ${x.quantity} × ${x.title}`).join("\n")}\n${rt.units} units in total.`;
  return propose(l, "menu", "create_transfer", summaryText, { from_location_id: fromId, to_location_id: toId, lines: rt.lines.map((x: any) => ({ variant_id: x.variant_id, quantity: x.quantity })) });
}

async function searchProducts(l: Linked, q: string): Promise<OutMessage[]> {
  const f = await listForecasts(l.storeId, { q, limit: 10, sort: "status" });
  if (!f.data.length) return [{ type: "buttons", text: `No products match "${q}". Try a shorter name or the SKU.`, buttons: [{ id: "m:forecast", title: "Search again" }, MENU_BUTTON] }];
  if (f.data.length === 1) return productCard(l, f.data[0].variant_id);
  return [{
    type: "list",
    text: `${f.total} product${f.total === 1 ? "" : "s"} match "${q}".`,
    button: "Choose product",
    sections: [{ rows: f.data.map((p) => ({ id: `p:${p.variant_id}`, title: p.title, description: `${STATUS_LABEL[p.status]}${p.sku ? ` · ${p.sku}` : ""}` })) }],
  }];
}

function help(l: Linked): OutMessage[] {
  return [{
    type: "buttons",
    text: [
      "*Settings and help*",
      `This number is connected to ${l.storeName} and ${l.role === "can_approve" ? "can approve changes" : "can view only"}.`,
      "Every change (a draft order, approving or sending an order, a new supplier) is shown first and runs only when you tap Approve within 30 minutes.",
      "Nothing can be deleted from WhatsApp.",
      "Type a question at any time, or *menu* for the main menu.",
      "To add or remove numbers, use Settings, WhatsApp in StockSense.",
    ].join("\n"),
    buttons: [MENU_BUTTON],
  }];
}

/* ---------------- AI ---------------- */

async function askAi(l: Linked, session: Session, question: string): Promise<OutMessage[]> {
  if (!aiConfigured() || !(await hasFeature(l.storeId, "ask"))) return searchProducts(l, question);
  if (!session.conversation_id) {
    const c = await createConversation(l.storeId, { title: `WhatsApp +${l.phone}` }, "whatsapp");
    session.conversation_id = c.id;
  }
  const proposals: OutMessage[][] = [];
  try {
    const r = await ask(
      {
        storeId: l.storeId,
        channel: "whatsapp",
        proposeChange: async (kind, payload) => {
          if (kind === "create_po_draft") {
            const s = await queryOne("SELECT name FROM suppliers WHERE id=$1 AND store_id=$2", [payload.supplier_id, l.storeId]);
            if (!s) return "Unknown supplier_id.";
            const names = await query("SELECT id, title, cost FROM variants WHERE id = ANY($1) AND store_id=$2", [payload.lines.map((x: any) => x.variant_id), l.storeId]);
            const m = moneyFmt(l.currency);
            const byId = new Map(names.map((v: any) => [Number(v.id), v]));
            let total = 0;
            const lines = payload.lines.map((x: any) => {
              const v: any = byId.get(Number(x.variant_id));
              const amt = v?.cost != null ? Number(v.cost) * x.quantity : 0;
              total += amt;
              return `• ${x.quantity} × ${v?.title ?? `variant ${x.variant_id}`}${amt ? ` (${m(amt)})` : ""}`;
            });
            const msg = `New draft purchase order for *${s.name}*\n${lines.join("\n")}\n${total ? `Total *${m(total)}*. ` : ""}Nothing is sent to the supplier.`;
            const out = l.role === "can_approve" ? await confirmMessage(await proposeAction(l.storeId, l.phone, "ai", "create_po_draft", msg, payload)) : null;
            if (!out) return "This number cannot approve changes, so no draft was proposed.";
            proposals.push(out);
            return "An approval request for this draft was sent to the user; it is created only if they tap Approve within 30 minutes.";
          }
          return "That change is not available from WhatsApp.";
        },
      },
      session.conversation_id!,
      question
    );
    return [text(r.answer), ...proposals.flat()];
  } catch (e: any) {
    if (e instanceof ApiError) return [{ type: "buttons", text: e.message, buttons: [MENU_BUTTON] }];
    throw e;
  }
}

/* ---------------- entry ---------------- */

export async function handleMessage(phoneRaw: string, input: { text?: string; id?: string }): Promise<OutMessage[]> {
  const phone = phoneRaw.replace(/\D/g, "");
  const typed = (input.text ?? "").trim();

  // Linking works from any number.
  const link = typed.match(/^link\s+(\d{6})$/i);
  if (link) {
    const r = await redeemLinkCode(phone, link[1]);
    if (!r.ok) return [text(r.reason)];
    await setSession(phone, {});
    const l = await linked(phone);
    return [text(`This number is now connected to *${r.storeName}* and can approve changes.`), ...greeting(l!)];
  }

  const l = await linked(phone);
  if (!l) {
    return [text('This number is not connected to a StockSense store. In StockSense, open Settings, WhatsApp, and send the link code shown there, for example "link 206774".')];
  }
  await query("UPDATE whatsapp_numbers SET last_message_at = now() WHERE phone=$1", [phone]);
  const session = await getSession(phone);
  const out = await route(l, session, typed, input.id);
  await setSession(phone, session);
  return out;
}

async function linked(phone: string): Promise<Linked | null> {
  const n = await queryOne(
    `SELECT n.store_id, n.role, s.name, s.store_domain, s.currency FROM whatsapp_numbers n JOIN stores s ON s.id = n.store_id
      WHERE n.phone=$1 AND s.uninstalled_at IS NULL`,
    [phone]
  );
  return n ? { storeId: Number(n.store_id), phone, role: n.role, storeName: n.name || n.store_domain, currency: n.currency || "USD" } : null;
}

async function route(l: Linked, session: Session, typed: string, id?: string): Promise<OutMessage[]> {
  try {
    if (id) {
      session.awaiting = undefined;
      return await onButton(l, session, id);
    }
    if (/^(hi|hello|hey|start|menu|main menu)$/i.test(typed)) {
      session.awaiting = undefined;
      return /menu/i.test(typed) ? mainMenu() : greeting(l);
    }
    if (/^cancel$/i.test(typed)) {
      session.awaiting = undefined;
      return [text("Cancelled."), ...mainMenu()];
    }
    switch (session.awaiting) {
      case "quantity": {
        const qty = parseInt(typed.replace(/[^\d]/g, ""), 10);
        if (!qty || qty < 1 || qty > 1_000_000) return [text("Send the number of units, for example 120. Or type cancel.")];
        const { variantId, supplierId } = session.ctx;
        session.awaiting = undefined;
        return orderProposal(l, variantId, supplierId, qty);
      }
      case "search":
        session.awaiting = undefined;
        return searchProducts(l, typed);
      case "question":
        session.awaiting = undefined;
        return askAi(l, session, typed);
      case "supplier_name": {
        if (typed.length < 2 || typed.length > 120) return [text("Send the supplier's company name (2 to 120 characters).")];
        session.ctx = { name: typed };
        session.awaiting = "supplier_lead";
        return [text(`Lead time for *${typed}*: how many days from placing an order to receiving it? (1 to 365)`)];
      }
      case "supplier_lead": {
        const lt = parseInt(typed, 10);
        if (!lt || lt < 1 || lt > 365) return [text("Send a whole number of days between 1 and 365.")];
        session.ctx.lead_time_days = lt;
        session.awaiting = "supplier_email";
        return [text("Order email, where purchase orders are sent? Type *skip* to leave it empty.")];
      }
      case "supplier_email": {
        const email = /^skip$/i.test(typed) ? null : typed;
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return [text("That is not an email address. Send it again, or type skip.")];
        session.awaiting = undefined;
        const c = session.ctx;
        return propose(l, "menu", "add_supplier", `Add supplier *${c.name}*\nLead time ${c.lead_time_days} days${email ? `\nOrders emailed to ${email}` : ""}`, { name: c.name, lead_time_days: c.lead_time_days, email });
      }
    }
    if (!typed) return greeting(l);
    return await askAi(l, session, typed);
  } catch (e: any) {
    if (e instanceof ApiError) return [{ type: "buttons", text: e.message, buttons: [MENU_BUTTON] }];
    console.error("[whatsapp] handler failed:", e?.stack || e);
    return [{ type: "buttons", text: "Something went wrong. Please try again.", buttons: [MENU_BUTTON] }];
  }
}

async function onButton(l: Linked, session: Session, id: string): Promise<OutMessage[]> {
  const [kind, a, b, c] = id.split(":");
  const n = (x: string) => Number(x);
  switch (kind) {
    case "menu": return mainMenu();
    case "m":
      switch (a) {
        case "summary": return summary(l);
        case "reorder": return reorderList(l);
        case "forecast": session.awaiting = "search"; return [text("Type a product name or SKU.")];
        case "pos": return poList(l);
        case "suppliers": return supplierList(l);
        case "add_supplier":
          if (l.role !== "can_approve") return [{ type: "buttons", text: "This number can view only.", buttons: [MENU_BUTTON] }];
          session.awaiting = "supplier_name";
          return [text("What is the supplier's company name?")];
        case "alerts": return alertList(l);
        case "transfers": return transfers(l);
        case "ask":
          session.awaiting = "question";
          return [text(aiConfigured() ? 'Type your question, for example "which supplier is getting slower?"' : "AI answers are not set up on the server yet, so typed text searches products. Type a product name or SKU.")];
        case "help": return help(l);
      }
      return mainMenu();
    case "p": return productCard(l, n(a));
    case "c": return compareSuppliers(l, n(a));
    case "s": return productCard(l, n(a), n(b));
    case "o": return orderProposal(l, n(a), n(b), n(c));
    case "q":
      session.awaiting = "quantity";
      session.ctx = { variantId: n(a), supplierId: n(b) };
      return [text("How many units? Send a number, or type cancel.")];
    case "pf": {
      const s = await queryOne("SELECT name FROM suppliers WHERE id=$1 AND store_id=$2", [n(b), l.storeId]);
      const v = await queryOne("SELECT title FROM variants WHERE id=$1 AND store_id=$2", [n(a), l.storeId]);
      if (!s || !v) return mainMenu();
      return propose(l, "menu", "set_preferred_supplier", `Make *${s.name}* the preferred supplier for ${v.title}.`, { variant_id: n(a), supplier_id: n(b) });
    }
    case "ap": {
      try {
        const { action, result } = await approveAction(l.storeId, l.phone, n(a));
        return afterApproval(l, action.kind, result);
      } catch (e: any) {
        if (e instanceof ApiError) return [{ type: "buttons", text: e.message, buttons: [MENU_BUTTON] }];
        throw e;
      }
    }
    case "cx": {
      const r = await cancelAction(l.storeId, n(a));
      return [{ type: "buttons", text: r ? "Cancelled. Nothing was changed." : "That request was already decided.", buttons: [MENU_BUTTON] }];
    }
    case "po": return poCard(l, n(a));
    case "pa": return poActionProposal(l, n(a), "approve_po");
    case "ps": return poActionProposal(l, n(a), "send_po");
    case "pr": return poActionProposal(l, n(a), "receive_po");
    case "sp": return supplierCard(l, n(a));
    case "al": return alertCard(l, n(a));
    case "ad": {
      const al = await getInventoryAlert(l.storeId, n(a));
      return propose(l, "menu", "dismiss_alert", `Dismiss the alert "${al.title}". It comes back if you reopen it in the app.`, { alert_id: n(a) });
    }
    case "tr": return transferProposal(l, n(a), n(b));
  }
  return mainMenu();
}

function afterApproval(l: Linked, kind: string, r: any): OutMessage[] {
  switch (kind) {
    case "create_po_draft":
      return [{ type: "buttons", text: `Draft ${r.number} is ready.`, buttons: [{ id: `po:${r.purchase_order_id}`, title: `Open ${r.number}` }, MENU_BUTTON] }];
    case "approve_po":
    case "send_po":
    case "receive_po": {
      const what = kind === "approve_po" ? "approved" : kind === "send_po" ? (r.email?.status === "queued" ? "sent and emailed to the supplier" : "marked as ordered") : r.status === "received" ? "received; stock is added" : "partly received";
      return [{ type: "buttons", text: `${r.number} is ${what}.`, buttons: [{ id: `po:${r.purchase_order_id}`, title: `Open ${r.number}` }, MENU_BUTTON] }];
    }
    case "add_supplier":
      return [{ type: "buttons", text: `${r.name} is added.`, buttons: [{ id: `sp:${r.supplier_id}`, title: "Open supplier" }, MENU_BUTTON] }];
    case "set_preferred_supplier":
      return [{ type: "buttons", text: "Saved. Forecasts are recalculating with the new supplier.", buttons: [MENU_BUTTON] }];
    case "dismiss_alert":
      return [{ type: "buttons", text: "Alert dismissed.", buttons: [{ id: "m:alerts", title: "Alerts" }, MENU_BUTTON] }];
    case "create_transfer":
      return [{ type: "buttons", text: `Draft transfer ${r.number} created for ${r.units} units. Ship it from the app when the stock leaves.`, buttons: [MENU_BUTTON] }];
  }
  return [text("Done."), ...mainMenu()];
}

export { addDays, todayYmd };
