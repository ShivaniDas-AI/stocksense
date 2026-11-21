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
    // read_locations: stock per location; write_inventory: received purchase
    // orders are added to Shopify stock. Existing installs keep their old
    // scopes until the merchant re-approves the app.
    scopes: "read_products,read_orders,read_inventory,read_locations,write_inventory",
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

  // SMS alerts (Settings > Notifications). Empty = SMS reports "not configured".
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    from: process.env.TWILIO_FROM || "",
  },

  // WhatsApp Cloud API (Meta). The assistant and WhatsApp alerts need these.
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    businessNumber: process.env.WHATSAPP_BUSINESS_NUMBER || "", // shown in the link instructions, e.g. +15551234567
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
    appSecret: process.env.WHATSAPP_APP_SECRET || "", // checks X-Hub-Signature-256 on incoming webhooks
    alertTemplate: process.env.WHATSAPP_ALERT_TEMPLATE || "", // approved template for alerts outside the 24h window
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION || "v21.0",
  },

  // Ask StockSense (and AI answers on WhatsApp): Gemini or Claude.
  // AI_PROVIDER=openai|gemini|anthropic picks one when several keys are set.
  aiProvider: (process.env.AI_PROVIDER || "").toLowerCase(),
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "",
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
    model: process.env.GEMINI_MODEL || "",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ASK_MODEL || "",
  },
};
