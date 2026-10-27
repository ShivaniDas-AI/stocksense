import dotenv from "dotenv";
dotenv.config();

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  appUrl: req("APP_URL", "http://localhost:3000"), // public URL (ngrok in dev)
  databaseUrl: req("DATABASE_URL"),
  sessionSecret: req("SESSION_SECRET", "dev-secret-change-me"),

  bigcommerce: {
    clientId: process.env.BC_CLIENT_ID || "",
    clientSecret: process.env.BC_CLIENT_SECRET || "",
  },
  shopify: {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    apiSecret: process.env.SHOPIFY_API_SECRET || "",
    scopes: "read_products,read_orders,read_inventory",
    apiVersion: "2025-07",
  },

  alerts: {
    resendApiKey: process.env.RESEND_API_KEY || "",
    fromEmail: process.env.ALERT_FROM_EMAIL || "alerts@stocksense.app",
    // Daily digest hour (server local time, 24h)
    digestHour: parseInt(process.env.ALERT_DIGEST_HOUR || "8", 10),
  },

  // How many months of order history to backfill on install
  backfillMonths: parseInt(process.env.BACKFILL_MONTHS || "18", 10),
};
