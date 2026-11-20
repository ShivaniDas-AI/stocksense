import express from "express";
import cookieParser from "cookie-parser";
import cron from "node-cron";
import path from "path";
import { config } from "./config";
import { authRouter } from "./routes/auth";
import { webhooksRouter } from "./routes/webhooks";
import { apiRouter } from "./routes/api";
import { v1Router } from "./routes/v1";
import { whatsappWebhookRouter } from "./whatsapp/webhook";
import { sendDailyAlerts } from "./alerts/email";
import { incrementalSync } from "./sync/sync";
import { ensureSchema, query } from "./db";
import { evaluateAlerts } from "./services/alertsEngine";
import { refreshAutoDrafts } from "./services/purchaseOrders";
import { processDueDeliveries } from "./services/webhooksOut";
import { expireWhatsappActions } from "./whatsapp/actions";
import { chartPngRouter } from "./whatsapp/charts";

const app = express();

/**
 * CORS for API clients that run in a browser (the mobile app's web build on
 * localhost:8081, or any page on another origin). Auth is a bearer token, not
 * a cookie, so the origin is reflected without credentials. The dashboard
 * itself is same-origin and unaffected.
 */
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Accept, X-API-Key, ngrok-skip-browser-warning"
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, X-StockSense-Sandbox"
    );
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Shopify and WhatsApp webhooks need the RAW body for signature checks — mount raw first.
app.use("/webhooks/shopify", express.raw({ type: "application/json" }));
app.use("/webhooks/whatsapp", express.raw({ type: "application/json", limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));
// A malformed JSON body fails in the parser above, before any router runs.
// Answer it in the API's own JSON error shape instead of Express's HTML page.
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.type !== "entity.parse.failed") return next(err);
  if (req.path.startsWith("/v1") || req.path.startsWith("/api/v1")) {
    return res.status(400).json({ error: { type: "invalid_request_error", code: "invalid_json", message: "The request body is not valid JSON." } });
  }
  res.status(400).json({ error: "Invalid JSON body" });
});
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/webhooks/whatsapp", whatsappWebhookRouter);
app.use("/webhooks", webhooksRouter);
// The public API: /api/v1 is the base URL in the user guide; /v1 stays for earlier integrations.
app.use("/api/v1", v1Router);
app.use("/v1", v1Router);
app.use("/api", apiRouter);
app.use("/charts", chartPngRouter);

// Dashboard + connect pages (static, no build step).
const pub = path.join(__dirname, "..", "public");
app.get("/docs", (_req, res) => res.sendFile(path.join(pub, "docs.html")));
app.use("/dashboard", express.static(pub));
app.get("/dashboard", (_req, res) => res.sendFile(path.join(pub, "index.html")));
app.get("/", (_req, res) => res.sendFile(path.join(pub, "connect.html")));

ensureSchema()
  .catch((e) => console.error("[schema] migration failed:", e.message))
  .finally(() => {
    app.listen(config.port, () => {
      console.log(`StockSense server on :${config.port} (${config.appUrl}) · API docs at /docs`);
    });
  });

/* ---------------- scheduled jobs ---------------- */

// Nightly safety-net incremental sync at 01:30 (before the forecast worker at 02:00).
cron.schedule("30 1 * * *", async () => {
  const stores = await query(
    "SELECT id FROM stores WHERE sync_status='ready' AND uninstalled_at IS NULL AND NOT is_demo"
  );
  for (const s of stores) {
    try {
      await incrementalSync(s.id, 3);
    } catch (e: any) {
      console.error(`[cron] incremental sync store ${s.id} failed:`, e.message);
    }
  }
});

// Daily alert digest (the older email summary).
cron.schedule(`0 ${config.alerts.digestHour} * * *`, () => {
  sendDailyAlerts().catch((e) => console.error("[cron] alerts failed:", e.message));
});

/**
 * After every forecast run (the worker stamps stores.forecasted_at): check
 * alerts and refresh the automatic purchase-order drafts.
 */
let checking = false;
cron.schedule("*/20 * * * * *", async () => {
  if (checking) return;
  checking = true;
  try {
    const due = await query(
      `SELECT id FROM stores WHERE uninstalled_at IS NULL AND forecasted_at IS NOT NULL
         AND (alerts_evaluated_at IS NULL OR alerts_evaluated_at < forecasted_at)`
    );
    for (const s of due) {
      try {
        const r = await evaluateAlerts(Number(s.id));
        const d = await refreshAutoDrafts(Number(s.id)).catch((e) => {
          console.error(`[cron] drafts for store ${s.id} failed:`, e.message);
          return null;
        });
        if (r.opened || r.resolved || d?.created || d?.removed) {
          console.log(`[cron] store ${s.id}: alerts +${r.opened}/-${r.resolved}; drafts +${d?.created ?? 0}/~${d?.updated ?? 0}/-${d?.removed ?? 0}`);
        }
      } catch (e: any) {
        console.error(`[cron] alerts for store ${s.id} failed:`, e.message);
      }
    }
  } finally {
    checking = false;
  }
});

// Webhook deliveries that are due (new ones are also sent straight away).
cron.schedule("*/15 * * * * *", () => {
  processDueDeliveries().catch(() => {});
});

// Pro rebuilds forecasts hourly (Scale nightly and Launch weekly run in the worker).
cron.schedule("5 * * * *", async () => {
  await query(
    `INSERT INTO sync_jobs (store_id, job_type, status)
     SELECT id, 'forecast', 'queued' FROM stores
      WHERE plan='pro' AND sync_status='ready' AND uninstalled_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM sync_jobs j WHERE j.store_id = stores.id AND j.job_type='forecast' AND j.status='queued')`
  ).catch((e) => console.error("[cron] hourly rebuild failed:", e.message));
});

// WhatsApp approvals are valid for 30 minutes.
cron.schedule("* * * * *", () => {
  expireWhatsappActions().catch(() => {});
});
