import { Router } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import axios from "axios";
import { config } from "../config";
import { upsertStore } from "../db";
import { bcExchangeCode } from "../platforms/bigcommerce";
import {
  shopifyAuthUrl,
  shopifyExchangeCode,
  verifyShopifyHmac,
} from "../platforms/shopify";
import { startInitialSync } from "../sync/sync";

export const authRouter = Router();

/**
 * Session cookie: signed JWT holding the active store and every store this
 * browser/device has connected, so the user can switch between them.
 */
interface Session {
  storeId: number;
  stores: number[];
}

export function getSession(req: any): Session | null {
  const token = req.cookies?.ss_session;
  if (!token) return null;
  try {
    const p = jwt.verify(token, config.sessionSecret) as any;
    const stores: number[] = Array.isArray(p.stores) ? p.stores : [p.storeId];
    return { storeId: p.storeId, stores };
  } catch {
    return null;
  }
}

function writeSession(res: any, session: Session) {
  const token = jwt.sign(session, config.sessionSecret, { expiresIn: "30d" });
  res.cookie("ss_session", token, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    maxAge: 30 * 24 * 3600 * 1000,
  });
}

/** Make storeId the active store and remember it alongside earlier ones. */
export function setSession(req: any, res: any, storeId: number) {
  const prev = getSession(req);
  const stores = Array.from(new Set([...(prev?.stores ?? []), storeId]));
  writeSession(res, { storeId, stores });
}

export function getSessionStoreId(req: any): number | null {
  return getSession(req)?.storeId ?? null;
}

/* ---------------- Session: list / switch / logout ---------------- */

// GET /auth/stores - stores this device has connected, with the active one flagged.
authRouter.get("/stores", async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "Not authenticated" });
  const { query } = await import("../db");
  const rows = await query(
    `SELECT id, platform, store_domain FROM stores
     WHERE id = ANY($1) AND uninstalled_at IS NULL ORDER BY id`,
    [s.stores]
  );
  res.json({ active: s.storeId, stores: rows });
});

// POST /auth/switch { store_id } - only to a store already in this session.
authRouter.post("/switch", (req, res) => {
  const s = getSession(req);
  const target = parseInt(String(req.body?.store_id), 10);
  if (!s || !s.stores.includes(target)) {
    return res.status(403).json({ error: "Store not available on this device" });
  }
  writeSession(res, { storeId: target, stores: s.stores });
  res.json({ ok: true });
});

// GET /auth/logout - forget all stores on this device.
authRouter.get("/logout", (_req, res) => {
  res.clearCookie("ss_session", { httpOnly: true, sameSite: "none", secure: true });
  res.redirect("/");
});

/* ---------------- BigCommerce ---------------- */

// Install callback: BC redirects here with ?code&scope&context
authRouter.get("/bigcommerce/callback", async (req, res) => {
  try {
    const { code, scope, context } = req.query as Record<string, string>;
    const data = await bcExchangeCode(code, scope, context);
    const storeHash = data.context.replace("stores/", "");
    const store = await upsertStore({
      platform: "bigcommerce",
      store_domain: storeHash, // BC has no stable domain; use hash
      store_hash: storeHash,
      access_token: data.access_token,
    });
    setSession(req, res, store.id);
    startInitialSync(store.id); // fire and forget
    res.redirect("/dashboard");
  } catch (e: any) {
    console.error("BC install failed:", e.response?.data || e.message);
    res.status(500).send("BigCommerce install failed");
  }
});

// Load callback: BC iframes this when merchant opens the app (signed_payload_jwt)
authRouter.get("/bigcommerce/load", async (req, res) => {
  try {
    const signed = String(req.query.signed_payload_jwt || "");
    const payload = jwt.verify(signed, config.bigcommerce.clientSecret, {
      algorithms: ["HS256"],
      audience: config.bigcommerce.clientId,
    }) as any;
    const storeHash = String(payload.sub).replace("stores/", "");
    const { queryOne } = await import("../db");
    const store = await queryOne(
      "SELECT id FROM stores WHERE platform='bigcommerce' AND store_hash=$1 AND uninstalled_at IS NULL",
      [storeHash]
    );
    if (!store) return res.status(404).send("Store not installed");
    setSession(req, res, store.id);
    res.redirect("/dashboard");
  } catch (e: any) {
    console.error("BC load failed:", e.message);
    res.status(401).send("Invalid load request");
  }
});

// Store-level API account (control panel > Settings > API > Store-level API accounts):
// no OAuth, the merchant pastes the store hash and access token.
authRouter.post("/bigcommerce/token-connect", async (req, res) => {
  try {
    const storeHash = String(req.body?.store_hash || "").trim().toLowerCase();
    const token = String(req.body?.access_token || "").trim();
    if (!/^[a-z0-9]+$/.test(storeHash)) {
      return res.status(400).json({ error: "Enter the store hash (the part after /stores/ in the API path)" });
    }
    if (!token) return res.status(400).json({ error: "Access token required" });

    // Validate the token and its Products + Orders read access before saving.
    const headers = { "X-Auth-Token": token, Accept: "application/json" };
    try {
      await axios.get(`https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products`, {
        headers,
        params: { limit: 1 },
      });
      await axios.get(`https://api.bigcommerce.com/stores/${storeHash}/v2/orders`, {
        headers,
        params: { limit: 1 },
      });
    } catch (e: any) {
      const status = e.response?.status;
      return res.status(400).json({
        error:
          status === 401
            ? "BigCommerce rejected the token. Check the store hash and access token."
            : status === 403
            ? "Token is missing a scope. The API account needs Products and Orders set to read-only (or higher)."
            : `Could not reach BigCommerce (status ${status ?? "network error"}).`,
      });
    }

    const store = await upsertStore({
      platform: "bigcommerce",
      store_domain: storeHash,
      store_hash: storeHash,
      access_token: token,
    });
    setSession(req, res, store.id);
    startInitialSync(store.id);
    res.json({ ok: true, redirect: "/dashboard" });
  } catch (e: any) {
    console.error("BigCommerce token connect failed:", e.message);
    res.status(500).json({ error: "BigCommerce connect failed" });
  }
});

/* ---------------- Shopify ---------------- */

// Start: /auth/shopify?shop=my-shop.myshopify.com
authRouter.get("/shopify", (req, res) => {
  const shop = String(req.query.shop || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
    return res.status(400).send("Invalid shop parameter");
  }
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("ss_state", state, { httpOnly: true, sameSite: "lax", secure: true });
  res.redirect(shopifyAuthUrl(shop, state));
});

authRouter.get("/shopify/callback", async (req, res) => {
  try {
    const q = req.query as Record<string, string>;
    if (q.state !== req.cookies?.ss_state) return res.status(401).send("State mismatch");
    if (!verifyShopifyHmac(q)) return res.status(401).send("HMAC verification failed");
    const token = await shopifyExchangeCode(q.shop, q.code);
    const store = await upsertStore({
      platform: "shopify",
      store_domain: q.shop,
      access_token: token,
    });
    setSession(req, res, store.id);
    startInitialSync(store.id);
    res.redirect("/dashboard");
  } catch (e: any) {
    console.error("Shopify install failed:", e.response?.data || e.message);
    res.status(500).send("Shopify install failed");
  }
});

// Custom app created in the store admin (Settings > Apps > Develop apps):
// no OAuth, the merchant pastes the Admin API access token (shpat_...).
authRouter.post("/shopify/token-connect", async (req, res) => {
  try {
    const shop = String(req.body?.shop || "").trim().toLowerCase();
    const token = String(req.body?.access_token || "").trim();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
      return res.status(400).json({ error: "Enter the store as your-store.myshopify.com" });
    }
    if (!token) return res.status(400).json({ error: "Admin API access token required" });

    // Validate the token before saving it.
    try {
      await axios.get(`https://${shop}/admin/api/${config.shopify.apiVersion}/shop.json`, {
        headers: { "X-Shopify-Access-Token": token },
      });
    } catch (e: any) {
      const status = e.response?.status;
      return res.status(400).json({
        error:
          status === 401 || status === 403
            ? "Shopify rejected the token. Check it is the Admin API access token (shpat_...) and the app is installed."
            : `Could not reach ${shop} (status ${status ?? "network error"}).`,
      });
    }

    const store = await upsertStore({ platform: "shopify", store_domain: shop, access_token: token });
    setSession(req, res, store.id);
    startInitialSync(store.id);
    res.json({ ok: true, redirect: "/dashboard" });
  } catch (e: any) {
    console.error("Shopify token connect failed:", e.message);
    res.status(500).json({ error: "Shopify connect failed" });
  }
});

/* ---------------- WooCommerce ---------------- */

// Manual connect: merchant posts site URL + consumer key/secret from a connect form.
authRouter.post("/woocommerce/connect", async (req, res) => {
  try {
    const { site, consumer_key, consumer_secret } = req.body as Record<string, string>;
    if (!site || !consumer_key || !consumer_secret) {
      return res.status(400).json({ error: "site, consumer_key, consumer_secret required" });
    }
    const domain = site.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const store = await upsertStore({
      platform: "woocommerce",
      store_domain: domain,
      access_token: `${consumer_key}:${consumer_secret}`,
    });
    setSession(req, res, store.id);
    startInitialSync(store.id);
    res.json({ ok: true, redirect: "/dashboard" });
  } catch (e: any) {
    console.error("Woo connect failed:", e.message);
    res.status(500).json({ error: "WooCommerce connect failed" });
  }
});
