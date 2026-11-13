/**
 * OpenAPI 3.1 description of the public /v1 API. Served at /v1/openapi.json
 * and rendered at /docs. Keep it in step with routes/v1.ts.
 */
import { config } from "./config";

const err = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const RISK = ["critical", "low_stock", "healthy", "overstocked", "no_demand", "untracked"];

export function openApiSpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "StockSense API",
      version: "1.0.0",
      description: [
        "Read stockout forecasts, risk levels and inventory KPIs for a connected store, adjust reorder settings, and trigger fresh forecasts.",
        "",
        "**Authentication.** Create a key in the StockSense app under *Settings → API keys* and send it as `Authorization: Bearer ss_live_...` (or `X-API-Key`). Each key sees exactly one store. The full key is shown once, when you create it.",
        "",
        "**Rate limits.** 120 requests per minute per key. Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; a `429` adds `Retry-After`.",
        "",
        "**Conventions.** Objects come back as `{ \"data\": { ... } }`, lists as `{ \"data\": [ ... ], \"has_more\", \"next_offset\", \"total\" }`. Money is in the store's currency at retail price. Dates are `YYYY-MM-DD`. Errors are `{ \"error\": { \"type\", \"code\", \"message\" } }`, and every response has an `X-Request-Id` header to quote when reporting a problem.",
      ].join("\n"),
    },
    servers: [{ url: `${config.appUrl.replace(/\/+$/, "")}/v1`, description: "This server" }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Store", description: "The store this key belongs to" },
      { name: "Insights", description: "Risk counts and inventory KPIs" },
      { name: "Products", description: "Per-SKU forecasts, risk and reorder settings" },
      { name: "Alerts", description: "Items flagged by the daily digest" },
      { name: "Forecasts", description: "Run a fresh forecast on demand" },
    ],
    paths: {
      "/store": {
        get: {
          tags: ["Store"], operationId: "getStore", summary: "Get the store",
          responses: {
            "200": { description: "The store", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Store" } } } } } },
            "401": err("Missing or invalid API key"),
          },
        },
      },
      "/summary": {
        get: {
          tags: ["Insights"], operationId: "getSummary", summary: "Risk counts and KPIs for the latest forecast",
          description: "When no forecast has run yet, `ready` is false and `forecast_job_status` says whether one is queued, running, done or failed.",
          responses: {
            "200": { description: "Summary", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Summary" } } } } } },
            "401": err("Missing or invalid API key"),
          },
        },
      },
      "/products": {
        get: {
          tags: ["Products"], operationId: "listProducts", summary: "List products with their risk",
          parameters: [
            { name: "risk_level", in: "query", description: "Comma-separated filter, e.g. `critical,low_stock`", schema: { type: "string" }, example: "critical,low_stock" },
            { name: "q", in: "query", description: "Search title or SKU", schema: { type: "string" } },
            { name: "sort", in: "query", schema: { type: "string", enum: ["risk", "stockout", "revenue_at_risk", "stock", "name"], default: "risk" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
          ],
          responses: {
            "200": {
              description: "A page of products",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  data: { type: "array", items: { $ref: "#/components/schemas/Product" } },
                  run_date: { type: ["string", "null"], format: "date" },
                  total: { type: "integer" },
                  has_more: { type: "boolean" },
                  next_offset: { type: ["integer", "null"] },
                },
              } } },
            },
            "400": err("Unknown risk_level or sort"),
            "401": err("Missing or invalid API key"),
          },
        },
      },
      "/products/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        get: {
          tags: ["Products"], operationId: "getProduct", summary: "Get one product with its forecast curve and sales history",
          parameters: [{ name: "history_days", in: "query", schema: { type: "integer", minimum: 1, maximum: 365, default: 90 } }],
          responses: {
            "200": { description: "The product", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/ProductDetail" } } } } } },
            "404": err("No such product in this store"),
          },
        },
        patch: {
          tags: ["Products"], operationId: "updateProduct", summary: "Update lead time and safety stock",
          description: "Risk levels and reorder quantities use the new values from the next forecast run. Call `POST /forecasts` to apply them now.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                lead_time_days: { type: "integer", minimum: 1, description: "Days from placing an order to receiving stock" },
                safety_stock: { type: "integer", minimum: 0, description: "Units kept as a buffer" },
              },
              additionalProperties: false,
            }, example: { lead_time_days: 10, safety_stock: 5 } } },
          },
          responses: {
            "200": { description: "The updated product", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/ProductDetail" } } } } } },
            "400": err("Body missing, unknown field or invalid value"),
            "404": err("No such product in this store"),
          },
        },
      },
      "/alerts": {
        get: {
          tags: ["Alerts"], operationId: "listAlerts", summary: "List recent alerts",
          parameters: [
            { name: "unacknowledged", in: "query", schema: { type: "boolean", default: false } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: {
            "200": { description: "Alerts, newest first", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Alert" } }, has_more: { type: "boolean" }, next_offset: { type: ["integer", "null"] } } } } } },
          },
        },
      },
      "/alerts/{id}/acknowledge": {
        post: {
          tags: ["Alerts"], operationId: "acknowledgeAlert", summary: "Mark an alert as seen",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": { description: "Acknowledged", content: { "application/json": { schema: { type: "object", properties: { data: { type: "object", properties: { id: { type: "integer" }, acknowledged: { type: "boolean" } } } } } } } },
            "404": err("No such alert"),
          },
        },
      },
      "/forecasts": {
        post: {
          tags: ["Forecasts"], operationId: "runForecast", summary: "Queue a fresh forecast",
          description: "The worker picks queued jobs up within about 30 seconds. Poll `GET /forecasts/{id}` until `status` is `done` or `error`.",
          responses: { "202": { description: "Queued", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/ForecastJob" } } } } } } },
        },
      },
      "/forecasts/{id}": {
        get: {
          tags: ["Forecasts"], operationId: "getForecastJob", summary: "Check a forecast job",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": { description: "The job", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/ForecastJob" } } } } } },
            "404": err("No such job"),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "An API key such as `ss_live_...`" },
        apiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["authentication_error", "invalid_request_error", "not_found", "rate_limit_error", "api_error"] },
                code: { type: "string", examples: ["invalid_api_key"] },
                message: { type: "string" },
              },
            },
          },
        },
        Store: {
          type: "object",
          properties: {
            id: { type: "integer" },
            platform: { type: "string", enum: ["shopify", "bigcommerce", "woocommerce"] },
            domain: { type: "string" },
            currency: { type: "string", examples: ["USD"] },
            sync_status: { type: "string", enum: ["pending", "syncing", "ready", "error", "uninstalled"] },
            sync_error: { type: ["string", "null"] },
          },
        },
        Kpis: {
          type: "object",
          description: "Money at retail price; stock figures exclude untracked products.",
          properties: {
            healthy_pct: { type: ["integer", "null"] },
            units_on_hand: { type: "integer" },
            inventory_value: { type: "number" },
            reorder_units: { type: "integer" },
            reorder_value: { type: "number" },
            overstock_units: { type: "integer" },
            overstock_value: { type: "number" },
            median_cover_days: { type: ["integer", "null"] },
            next_stockout_date: { type: ["string", "null"], format: "date" },
            next_stockout_title: { type: ["string", "null"] },
            next_stockout_variant_id: { type: ["integer", "null"] },
            sales_30d: { type: "object", properties: { units: { type: "integer" }, revenue: { type: "number" } } },
            sales_prev_30d: { type: "object", properties: { units: { type: "integer" }, revenue: { type: "number" } } },
            forecast_30d: { type: "object", properties: { units: { type: "integer" }, revenue: { type: "number" } } },
            sell_through_30d: { type: ["integer", "null"] },
          },
        },
        Summary: {
          type: "object",
          properties: {
            ready: { type: "boolean" },
            run_date: { type: "string", format: "date" },
            counts: {
              type: "object",
              properties: Object.fromEntries(["forecasted", "tracked", "at_risk", ...RISK].map((k) => [k, { type: "integer" }])),
            },
            revenue_at_risk: { type: "number" },
            kpis: { $ref: "#/components/schemas/Kpis" },
            forecast_job_status: { type: ["string", "null"], description: "Only when ready is false" },
          },
        },
        Product: {
          type: "object",
          properties: {
            id: { type: "integer" },
            sku: { type: ["string", "null"] },
            title: { type: "string" },
            image_url: { type: ["string", "null"] },
            price: { type: ["number", "null"] },
            risk_level: { type: "string", enum: RISK },
            stock: { type: "object", properties: { on_hand: { type: ["integer", "null"] }, tracked: { type: "boolean" } } },
            days_of_cover: { type: ["number", "null"] },
            stockout_date: { type: ["string", "null"], format: "date" },
            reorder_point: { type: ["integer", "null"] },
            reorder_quantity: { type: ["integer", "null"] },
            revenue_at_risk: { type: "number" },
            demand: { type: "object", properties: { avg_daily: { type: ["number", "null"] }, model: { type: ["string", "null"], enum: ["AutoETS", "CrostonSBA", "SMA", null] } } },
            settings: { type: "object", properties: { lead_time_days: { type: "integer" }, safety_stock: { type: "integer" } } },
          },
        },
        ProductDetail: {
          allOf: [
            { $ref: "#/components/schemas/Product" },
            {
              type: "object",
              properties: {
                product_title: { type: "string" },
                forecast: {
                  type: ["object", "null"],
                  properties: {
                    run_date: { type: "string", format: "date" },
                    model: { type: "string" },
                    avg_daily_demand: { type: "number" },
                    daily: { type: "array", items: { type: "object", properties: { date: { type: "string", format: "date" }, units: { type: "number" } } } },
                  },
                },
                sales_history: { type: "array", items: { type: "object", properties: { date: { type: "string", format: "date" }, units: { type: "integer" } } } },
              },
            },
          ],
        },
        Alert: {
          type: "object",
          properties: {
            id: { type: "integer" },
            product_id: { type: "integer" },
            product_title: { type: "string" },
            sku: { type: ["string", "null"] },
            type: { type: "string" },
            risk_level: { type: "string", enum: RISK },
            sent_at: { type: "string", format: "date-time" },
            acknowledged: { type: "boolean" },
          },
        },
        ForecastJob: {
          type: "object",
          properties: {
            id: { type: "integer" },
            status: { type: "string", enum: ["queued", "running", "done", "error"] },
            started_at: { type: ["string", "null"], format: "date-time" },
            finished_at: { type: ["string", "null"], format: "date-time" },
            error: { type: ["string", "null"] },
          },
        },
      },
    },
  };
}
