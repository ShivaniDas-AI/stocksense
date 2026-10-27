import express from "express";
import cookieParser from "cookie-parser";
import cron from "node-cron";
import path from "path";
import { config } from "./config";
import { authRouter } from "./routes/auth";
import { webhooksRouter } from "./routes/webhooks";
import { apiRouter } from "./routes/api";
import { sendDailyAlerts } from "./alerts/email";
import { incrementalSync } from "./sync/sync";
import { query } from "./db";

const app = express();

// Shopify webhooks need the RAW body for HMAC verification — mount raw first.
app.use("/webhooks/shopify", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/webhooks", webhooksRouter);
app.use("/api", apiRouter);

// Dashboard + connect pages (static, no build step).
const pub = path.join(__dirname, "..", "public");
app.use("/dashboard", express.static(pub));
app.get("/dashboard", (_req, res) => res.sendFile(path.join(pub, "index.html")));
app.get("/", (_req, res) => res.sendFile(path.join(pub, "connect.html")));

app.listen(config.port, () => {
  console.log(`StockSense server on :${config.port} (${config.appUrl})`);
});

/* ---------------- scheduled jobs ---------------- */

// Nightly safety-net incremental sync at 01:30 (before the forecast worker at 02:00).
cron.schedule("30 1 * * *", async () => {
  const stores = await query(
    "SELECT id FROM stores WHERE sync_status='ready' AND uninstalled_at IS NULL"
  );
  for (const s of stores) {
    try {
      await incrementalSync(s.id, 3);
    } catch (e: any) {
      console.error(`[cron] incremental sync store ${s.id} failed:`, e.message);
    }
  }
});

// Daily alert digest.
cron.schedule(`0 ${config.alerts.digestHour} * * *`, () => {
  sendDailyAlerts().catch((e) => console.error("[cron] alerts failed:", e.message));
});
