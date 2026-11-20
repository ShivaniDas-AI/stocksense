/**
 * Ask StockSense (guide chapter 11): questions in plain English, answered
 * from live forecasts through tools, with charts, saved conversations, and
 * draft purchase orders. On WhatsApp every change becomes an approval
 * request instead of happening directly.
 *
 * Uses Claude through the Anthropic SDK: a manual tool loop on the beta
 * Messages endpoint so server-side refusal fallbacks can be enabled.
 * Needs ANTHROPIC_API_KEY; Scale includes 100 questions a month, Pro is unlimited.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { query, queryOne } from "../db";
import { storePlan, requireFeature } from "../plans";
import { ApiError, intField, invalid, notFound, onlyFields, strField } from "./errors";
import { getDashboard } from "./dashboard";
import { addDays, getForecastDetail, listForecasts, todayYmd } from "./forecasts";
import { getReorderPlan } from "./reorder";
import { listSuppliers } from "./suppliers";
import { listInventoryAlerts } from "./alertsEngine";
import { createPurchaseOrder, listPurchaseOrders } from "./purchaseOrders";
import { transferSuggestions } from "./transfers";
import { hasFeature } from "../plans";

const MODEL = () => config.anthropic.model || "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 8;

export const aiConfigured = () => !!config.anthropic.apiKey;

let client: Anthropic | null = null;
function anthropic() {
  if (!config.anthropic.apiKey) {
    throw new ApiError(503, "api_error", "ai_not_configured", "Ask StockSense needs ANTHROPIC_API_KEY on the server.");
  }
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

/* ---------------- charts ---------------- */

export interface Chart {
  type: "line" | "bar";
  title: string;
  x_label?: string;
  y_label?: string;
  series: { name: string; points: { x: string; y: number }[]; style?: "actual" | "forecast" | "band_low" | "band_high" | "reference" }[];
  markers?: { x: string; label: string }[];
}

export async function buildChart(storeId: number, kind: string, variantId?: number): Promise<Chart> {
  if (kind === "product_stock" || kind === "product_demand") {
    if (!variantId) throw invalid("missing_field", "variant_id is required for this chart.", "variant_id");
    const d = await getForecastDetail(storeId, variantId);
    if (kind === "product_stock") {
      return {
        type: "line",
        title: `${d.title}: projected stock`,
        y_label: "units",
        series: [
          { name: "Stock (last 21 days)", style: "actual", points: d.stock_curve.history.map((p) => ({ x: p.date, y: p.stock })) },
          { name: "Projected stock", style: "forecast", points: d.stock_curve.forecast.map((p) => ({ x: p.date, y: p.stock })) },
          { name: "80% range low", style: "band_low", points: d.stock_curve.forecast.map((p) => ({ x: p.date, y: p.low })) },
          { name: "80% range high", style: "band_high", points: d.stock_curve.forecast.map((p) => ({ x: p.date, y: p.high })) },
          ...(d.numbers.reorder_point !== null
            ? [{ name: "Reorder point", style: "reference" as const, points: d.stock_curve.forecast.map((p) => ({ x: p.date, y: d.numbers.reorder_point! })) }]
            : []),
        ],
        markers: [
          { x: d.stock_curve.markers.today, label: "today" },
          { x: d.stock_curve.markers.order_today_lands, label: "order today lands" },
        ],
      };
    }
    return {
      type: "bar",
      title: `${d.title}: weekly units sold and forecast`,
      y_label: "units",
      series: [
        { name: "Sold", style: "actual", points: d.weekly_demand.filter((w) => !w.forecast).map((w) => ({ x: w.week_start, y: w.units })) },
        { name: "Forecast", style: "forecast", points: d.weekly_demand.filter((w) => w.forecast).map((w) => ({ x: w.week_start, y: w.units })) },
      ],
    };
  }
  if (kind === "store_sales_vs_forecast") {
    const dash: any = await getDashboard(storeId);
    if (!dash.ready) throw invalid("no_forecast", "There is no forecast yet.");
    return {
      type: "bar",
      title: "Units sold against forecast",
      y_label: "units per week",
      series: [
        { name: "Sold", style: "actual", points: dash.units_sold_vs_forecast.filter((w: any) => !w.forecast).map((w: any) => ({ x: w.week_start, y: w.units })) },
        { name: "Forecast", style: "forecast", points: dash.units_sold_vs_forecast.filter((w: any) => w.forecast).map((w: any) => ({ x: w.week_start, y: w.units })) },
      ],
    };
  }
  if (kind === "overstock_cash") {
    const f = await listForecasts(storeId, { status: ["overstocked"], limit: 10, sort: "cover" });
    return {
      type: "bar",
      title: "Overstocked products by days of cover",
      y_label: "days of cover",
      series: [{ name: "Days of cover", style: "actual", points: f.data.map((r) => ({ x: r.title, y: r.cover_days ?? 0 })) }],
    };
  }
  throw invalid("invalid_chart", "kind must be product_stock, product_demand, store_sales_vs_forecast or overstock_cash.", "kind");
}

/* ---------------- tools ---------------- */

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_overview",
    description: "Store overview: SKUs tracked, how many need reordering, cash in overstock, forecast accuracy, revenue protected, products running low and the products needing attention. Start here for broad questions.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_forecasts",
    description: "List product variants with stock, sales rate, days of cover, run-out date, reorder point, suggested order, revenue at risk and status (reorder_now, watch, healthy, overstocked, no_sales, untracked). Use for 'what runs out', 'what should I reorder', 'what is overstocked'.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "array", items: { type: "string", enum: ["reorder_now", "watch", "healthy", "overstocked", "no_sales", "untracked"] } },
        q: { type: "string", description: "Search product name, SKU or vendor" },
        sort: { type: "string", enum: ["status", "cover", "revenue_at_risk", "runs_out", "name"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_forecast",
    description: "One variant's full forecast: numbers, stock curve summary, weekly demand, stock by location and ordering rules.",
    input_schema: { type: "object", properties: { variant_id: { type: "integer" } }, required: ["variant_id"], additionalProperties: false },
  },
  {
    name: "get_reorder_plan",
    description: "Reorder calculation for one variant: every supplier compared (lead time, arrival date, quantity), the quantity breakdown line by line, warnings, and other products from the same supplier that need stock.",
    input_schema: {
      type: "object",
      properties: { variant_id: { type: "integer" }, supplier_id: { type: "integer" }, coverage_days: { type: "integer", minimum: 1, maximum: 365 } },
      required: ["variant_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_suppliers",
    description: "Suppliers with set and actual (90-day) lead times, latest delivery, whether they are getting slower, minimum order value and product counts.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_alerts",
    description: "Open alerts (stockout risk, reorder point, velocity shift, lead time drift, overstock), sorted by revenue at risk.",
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["open", "dismissed", "resolved"] } }, additionalProperties: false },
  },
  {
    name: "list_purchase_orders",
    description: "Purchase orders with lines and totals. Filter by status.",
    input_schema: {
      type: "object",
      properties: { status: { type: "array", items: { type: "string", enum: ["draft", "approved", "sent", "partial", "received", "cancelled"] } } },
      additionalProperties: false,
    },
  },
  {
    name: "list_transfer_suggestions",
    description: "Suggested stock transfers between locations (Pro plan): where one location is about to run short while another has spare stock.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "show_chart",
    description: "Attach a chart to your answer. product_stock: projected stock with 80% range and reorder point; product_demand: weekly sold vs forecast; store_sales_vs_forecast: whole store; overstock_cash: overstocked products. Use when a picture helps; mention it in one short sentence.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["product_stock", "product_demand", "store_sales_vs_forecast", "overstock_cash"] },
        variant_id: { type: "integer" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "draft_purchase_order",
    description: "Draft a purchase order for one supplier. Drafts are never sent to the supplier; the merchant reviews and approves them. Use the suggested quantities from list_forecasts or get_reorder_plan unless the user gave numbers.",
    input_schema: {
      type: "object",
      properties: {
        supplier_id: { type: "integer" },
        lines: {
          type: "array",
          minItems: 1,
          items: { type: "object", properties: { variant_id: { type: "integer" }, quantity: { type: "integer", minimum: 1 } }, required: ["variant_id", "quantity"], additionalProperties: false },
        },
        notes: { type: "string" },
      },
      required: ["supplier_id", "lines"],
      additionalProperties: false,
    },
  },
];

export interface AskContext {
  storeId: number;
  channel: "app" | "whatsapp";
  /** WhatsApp: turn a proposed change into an approval request. */
  proposeChange?: (kind: string, payload: any) => Promise<string>;
}

function compact(x: any) {
  return JSON.stringify(x, (_k, v) => (v === null || v === undefined ? undefined : v));
}

async function runTool(ctx: AskContext, name: string, input: any, charts: Chart[]): Promise<string> {
  const s = ctx.storeId;
  switch (name) {
    case "get_overview": {
      const d: any = await getDashboard(s);
      if (!d.ready) return "No forecast yet: the store is still importing or has no sales history.";
      return compact({ run_date: d.run_date, cards: d.cards, running_low: d.running_low, attention_needed: d.attention_needed, suggested_order: d.suggested_order && { number: d.suggested_order.number, supplier: d.suggested_order.supplier.name, total: d.suggested_order.total, lines: d.suggested_order.line_count } });
    }
    case "list_forecasts": {
      const r = await listForecasts(s, { status: input.status, q: input.q, sort: input.sort, limit: Math.min(input.limit ?? 20, 50) });
      return compact({
        run_date: r.run_date, total: r.total, counts: r.counts,
        products: r.data.map((p) => ({ variant_id: p.variant_id, title: p.title, sku: p.sku, status: p.status, on_hand: p.on_hand, on_order: p.on_order, rate_per_day: p.rate_per_day, cover_days: p.cover_days, runs_out_on: p.runs_out_on, reorder_point: p.reorder_point, suggested_quantity: p.suggested_quantity, revenue_at_risk: p.revenue_at_risk, supplier: p.supplier, lead_time_days: p.lead_time_days, unit_cost: p.unit_cost, confidence: p.confidence })),
      });
    }
    case "get_forecast": {
      const d = await getForecastDetail(s, intField(input, "variant_id", { required: true, min: 1 })!);
      return compact({ ...d, daily_forecast: undefined, stock_curve: { markers: d.stock_curve.markers, first_days: d.stock_curve.forecast.slice(0, 14) } });
    }
    case "get_reorder_plan": {
      const p = await getReorderPlan(s, intField(input, "variant_id", { required: true, min: 1 })!, { supplier_id: input.supplier_id, coverage_days: input.coverage_days });
      return compact({ ...p, effect: undefined });
    }
    case "list_suppliers": {
      const r = await listSuppliers(s, { limit: 100 });
      return compact(r.data.map((x: any) => ({ id: x.id, name: x.name, email: x.email, lead_time_days: x.lead_time_days, lead_time_90d_days: x.lead_time_90d_days, lead_time_latest_days: x.lead_time_latest_days, lead_time_trend: x.lead_time_trend, deliveries_90d: x.deliveries_90d, min_order_value: x.min_order_value, product_count: x.product_count, scorecard: x.scorecard })));
    }
    case "list_alerts": {
      const r = await listInventoryAlerts(s, { status: input.status ?? "open", limit: 25 });
      return compact(r.data.map((a) => ({ id: a.id, type: a.type, title: a.title, message: a.message, revenue_at_risk: a.revenue_at_risk, product: a.product, supplier: a.supplier })));
    }
    case "list_purchase_orders": {
      const r = await listPurchaseOrders(s, { status: input.status, limit: 20 });
      return compact(r.data.map((p) => ({ id: p.id, number: p.number, status: p.status, supplier: p.supplier.name, expected_at: p.expected_at, total: p.total, lines: p.lines.map((l) => ({ title: l.title, quantity: l.quantity })) })));
    }
    case "list_transfer_suggestions": {
      if (!(await hasFeature(s, "transfers"))) return "Transfers need the Pro plan.";
      return compact(await transferSuggestions(s));
    }
    case "show_chart": {
      const c = await buildChart(s, String(input.kind), input.variant_id);
      charts.push(c);
      return `Chart attached: ${c.title}.`;
    }
    case "draft_purchase_order": {
      const body = { supplier_id: input.supplier_id, lines: input.lines, notes: input.notes };
      if (ctx.channel === "whatsapp" && ctx.proposeChange) {
        return ctx.proposeChange("create_po_draft", body);
      }
      const po = await createPurchaseOrder(s, body);
      return `Created draft ${po.number} for ${po.supplier.name}: ${po.line_count} line(s), ${po.units} units, total ${po.total} ${po.currency ?? ""}. It is a draft; nothing is sent to the supplier until the merchant approves and sends it. Purchase order id ${po.id}.`;
    }
  }
  return `Unknown tool ${name}.`;
}

async function systemPrompt(storeId: number, channel: string) {
  const s = await queryOne("SELECT name, store_domain, currency FROM stores WHERE id=$1", [storeId]);
  return [
    `You are StockSense, the inventory assistant for the store "${s?.name || s?.store_domain}". Money is in ${s?.currency || "USD"}. Today is ${todayYmd()}.`,
    "Answer questions about stock, demand forecasts, reordering, suppliers, purchase orders, alerts and transfers using the tools. Every number you state must come from a tool result; if the tools cannot answer, say so.",
    "Lead with the answer. Name products with their SKU. Give exact quantities, dates and amounts. Keep answers short: a few sentences or a compact list.",
    "When the user asks you to order, draft a purchase order with draft_purchase_order, one per supplier, using the suggested quantities unless they gave their own. Drafts are never sent to suppliers; say that the merchant reviews and approves them.",
    "Statuses: reorder_now means order today; watch means an order will be needed within the lead time plus four weeks; overstocked means more cover than the overstock limit.",
    channel === "whatsapp"
      ? "You are replying on WhatsApp: plain text, no markdown tables or headings, at most about 900 characters. Changes you propose are sent to the user as an approval request."
      : "Markdown lists and bold are fine.",
  ].join("\n");
}

/* ---------------- conversations ---------------- */

function groupOf(ts: string | Date) {
  const d = new Date(ts);
  const now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return "Older";
}

export async function listConversations(storeId: number) {
  const rows = await query(
    `SELECT c.*, (SELECT COUNT(*) FROM ask_messages m WHERE m.conversation_id=c.id AND m.text IS NOT NULL)::int AS messages
       FROM ask_conversations c WHERE c.store_id=$1 AND c.channel='app' ORDER BY c.updated_at DESC LIMIT 200`,
    [storeId]
  );
  return rows.map((c: any) => ({ id: Number(c.id), title: c.title, messages: c.messages, created_at: c.created_at, updated_at: c.updated_at, group: groupOf(c.updated_at) }));
}

export async function createConversation(storeId: number, body: any = {}, channel = "app") {
  onlyFields(body, ["title"]);
  const c = await queryOne(
    "INSERT INTO ask_conversations (store_id, title, channel) VALUES ($1, COALESCE($2, 'New conversation'), $3) RETURNING *",
    [storeId, strField(body, "title", { max: 120 }) ?? null, channel]
  );
  return { id: Number(c.id), title: c.title, created_at: c.created_at, updated_at: c.updated_at };
}

async function getConv(storeId: number, id: number) {
  const c = await queryOne("SELECT * FROM ask_conversations WHERE id=$1 AND store_id=$2", [id, storeId]);
  if (!c) throw notFound("conversation", id);
  return c;
}

export async function getConversation(storeId: number, id: number) {
  const c = await getConv(storeId, id);
  const msgs = await query("SELECT id, role, text, charts, created_at FROM ask_messages WHERE conversation_id=$1 AND text IS NOT NULL ORDER BY id", [id]);
  return {
    id: Number(c.id), title: c.title, created_at: c.created_at, updated_at: c.updated_at,
    messages: msgs.map((m: any) => ({ id: Number(m.id), role: m.role, text: m.text, charts: m.charts ?? [], created_at: m.created_at })),
  };
}

export async function renameConversation(storeId: number, id: number, body: any) {
  onlyFields(body, ["title"]);
  await getConv(storeId, id);
  const title = strField(body, "title", { required: true, max: 120 });
  await query("UPDATE ask_conversations SET title=$2 WHERE id=$1", [id, title]);
  return { id, title };
}

export async function deleteConversation(storeId: number, id: number) {
  await getConv(storeId, id);
  await query("DELETE FROM ask_conversations WHERE id=$1", [id]);
  return { id, deleted: true };
}

export async function deleteAllConversations(storeId: number) {
  const r = await query("DELETE FROM ask_conversations WHERE store_id=$1 RETURNING id", [storeId]);
  return { deleted: r.length };
}

export async function askUsage(storeId: number) {
  const plan = await storePlan(storeId);
  const used = await queryOne(
    `SELECT COUNT(*)::int AS n FROM ask_messages m JOIN ask_conversations c ON c.id = m.conversation_id
      WHERE c.store_id=$1 AND m.role='user' AND m.text IS NOT NULL AND m.created_at >= date_trunc('month', now())`,
    [storeId]
  );
  return {
    plan: plan.id,
    questions_this_month: used?.n ?? 0,
    monthly_limit: plan.ask_monthly_limit, // null = unlimited
    remaining: plan.ask_monthly_limit === null ? null : Math.max(plan.ask_monthly_limit - (used?.n ?? 0), 0),
    resets_on: addDays(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString().slice(0, 10), 0),
    configured: aiConfigured(),
  };
}

/* ---------------- ask ---------------- */

export async function ask(ctx: AskContext, conversationId: number, question: string) {
  await requireFeature(ctx.storeId, "ask");
  const q = question.trim();
  if (!q) throw invalid("missing_field", "text is required.", "text");
  if (q.length > 4000) throw invalid("too_long", "Questions can be at most 4000 characters.", "text");
  const usage = await askUsage(ctx.storeId);
  if (usage.remaining === 0) {
    throw new ApiError(402, "plan_error", "ask_limit_reached", `This month's ${usage.monthly_limit} questions are used. Pro includes unlimited questions.`);
  }
  const conv = await getConv(ctx.storeId, conversationId);
  const sdk = anthropic();

  const history = await query("SELECT role, content FROM ask_messages WHERE conversation_id=$1 ORDER BY id", [conversationId]);
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m: any) => ({ role: m.role, content: m.content }));
  const userMsg: Anthropic.Beta.BetaMessageParam = { role: "user", content: q };
  messages.push(userMsg);
  await query("INSERT INTO ask_messages (conversation_id, role, content, text) VALUES ($1,'user',$2,$3)", [conversationId, JSON.stringify(q), q]);

  const system = await systemPrompt(ctx.storeId, ctx.channel);
  const charts: Chart[] = [];
  let answer = "";
  let stop: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await sdk.beta.messages.create({
        model: MODEL(),
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        cache_control: { type: "ephemeral" },
        system,
        tools: TOOLS,
        messages,
      });
    } catch (e: any) {
      if (e instanceof Anthropic.RateLimitError) throw new ApiError(503, "api_error", "ai_busy", "Ask StockSense is busy. Try again in a minute.");
      if (e instanceof Anthropic.AuthenticationError) throw new ApiError(503, "api_error", "ai_not_configured", "The server's ANTHROPIC_API_KEY was rejected.");
      if (e instanceof Anthropic.APIError) throw new ApiError(502, "api_error", "ai_error", `The AI service returned an error (${e.status ?? "network"}). Try again.`);
      throw e;
    }
    stop = response.stop_reason;
    // Keep the assistant turn exactly as returned (thinking blocks included).
    messages.push({ role: "assistant", content: response.content as any });
    await query("INSERT INTO ask_messages (conversation_id, role, content) VALUES ($1,'assistant',$2)", [conversationId, JSON.stringify(response.content)]);

    if (response.stop_reason === "refusal") {
      answer = "I can't help with that one. Ask me about your stock, forecasts, suppliers or orders.";
      break;
    }
    if (response.stop_reason === "pause_turn") continue;

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!toolUses.length) {
      answer = text || (response.stop_reason === "max_tokens" ? "That answer ran too long. Try a narrower question." : "");
      break;
    }

    // Run every tool call, return all results in one user message.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const t of toolUses) {
      try {
        const out = await runTool(ctx, t.name, t.input ?? {}, charts);
        results.push({ type: "tool_result", tool_use_id: t.id, content: out.slice(0, 60_000) });
      } catch (e: any) {
        results.push({ type: "tool_result", tool_use_id: t.id, content: e instanceof ApiError ? e.message : `Tool failed: ${e.message}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
    await query("INSERT INTO ask_messages (conversation_id, role, content) VALUES ($1,'user',$2)", [conversationId, JSON.stringify(results)]);
    if (round === MAX_TOOL_ROUNDS - 1) answer = text || "I looked through a lot of data without settling on an answer. Try a narrower question.";
  }

  if (!answer) answer = "I couldn't put an answer together. Try rephrasing the question.";
  // Store the displayable answer on the last assistant row.
  await query(
    `UPDATE ask_messages SET text=$2, charts=$3 WHERE id = (SELECT MAX(id) FROM ask_messages WHERE conversation_id=$1 AND role='assistant')`,
    [conversationId, answer, JSON.stringify(charts)]
  );
  if (conv.title === "New conversation") {
    await query("UPDATE ask_conversations SET title=$2 WHERE id=$1", [conversationId, q.length > 60 ? q.slice(0, 57) + "…" : q]);
  }
  await query("UPDATE ask_conversations SET updated_at=now() WHERE id=$1", [conversationId]);
  return { conversation_id: conversationId, answer, charts, stop_reason: stop };
}
