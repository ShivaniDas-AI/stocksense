/**
 * OpenAPI 3.1 description of the StockSense API (/api/v1). Served at
 * /api/v1/openapi.json and rendered at /docs. Keep in step with routes/v1.
 */
import { config } from "./config";
import { EVENTS } from "./services/webhooksOut";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: any) => ({ "application/json": { schema } });
const data = (schema: any) => json({ type: "object", properties: { data: schema } });
const list = (item: any, extra: Record<string, any> = {}) =>
  json({ type: "object", properties: { data: { type: "array", items: item }, page: { type: "integer" }, limit: { type: "integer" }, total: { type: "integer" }, has_more: { type: "boolean" }, ...extra } });
const err = (description: string) => ({ description, content: json(ref("Error")) });
const ok = (description: string, content: any) => ({ description, content });
const id = (name = "id") => ({ name, in: "path", required: true, schema: { type: "integer", minimum: 1 } });
const q = (name: string, schema: any, description?: string) => ({ name, in: "query", schema, ...(description ? { description } : {}) });
const page = [q("page", { type: "integer", minimum: 1, default: 1 }), q("limit", { type: "integer", minimum: 1, maximum: 250, default: 50 })];
const body = (schema: any, example?: any) => ({ required: true, content: { "application/json": { schema, ...(example ? { example } : {}) } } });
const action = (actions: string[], extra: Record<string, any> = {}) =>
  ({ type: "object", required: ["action"], properties: { action: { type: "string", enum: actions }, ...extra }, additionalProperties: false });

const STATUS = ["reorder_now", "watch", "healthy", "overstocked", "no_sales", "untracked"];
const PO_STATUS = ["draft", "approved", "sent", "partial", "received", "cancelled"];
const ALERT_TYPES = ["stockout_risk", "reorder_point", "velocity_shift", "lead_time_drift", "overstock"];
const COMMON = { "401": err("Missing or invalid API key"), "402": err("The store's plan does not include this"), "429": err("Rate limit reached") };

export function openApiSpec() {
  const paths: Record<string, any> = {
    /* ---------- store ---------- */
    "/store": { get: { tags: ["Store"], operationId: "getStore", summary: "The store this key belongs to", responses: { "200": ok("Store", data(ref("Store"))), ...COMMON } } },
    "/plan": { get: { tags: ["Store"], operationId: "getPlan", summary: "Plan, limits, features and usage (SKUs, locations, Ask questions)", responses: { "200": ok("Plan", data({ type: "object" })) } } },

    /* ---------- insights ---------- */
    "/dashboard": {
      get: {
        tags: ["Insights"], operationId: "getDashboard", summary: "Dashboard: SKUs tracked, need reordering, cash in overstock, forecast accuracy, revenue protected, sold vs forecast, running low, attention needed, suggested order",
        parameters: [q("location_id", { type: "integer" }, "One location instead of the whole business")],
        responses: { "200": ok("Dashboard", data(ref("Dashboard"))) },
      },
    },
    "/kpis/{metric}": { get: { tags: ["Insights"], operationId: "getKpiDetail", summary: "Detail behind a dashboard number: headline figures, chart series and tables (metric: sales, forecast, accuracy, cover, overstock, protected, at_risk)", parameters: [{ name: "metric", in: "path", required: true, schema: { type: "string", enum: ["sales", "forecast", "accuracy", "cover", "overstock", "protected", "at_risk"] } }], responses: { "200": ok("Detail", data({ type: "object" })), "400": err("Unknown metric") } } },
    "/summary": { get: { tags: ["Insights"], operationId: "getSummary", summary: "Risk counts, revenue at risk and inventory KPIs", responses: { "200": ok("Summary", data({ type: "object" })) } } },

    /* ---------- forecasts ---------- */
    "/forecasts": {
      get: {
        tags: ["Forecasts"], operationId: "listForecasts", summary: "All forecasts: stock, rate per day, cover, run-out date, reorder point, suggested order, revenue at risk and status",
        parameters: [
          q("status", { type: "string" }, `Comma-separated: ${STATUS.join(", ")}`),
          q("location_id", { type: "integer" }, "Per-location view: stock at the location, demand by its share of sales"),
          q("q", { type: "string" }, "Search product name, SKU or vendor"),
          q("sort", { type: "string", enum: ["status", "cover", "revenue_at_risk", "runs_out", "name"], default: "status" }),
          ...page,
        ],
        responses: { "200": ok("A page of forecasts", list(ref("Forecast"), { counts: { type: "object", description: "Products per status (for the status buttons)" }, run_date: { type: "string", format: "date" } })), "400": err("Unknown status or sort") },
      },
      post: { tags: ["Forecasts"], operationId: "rebuildForecastsAlias", summary: "Rebuild every forecast now (same as POST /forecasts/rebuild)", responses: { "202": ok("Queued", data(ref("Job"))) } },
    },
    "/forecasts.csv": { get: { tags: ["Forecasts"], operationId: "exportForecasts", summary: "Export the forecast list as CSV (same filters)", parameters: [q("status", { type: "string" }), q("location_id", { type: "integer" }), q("q", { type: "string" })], responses: { "200": { description: "CSV", content: { "text/csv": { schema: { type: "string" } } } } } } },
    "/forecasts/rebuild": { post: { tags: ["Forecasts"], operationId: "rebuildForecasts", summary: "Rebuild every forecast now; poll GET /jobs/{id}", responses: { "202": ok("Queued", data(ref("Job"))) } } },
    "/forecasts/{variantId}": {
      get: {
        tags: ["Forecasts"], operationId: "getForecast", summary: "One variant: summary sentence, numbers, stock curve (21 days back, forecast with 80% range), daily series, weekly demand, stock by location, ordering rules",
        parameters: [id("variantId")],
        responses: { "200": ok("Forecast detail", data(ref("ForecastDetail"))), "404": err("No such variant") },
      },
    },
    "/forecasts/{variantId}/settings": {
      patch: {
        tags: ["Forecasts"], operationId: "updateOrderingSettings", summary: "Ordering rules: supplier, case pack, minimum order, product lead time, unit cost. Saving recalculates in the background.",
        parameters: [id("variantId")],
        requestBody: body({ type: "object", additionalProperties: false, properties: {
          supplier_id: { type: ["integer", "null"] }, case_pack: { type: "integer", minimum: 1 }, min_order_qty: { type: "integer", minimum: 0 },
          lead_time_days: { type: ["integer", "null"], minimum: 1, maximum: 365, description: "null uses the supplier's" }, unit_cost: { type: ["number", "null"], minimum: 0 }, min_safety_stock: { type: "integer", minimum: 0 },
        } }, { case_pack: 6, min_order_qty: 24 }),
        responses: { "200": ok("Saved", data({ type: "object" })), "400": err("Invalid value") },
      },
    },
    "/jobs/{id}": { get: { tags: ["Forecasts"], operationId: "getJob", summary: "A forecast rebuild job", parameters: [id()], responses: { "200": ok("Job", data(ref("Job"))) } } },

    /* ---------- reorder ---------- */
    "/reorder/{variantId}": {
      get: {
        tags: ["Reorder"], operationId: "getReorderPlan", summary: "Reorder screen: every supplier side by side, the quantity line by line, stock with and without the order, warnings, other products from the supplier",
        parameters: [id("variantId"), q("supplier_id", { type: "integer" }), q("coverage_days", { type: "integer", minimum: 1, maximum: 365 }), q("lead_time_days", { type: "integer" }), q("case_pack", { type: "integer" }), q("min_order_qty", { type: "integer" })],
        responses: { "200": ok("Plan", data(ref("ReorderPlan"))) },
      },
    },
    "/reorder/{variantId}/preferences": {
      post: {
        tags: ["Reorder"], operationId: "saveReorderPreferences", summary: "Save supplier and rules only: preferred supplier for the product and/or its whole category",
        parameters: [id("variantId")],
        requestBody: body({ type: "object", properties: { supplier_id: { type: "integer" }, save_for_product: { type: "boolean", default: true }, make_category_preferred: { type: "boolean", default: false }, case_pack: { type: "integer" }, min_order_qty: { type: "integer" }, lead_time_days: { type: ["integer", "null"] }, unit_cost: { type: "number" } } }),
        responses: { "200": ok("Saved", data({ type: "object" })) },
      },
    },
    "/reorder/{variantId}/purchase-order": {
      post: {
        tags: ["Reorder"], operationId: "createOrderFromReorder", summary: "Create the purchase order from the reorder screen (new draft or add to an open draft)",
        parameters: [id("variantId")],
        requestBody: body({ type: "object", properties: {
          supplier_id: { type: "integer" }, quantity: { type: "integer", description: "Defaults to the suggestion" }, unit_cost: { type: "number" },
          add_to: { oneOf: [{ type: "string", enum: ["new"] }, { type: "integer", description: "An open draft's id" }] }, notes: { type: "string" },
          also: { type: "array", items: { type: "object", properties: { variant_id: { type: "integer" }, quantity: { type: "integer" } } } },
          save_preferences: { type: "boolean", default: true }, coverage_days: { type: "integer" }, lead_time_days: { type: "integer" }, case_pack: { type: "integer" }, min_order_qty: { type: "integer" }, location_id: { type: "integer" },
        } }, { supplier_id: 3, notes: "Please ship together" }),
        responses: { "201": ok("Draft purchase order", data(ref("PurchaseOrder"))), "402": err("Draft purchase orders need Scale or Pro") },
      },
    },

    /* ---------- purchase orders ---------- */
    "/purchase-orders": {
      get: { tags: ["Purchase orders"], operationId: "listPurchaseOrders", summary: "Purchase orders with their lines", parameters: [q("status", { type: "string" }, `Comma-separated: ${PO_STATUS.join(", ")}`), q("supplier_id", { type: "integer" }), ...page], responses: { "200": ok("Page", list(ref("PurchaseOrder"))) } },
      post: {
        tags: ["Purchase orders"], operationId: "createPurchaseOrder", summary: "Create a draft",
        requestBody: body({ type: "object", required: ["supplier_id", "lines"], additionalProperties: false, properties: {
          supplier_id: { type: "integer" }, location_id: { type: "integer" }, notes: { type: "string" }, expected_at: { type: "string", format: "date" },
          lines: { type: "array", items: { type: "object", required: ["variant_id", "quantity"], properties: { variant_id: { type: "integer" }, quantity: { type: "integer", minimum: 1 }, unit_cost: { type: "number" } } } },
        } }, { supplier_id: 3, lines: [{ variant_id: 41, quantity: 120, unit_cost: 21 }] }),
        responses: { "201": ok("Draft", data(ref("PurchaseOrder"))), "400": err("Invalid supplier, variant or quantity"), "402": err("Needs Scale or Pro") },
      },
    },
    "/purchase-orders/refresh-drafts": { post: { tags: ["Purchase orders"], operationId: "refreshDrafts", summary: "Rebuild the automatic drafts (one per supplier) from the latest forecasts", responses: { "200": ok("Counts", data({ type: "object", properties: { created: { type: "integer" }, updated: { type: "integer" }, removed: { type: "integer" } } })) } } },
    "/purchase-orders/{id}": {
      get: { tags: ["Purchase orders"], operationId: "getPurchaseOrder", summary: "One purchase order", parameters: [id()], responses: { "200": ok("Purchase order", data(ref("PurchaseOrder"))), "404": err("Not found") } },
      patch: {
        tags: ["Purchase orders"], operationId: "updateDraft", summary: "Edit a draft: quantities (0 removes a line), location, expected date, notes, supplier",
        parameters: [id()],
        requestBody: body({ type: "object", properties: { lines: { type: "array", items: { type: "object", properties: { variant_id: { type: "integer" }, quantity: { type: "integer", minimum: 0 }, unit_cost: { type: "number" } } } }, location_id: { type: "integer" }, expected_at: { type: "string", format: "date" }, notes: { type: "string" }, supplier_id: { type: "integer" } } }),
        responses: { "200": ok("Draft", data(ref("PurchaseOrder"))), "409": err("Not a draft") },
      },
      post: {
        tags: ["Purchase orders"], operationId: "purchaseOrderAction", summary: "Move through the lifecycle: approve, send (emails the supplier a CSV), cancel, receive (adds stock, records the real lead time)",
        parameters: [id()],
        requestBody: body(action(["approve", "send", "cancel", "receive"], {
          email_supplier: { type: "boolean", default: true },
          lines: { type: "array", description: "receive: units received now; omit to receive everything outstanding", items: { type: "object", properties: { variant_id: { type: "integer" }, quantity: { type: "integer", minimum: 0 } } } },
        }), { action: "send", email_supplier: true }),
        responses: { "200": ok("Updated", data(ref("PurchaseOrder"))), "409": err("Not allowed from the current status") },
      },
    },
    "/purchase-orders/{id}/csv": { get: { tags: ["Purchase orders"], operationId: "purchaseOrderCsv", summary: "The order as CSV", parameters: [id()], responses: { "200": { description: "CSV", content: { "text/csv": { schema: { type: "string" } } } } } } },

    /* ---------- suppliers ---------- */
    "/suppliers": {
      get: { tags: ["Suppliers"], operationId: "listSuppliers", summary: "Suppliers with set, 90-day and latest lead times (Pro: on-time rate, fill rate, open order value)", parameters: [q("q", { type: "string" }), ...page], responses: { "200": ok("Page", list(ref("Supplier"))) } },
      post: { tags: ["Suppliers"], operationId: "upsertSupplier", summary: "Create, or update when id is given", requestBody: body(ref("SupplierInput"), { name: "Northline Supply", email: "po@northline.example", lead_time_days: 7, vendors: ["Northline"] }), responses: { "201": ok("Created", data(ref("Supplier"))), "200": ok("Updated", data(ref("Supplier"))), "400": err("A field is invalid; error.field names it") } },
    },
    "/suppliers/{id}": {
      get: { tags: ["Suppliers"], operationId: "getSupplier", summary: "One supplier with recent lead time history", parameters: [id()], responses: { "200": ok("Supplier", data(ref("Supplier"))) } },
      patch: { tags: ["Suppliers"], operationId: "updateSupplier", summary: "Update fields", parameters: [id()], requestBody: body(ref("SupplierInput")), responses: { "200": ok("Supplier", data(ref("Supplier"))) } },
      delete: { tags: ["Suppliers"], operationId: "deleteSupplier", summary: "Delete; its products are unassigned and its purchase orders kept", parameters: [id()], responses: { "200": ok("Deleted", data({ type: "object" })) } },
    },
    "/vendors": { get: { tags: ["Suppliers"], operationId: "listVendors", summary: "Product vendors with counts and the supplier that makes them", responses: { "200": ok("Vendors", data({ type: "array" })) } } },
    "/categories": { get: { tags: ["Suppliers"], operationId: "listCategories", summary: "Product categories with counts and preferred supplier", responses: { "200": ok("Categories", data({ type: "array" })) } } },

    /* ---------- alerts ---------- */
    "/alerts": {
      get: { tags: ["Alerts"], operationId: "listAlerts", summary: "Alerts, urgent first then by revenue at risk", parameters: [q("status", { type: "string", enum: ["open", "dismissed", "resolved", "all"], default: "open" }), q("type", { type: "string" }, `Comma-separated: ${ALERT_TYPES.join(", ")}`), ...page], responses: { "200": ok("Page", list(ref("Alert"), { counts: { type: "object" } })) } },
    },
    "/alerts/check": { post: { tags: ["Alerts"], operationId: "checkAlerts", summary: "Check alerts now (also runs after every forecast)", responses: { "200": ok("Opened and resolved", data({ type: "object" })) } } },
    "/alerts/{id}": {
      get: { tags: ["Alerts"], operationId: "getAlert", summary: "One alert", parameters: [id()], responses: { "200": ok("Alert", data(ref("Alert"))) } },
      post: { tags: ["Alerts"], operationId: "alertAction", summary: "Dismiss or reopen", parameters: [id()], requestBody: body(action(["dismiss", "reopen"]), { action: "dismiss" }), responses: { "200": ok("Alert", data(ref("Alert"))), "409": err("Not allowed from the current status") } },
    },

    /* ---------- locations & transfers ---------- */
    "/locations": {
      get: { tags: ["Locations & transfers"], operationId: "listLocations", summary: "Locations with units on hand", responses: { "200": ok("Locations", data({ type: "array", items: ref("Location") })) } },
      post: { tags: ["Locations & transfers"], operationId: "createLocation", summary: "Add a location (Scale or Pro for more than one)", requestBody: body({ type: "object", required: ["name"], properties: { name: { type: "string" }, external_id: { type: "string" } } }), responses: { "201": ok("Location", data(ref("Location"))) } },
    },
    "/locations/{id}": { patch: { tags: ["Locations & transfers"], operationId: "updateLocation", summary: "Rename or turn off", parameters: [id()], requestBody: body({ type: "object", properties: { name: { type: "string" }, active: { type: "boolean" }, external_id: { type: ["string", "null"] } } }), responses: { "200": ok("Location", data(ref("Location"))) } } },
    "/locations/{id}/inventory": {
      get: { tags: ["Locations & transfers"], operationId: "locationInventory", summary: "Stock at a location", parameters: [id()], responses: { "200": ok("Levels", data({ type: "array" })) } },
      put: { tags: ["Locations & transfers"], operationId: "setLocationInventory", summary: "Set stock at a location (for a warehouse or system the store platform does not report)", parameters: [id()], requestBody: body({ type: "object", required: ["levels"], properties: { levels: { type: "array", maxItems: 1000, items: { type: "object", required: ["variant_id", "on_hand"], properties: { variant_id: { type: "integer" }, on_hand: { type: "integer", minimum: 0 } } } } } }, { levels: [{ variant_id: 41, on_hand: 120 }] }), responses: { "200": ok("Updated", data({ type: "object" })) } },
    },
    "/transfers/suggestions": { get: { tags: ["Locations & transfers"], operationId: "transferSuggestions", summary: "Suggested transfers grouped by route, with cover before and after at both locations (Pro)", responses: { "200": ok("Routes", data({ type: "object" })) } } },
    "/transfers": {
      get: { tags: ["Locations & transfers"], operationId: "listTransfers", summary: "Transfers", parameters: [q("status", { type: "string", enum: ["draft", "shipped", "received", "cancelled"] }), ...page], responses: { "200": ok("Page", list(ref("Transfer"))) } },
      post: { tags: ["Locations & transfers"], operationId: "createTransfer", summary: "Create a draft transfer", requestBody: body({ type: "object", required: ["from_location_id", "to_location_id", "lines"], properties: { from_location_id: { type: "integer" }, to_location_id: { type: "integer" }, notes: { type: "string" }, lines: { type: "array", items: { type: "object", properties: { variant_id: { type: "integer" }, quantity: { type: "integer", minimum: 1 } } } } } }), responses: { "201": ok("Transfer", data(ref("Transfer"))) } },
    },
    "/transfers/{id}": {
      get: { tags: ["Locations & transfers"], operationId: "getTransfer", summary: "One transfer", parameters: [id()], responses: { "200": ok("Transfer", data(ref("Transfer"))) } },
      post: { tags: ["Locations & transfers"], operationId: "transferAction", summary: "Ship, receive (moves the stock) or cancel", parameters: [id()], requestBody: body(action(["ship", "receive", "cancel"])), responses: { "200": ok("Transfer", data(ref("Transfer"))) } },
    },

    /* ---------- promotions & settings ---------- */
    "/promotions": {
      get: { tags: ["Settings"], operationId: "listPromotions", summary: "Planned promotions", parameters: [q("include_past", { type: "boolean" })], responses: { "200": ok("Promotions", data({ type: "array", items: ref("Promotion") })) } },
      post: { tags: ["Settings"], operationId: "createPromotion", summary: "Add a planned promotion; forecasts rise on those days", requestBody: body(ref("PromotionInput"), { name: "Black Friday", starts_on: "2026-11-27", ends_on: "2026-11-30", uplift_pct: 60, scope: "all" }), responses: { "201": ok("Promotion", data({ type: "object" })) } },
    },
    "/promotions/{id}": {
      patch: { tags: ["Settings"], operationId: "updatePromotion", summary: "Change a promotion", parameters: [id()], requestBody: body(ref("PromotionInput")), responses: { "200": ok("Promotion", data({ type: "object" })) } },
      delete: { tags: ["Settings"], operationId: "deletePromotion", summary: "Remove a promotion", parameters: [id()], responses: { "200": ok("Deleted", data({ type: "object" })) } },
    },
    "/settings/forecasting": {
      get: { tags: ["Settings"], operationId: "getForecastSettings", summary: "Service level, default lead time, order coverage, overstock limit, velocity alert threshold", responses: { "200": ok("Settings", data(ref("ForecastSettings"))) } },
      patch: { tags: ["Settings"], operationId: "updateForecastSettings", summary: "Change forecasting rules; saving rebuilds every forecast", requestBody: body(ref("ForecastSettings"), { service_level: 0.97, coverage_days: 45 }), responses: { "200": ok("Settings", data({ type: "object" })) } },
    },
    "/settings/notifications": {
      get: { tags: ["Settings"], operationId: "getNotificationSettings", summary: "Alert email, Slack, SMS and WhatsApp", responses: { "200": ok("Settings", data(ref("NotificationSettings"))) } },
      patch: { tags: ["Settings"], operationId: "updateNotificationSettings", summary: "Change notification channels", requestBody: body(ref("NotificationSettings")), responses: { "200": ok("Settings", data(ref("NotificationSettings"))) } },
    },
    "/settings/notifications/test": { post: { tags: ["Settings"], operationId: "sendTestAlert", summary: "Send a test alert; the result names any problem per channel", responses: { "200": ok("Results", data({ type: "object" })) } } },

    /* ---------- webhooks ---------- */
    "/webhooks": {
      get: { tags: ["Webhooks"], operationId: "listWebhooks", summary: "Webhook endpoints (Pro)", responses: { "200": ok("Endpoints", data({ type: "array", items: ref("WebhookEndpoint") })) } },
      post: { tags: ["Webhooks"], operationId: "createWebhook", summary: "Add an endpoint; the signing secret is shown once", requestBody: body({ type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, events: { type: "array", items: { type: "string", enum: ["*", ...EVENTS] }, default: ["*"] }, description: { type: "string" } } }, { url: "https://erp.example.com/stocksense", events: ["alert.stockout_risk", "purchase_order.received"] }), responses: { "201": ok("Endpoint with secret", data(ref("WebhookEndpoint"))) } },
    },
    "/webhooks/{id}": {
      patch: { tags: ["Webhooks"], operationId: "updateWebhook", summary: "Change URL, events or turn off", parameters: [id()], requestBody: body({ type: "object", properties: { url: { type: "string" }, events: { type: "array", items: { type: "string" } }, active: { type: "boolean" }, description: { type: "string" } } }), responses: { "200": ok("Endpoint", data(ref("WebhookEndpoint"))) } },
      delete: { tags: ["Webhooks"], operationId: "deleteWebhook", summary: "Remove an endpoint", parameters: [id()], responses: { "200": ok("Deleted", data({ type: "object" })) } },
    },
    "/webhooks/{id}/test": { post: { tags: ["Webhooks"], operationId: "testWebhook", summary: "Send a signed test event now", parameters: [id()], responses: { "200": ok("Result", data({ type: "object" })) } } },
    "/webhooks/{id}/deliveries": { get: { tags: ["Webhooks"], operationId: "listDeliveries", summary: "Recent deliveries with status and attempts", parameters: [id(), q("limit", { type: "integer" })], responses: { "200": ok("Deliveries", data({ type: "array" })) } } },

    /* ---------- data & sync ---------- */
    "/data/status": { get: { tags: ["Data & sync"], operationId: "syncStatus", summary: "Sync health, last forecast, history range, recent jobs", responses: { "200": ok("Status", data({ type: "object" })) } } },
    "/data/rebuild": { post: { tags: ["Data & sync"], operationId: "rebuild", summary: "Refresh stock, pull the last 3 days of orders and rebuild forecasts", responses: { "202": ok("Started", data({ type: "object" })) } } },
    "/data/reimport": { post: { tags: ["Data & sync"], operationId: "reimport", summary: "Re-import order history from the store platform", responses: { "202": ok("Started", data({ type: "object" })) } } },
    "/data/demo": {
      post: { tags: ["Data & sync"], operationId: "loadDemoData", summary: "Load demo data: products, 14 months of sales, two locations, suppliers", responses: { "201": ok("Loaded", data({ type: "object" })), "409": err("Already loaded") } },
      delete: { tags: ["Data & sync"], operationId: "removeDemoData", summary: "Remove demo data", responses: { "200": ok("Removed", data({ type: "object" })) } },
    },

    /* ---------- Ask StockSense ---------- */
    "/ask": { post: { tags: ["Ask StockSense"], operationId: "ask", summary: "Ask a question in plain English; answers use live forecasts and can include charts and draft purchase orders", requestBody: body({ type: "object", required: ["question"], properties: { question: { type: "string", maxLength: 4000 }, conversation_id: { type: "integer" } } }, { question: "What should I reorder this week, and from whom? Draft the order." }), responses: { "200": ok("Answer", data(ref("AskAnswer"))), "402": err("Plan or monthly question limit"), "503": err("ANTHROPIC_API_KEY not set on the server") } } },
    "/ask/usage": { get: { tags: ["Ask StockSense"], operationId: "askUsage", summary: "Questions used this month and the limit", responses: { "200": ok("Usage", data({ type: "object" })) } } },
    "/ask/conversations": {
      get: { tags: ["Ask StockSense"], operationId: "listConversations", summary: "Saved conversations, grouped Today / Yesterday / Previous 7 days / ...", responses: { "200": ok("Conversations", data({ type: "array" })) } },
      post: { tags: ["Ask StockSense"], operationId: "createConversation", summary: "Start a conversation", requestBody: body({ type: "object", properties: { title: { type: "string" } } }), responses: { "201": ok("Conversation", data({ type: "object" })) } },
      delete: { tags: ["Ask StockSense"], operationId: "deleteAllConversations", summary: "Delete all saved conversations", responses: { "200": ok("Deleted", data({ type: "object" })) } },
    },
    "/ask/conversations/{id}": {
      get: { tags: ["Ask StockSense"], operationId: "getConversation", summary: "A conversation with its messages and charts", parameters: [id()], responses: { "200": ok("Conversation", data({ type: "object" })) } },
      patch: { tags: ["Ask StockSense"], operationId: "renameConversation", summary: "Rename", parameters: [id()], requestBody: body({ type: "object", required: ["title"], properties: { title: { type: "string" } } }), responses: { "200": ok("Renamed", data({ type: "object" })) } },
      delete: { tags: ["Ask StockSense"], operationId: "deleteConversation", summary: "Delete", parameters: [id()], responses: { "200": ok("Deleted", data({ type: "object" })) } },
    },
    "/ask/conversations/{id}/messages": { post: { tags: ["Ask StockSense"], operationId: "askInConversation", summary: "Ask a follow-up in a conversation; it remembers the context", parameters: [id()], requestBody: body({ type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 4000 } } }), responses: { "200": ok("Answer", data(ref("AskAnswer"))) } } },

    /* ---------- WhatsApp ---------- */
    "/whatsapp": { get: { tags: ["WhatsApp"], operationId: "whatsappStatus", summary: "Assistant status, current link code and connected numbers", responses: { "200": ok("Status", data({ type: "object" })) } } },
    "/whatsapp/link-codes": { post: { tags: ["WhatsApp"], operationId: "createLinkCode", summary: "New 6-digit code; send \"link <code>\" from the phone within 10 minutes", responses: { "201": ok("Code", data({ type: "object", properties: { code: { type: "string" }, message: { type: "string" }, expires_at: { type: "string", format: "date-time" }, open_whatsapp_url: { type: ["string", "null"] } } })) } } },
    "/whatsapp/numbers": { get: { tags: ["WhatsApp"], operationId: "listNumbers", summary: "Connected numbers", responses: { "200": ok("Numbers", data({ type: "array" })) } } },
    "/whatsapp/numbers/{id}": {
      patch: { tags: ["WhatsApp"], operationId: "updateNumber", summary: "Can approve or view only", parameters: [id()], requestBody: body({ type: "object", required: ["role"], properties: { role: { type: "string", enum: ["can_approve", "view_only"] } } }), responses: { "200": ok("Number", data({ type: "object" })) } },
      delete: { tags: ["WhatsApp"], operationId: "disconnectNumber", summary: "Disconnect a number", parameters: [id()], responses: { "200": ok("Disconnected", data({ type: "object" })) } },
    },
    "/whatsapp/activity": { get: { tags: ["WhatsApp"], operationId: "whatsappActivity", summary: "What was asked and done on WhatsApp: every proposed change and whether it was approved", parameters: [q("limit", { type: "integer" })], responses: { "200": ok("Activity", data({ type: "array" })) } } },
    "/whatsapp/simulate": { post: { tags: ["WhatsApp"], operationId: "simulateWhatsapp", summary: "Run the assistant without Meta: send text or a tapped button id; returns the replies and the Cloud API payloads", requestBody: body({ type: "object", required: ["from"], properties: { from: { type: "string" }, text: { type: "string" }, reply_id: { type: "string" } } }, { from: "+919876543210", text: "hi" }), responses: { "200": ok("Replies", data({ type: "object" })) } } },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "StockSense API",
      version: "1.2.0",
      description: [
        "Read forecasts and alerts, run the reorder calculation, manage purchase orders, suppliers, transfers and promotions, receive signed webhooks, and drive Ask StockSense and the WhatsApp assistant.",
        "",
        "**Authentication.** Create a key in StockSense under *Settings → API & webhooks* (Pro) and send it as `Authorization: Bearer ss_live_...` (or `X-API-Key`). Each key sees one store; the full key is shown once. **Sandbox keys** (`ss_test_...`) read live data but never save: every write runs and is rolled back, and responses carry `\"sandbox\": true`.",
        "",
        "**Rate limits.** 120 requests a minute per key, with `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; a `429` adds `Retry-After`.",
        "",
        "**Conventions.** Objects come back as `{ \"data\": {...} }`, lists as `{ \"data\": [...], \"page\", \"limit\", \"total\", \"has_more\" }`. Money is in the store's currency. Dates are `YYYY-MM-DD`. Errors are `{ \"error\": { \"type\", \"code\", \"message\", \"field\"? } }`; every response has an `X-Request-Id`. A `402` means the store's plan does not include the feature.",
        "",
        "**Webhooks.** Events: " + EVENTS.map((e) => `\`${e}\``).join(", ") + ". Every delivery is signed: `X-StockSense-Signature: sha256=hex(HMAC_SHA256(secret, timestamp + \".\" + body))` with the timestamp in `X-StockSense-Timestamp`. Failed deliveries are retried after 30 s, 5 min, 30 min and 2 h.",
      ].join("\n"),
    },
    servers: [{ url: `${config.appUrl.replace(/\/+$/, "")}/api/v1`, description: "This server" }],
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    tags: [
      { name: "Store" }, { name: "Insights" }, { name: "Forecasts" }, { name: "Reorder" }, { name: "Purchase orders" }, { name: "Suppliers" },
      { name: "Alerts" }, { name: "Locations & transfers" }, { name: "Settings" }, { name: "Webhooks" }, { name: "Data & sync" },
      { name: "Ask StockSense" }, { name: "WhatsApp" },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "API key: ss_live_... or ss_test_... (sandbox)" },
        apiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
      schemas: {
        Error: { type: "object", properties: { error: { type: "object", properties: { type: { type: "string", enum: ["authentication_error", "permission_error", "invalid_request_error", "not_found", "plan_error", "rate_limit_error", "api_error"] }, code: { type: "string" }, message: { type: "string" }, field: { type: "string" } } } } },
        Store: { type: "object", properties: { id: { type: "integer" }, name: { type: ["string", "null"] }, platform: { type: "string", enum: ["shopify", "bigcommerce", "woocommerce"] }, domain: { type: "string" }, currency: { type: "string" }, sync_status: { type: "string" }, plan: { type: "string", enum: ["launch", "scale", "pro"] }, demo: { type: "boolean" } } },
        Job: { type: "object", properties: { id: { type: "integer" }, status: { type: "string", enum: ["queued", "running", "done", "error"] }, started_at: { type: ["string", "null"] }, finished_at: { type: ["string", "null"] }, error: { type: ["string", "null"] } } },
        Dashboard: { type: "object", properties: { cards: { type: "object", properties: { skus_tracked: { type: "object" }, need_reordering: { type: "object" }, cash_in_overstock: { type: "object" }, forecast_accuracy: { type: "object" }, revenue_protected: { type: "object" } } }, units_sold_vs_forecast: { type: "array" }, running_low: { type: "array" }, attention_needed: { type: "array" }, suggested_order: { oneOf: [ref("PurchaseOrder"), { type: "null" }] } } },
        Forecast: {
          type: "object",
          properties: {
            variant_id: { type: "integer" }, sku: { type: ["string", "null"] }, title: { type: "string" }, vendor: { type: ["string", "null"] }, category: { type: ["string", "null"] },
            supplier: { type: ["object", "null"], properties: { id: { type: "integer" }, name: { type: "string" } } },
            status: { type: "string", enum: STATUS }, on_hand: { type: ["integer", "null"] }, on_order: { type: "integer" },
            rate_per_day: { type: ["number", "null"], description: "Average units sold per day over the last 14 days" },
            forecast_per_day: { type: ["number", "null"] }, cover_days: { type: ["number", "null"] }, runs_out_on: { type: ["string", "null"], format: "date" },
            reorder_point: { type: ["integer", "null"] }, suggested_quantity: { type: "integer", description: "Rounded to case packs and minimums" },
            revenue_at_risk: { type: "number" }, lead_time_days: { type: "integer" }, safety_stock: { type: ["number", "null"] },
            confidence: { type: ["string", "null"], enum: ["high", "medium", "low", null] }, model: { type: ["string", "null"], enum: ["AutoETS", "CrostonSBA", "SMA", null] },
            location: { type: "object", description: "Only with location_id" },
          },
        },
        ForecastDetail: { type: "object", description: "summary, numbers, ordering, stock_curve {history, forecast (stock, low, high), markers}, daily_forecast (56 days with low/high), weekly_demand, stock_by_location" },
        ReorderPlan: { type: "object", description: "top, suppliers[] (lead_time_days, arrives_on, quantity, tags), inputs, quantity (line-by-line breakdown), suggested_quantity, reorder_point, effect[] (with_order, without_order, safety_stock), warnings[], also_order[], open_drafts[]" },
        PurchaseOrder: {
          type: "object",
          properties: {
            id: { type: "integer" }, number: { type: "string", examples: ["PO-1003"] }, status: { type: "string", enum: PO_STATUS }, automatic: { type: "boolean" },
            supplier: { type: "object", properties: { id: { type: ["integer", "null"] }, name: { type: "string" }, email: { type: ["string", "null"] } } },
            location: { type: ["object", "null"] }, expected_at: { type: ["string", "null"], format: "date" }, notes: { type: ["string", "null"] }, currency: { type: ["string", "null"] },
            lines: { type: "array", items: { type: "object", properties: { variant_id: { type: "integer" }, title: { type: "string" }, sku: { type: ["string", "null"] }, quantity: { type: "integer" }, received_quantity: { type: "integer" }, unit_cost: { type: ["number", "null"] }, line_total: { type: "number" } } } },
            line_count: { type: "integer" }, units: { type: "integer" }, total: { type: "number" }, warnings: { type: "array" },
            approved_at: { type: ["string", "null"] }, sent_at: { type: ["string", "null"] }, received_at: { type: ["string", "null"] }, platform_sync: { type: ["object", "null"] },
          },
        },
        SupplierInput: {
          type: "object",
          properties: {
            id: { type: "integer", description: "POST /suppliers only: update this supplier" }, name: { type: "string" }, website: { type: "string" }, address: { type: "string" },
            contact_name: { type: "string" }, email: { type: "string", description: "Purchase orders are emailed here" }, phone: { type: "string" },
            lead_time_days: { type: "integer", minimum: 1, maximum: 365 }, min_order_value: { type: "number" }, currency: { type: "string" }, payment_terms: { type: "string" }, notes: { type: "string" },
            vendors: { type: "array", items: { type: "string" }, description: "Vendors this supplier makes" }, categories: { type: "array", items: { type: "string" }, description: "Categories it is preferred for (wins over vendor)" },
          },
        },
        Supplier: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, lead_time_days: { type: "integer" }, lead_time_90d_days: { type: ["number", "null"] }, lead_time_latest_days: { type: ["number", "null"] }, lead_time_effective_days: { type: "integer" }, lead_time_trend: { type: ["string", "null"], enum: ["slower", "faster", "steady", null] }, deliveries_90d: { type: "integer" }, vendors: { type: "array", items: { type: "string" } }, categories: { type: "array", items: { type: "string" } }, product_count: { type: "integer" }, scorecard: { type: "object", description: "Pro" } } },
        Alert: { type: "object", properties: { id: { type: "integer" }, type: { type: "string", enum: ALERT_TYPES }, status: { type: "string", enum: ["open", "dismissed", "resolved"] }, urgent: { type: "boolean" }, title: { type: "string" }, message: { type: "string" }, what_to_do: { type: "string" }, revenue_at_risk: { type: "number" }, product: { type: ["object", "null"] }, supplier: { type: ["object", "null"] }, opened_at: { type: "string" }, resolved_at: { type: ["string", "null"] }, resolved_by_purchase_order: { type: ["object", "null"] } } },
        Location: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, external_id: { type: ["string", "null"] }, is_default: { type: "boolean" }, active: { type: "boolean" }, units_on_hand: { type: "integer" } } },
        Transfer: { type: "object", properties: { id: { type: "integer" }, number: { type: "string" }, status: { type: "string" }, from_location: { type: "object" }, to_location: { type: "object" }, lines: { type: "array" }, units: { type: "integer" } } },
        Promotion: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, starts_on: { type: "string", format: "date" }, ends_on: { type: "string", format: "date" }, uplift_pct: { type: "number" }, scope: { type: "string" }, scope_value: { type: ["string", "null"] }, active_now: { type: "boolean" } } },
        PromotionInput: { type: "object", properties: { name: { type: "string" }, starts_on: { type: "string", format: "date" }, ends_on: { type: "string", format: "date" }, uplift_pct: { type: "number", minimum: -99, maximum: 1000 }, scope: { type: "string", enum: ["all", "vendor", "product_type"] }, scope_value: { type: "string" } } },
        ForecastSettings: { type: "object", properties: { service_level: { type: "number", minimum: 0.5, maximum: 0.999, default: 0.95 }, default_lead_time_days: { type: "integer", default: 14 }, coverage_days: { type: "integer", default: 60 }, overstock_days: { type: "integer", default: 90 }, velocity_threshold: { type: "number", default: 1.8 } } },
        NotificationSettings: { type: "object", properties: { email_enabled: { type: "boolean" }, alert_email: { type: ["string", "null"] }, slack_enabled: { type: "boolean" }, slack_webhook_url: { type: ["string", "null"] }, phone: { type: ["string", "null"], description: "With country code" }, sms_enabled: { type: "boolean" }, whatsapp_enabled: { type: "boolean" }, urgent_only: { type: "boolean", description: "SMS and WhatsApp: only stockout risk and reorder point" } } },
        WebhookEndpoint: { type: "object", properties: { id: { type: "integer" }, url: { type: "string" }, events: { type: "array", items: { type: "string" } }, active: { type: "boolean" }, secret: { type: "string", description: "Only when created" } } },
        AskAnswer: { type: "object", properties: { conversation_id: { type: "integer" }, answer: { type: "string" }, charts: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: ["line", "bar"] }, title: { type: "string" }, series: { type: "array" }, markers: { type: "array" } } } } } },
      },
    },
  };
}
