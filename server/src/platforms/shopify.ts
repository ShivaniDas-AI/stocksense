import axios from "axios";
import crypto from "crypto";
import { config } from "../config";
import {
  PlatformAdapter,
  PlatformOrderLine,
  PlatformProduct,
  StoreCreds,
} from "./types";

const API = (shop: string) => `https://${shop}/admin/api/${config.shopify.apiVersion}`;

function headers(token: string) {
  return { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** GET with Link-header pagination + 429 retry. Returns [data, nextPageUrl]. */
async function shopifyGet(url: string, token: string, params?: any): Promise<[any, string | null]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await axios.get(url, { headers: headers(token), params });
      const link: string = res.headers["link"] || "";
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      return [res.data, m ? m[1] : null];
    } catch (e: any) {
      if (e.response?.status === 429) {
        const wait = parseFloat(e.response.headers["retry-after"] || "2") * 1000;
        await sleep(wait + 200);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Shopify rate limit retries exhausted: ${url}`);
}

export const shopify: PlatformAdapter = {
  platform: "shopify",

  async fetchProducts(store: StoreCreds): Promise<PlatformProduct[]> {
    const products: PlatformProduct[] = [];
    let url: string | null = `${API(store.storeDomain)}/products.json`;
    let params: any = { limit: 250 };
    while (url) {
      const [data, next] = await shopifyGet(url, store.accessToken, params);
      params = undefined; // next-page URLs already carry query params
      for (const p of data.products ?? []) {
        products.push({
          externalId: String(p.id),
          title: p.title,
          imageUrl: p.image?.src ?? null,
          status: p.status,
          variants: (p.variants ?? []).map((v: any) => ({
            externalId: String(v.id),
            sku: v.sku || null,
            title: v.title === "Default Title" ? p.title : `${p.title} - ${v.title}`,
            price: parseFloat(v.price) || null,
            inventoryItemId: String(v.inventory_item_id),
            // Products whose inventory Shopify does not track report a meaningless
            // quantity (often negative); null marks them as untracked so they are skipped.
            currentStock:
              v.inventory_management !== undefined && v.inventory_management !== "shopify"
                ? null
                : v.inventory_quantity ?? null,
          })),
        });
      }
      url = next;
    }
    return products;
  },

  async fetchOrderLines(store: StoreCreds, sinceISO: string): Promise<PlatformOrderLine[]> {
    const lines: PlatformOrderLine[] = [];
    let url: string | null = `${API(store.storeDomain)}/orders.json`;
    let params: any = {
      limit: 250,
      status: "any",
      financial_status: "paid",
      created_at_min: sinceISO,
      fields: "id,created_at,cancelled_at,line_items",
    };
    while (url) {
      const [data, next] = await shopifyGet(url, store.accessToken, params);
      params = undefined;
      for (const o of data.orders ?? []) {
        if (o.cancelled_at) continue;
        for (const li of o.line_items ?? []) {
          if (!li.variant_id) continue;
          lines.push({
            externalOrderId: String(o.id),
            variantExternalId: String(li.variant_id),
            quantity: li.quantity,
            lineRevenue: parseFloat(li.price) * li.quantity || 0,
            orderedAt: new Date(o.created_at).toISOString(),
          });
        }
      }
      url = next;
    }
    return lines;
  },

  async registerWebhooks(store: StoreCreds, baseUrl: string): Promise<void> {
    const topics = ["orders/create", "inventory_levels/update", "products/update", "app/uninstalled"];
    for (const topic of topics) {
      try {
        await axios.post(
          `${API(store.storeDomain)}/webhooks.json`,
          {
            webhook: {
              topic,
              address: `${baseUrl}/webhooks/shopify/${store.id}`,
              format: "json",
            },
          },
          { headers: headers(store.accessToken) }
        );
      } catch (e: any) {
        // 422 = already exists; ignore.
        if (e.response?.status !== 422) throw e;
      }
    }
  },
};

/** OAuth helpers */
export function shopifyAuthUrl(shop: string, state: string): string {
  const p = new URLSearchParams({
    client_id: config.shopify.apiKey,
    scope: config.shopify.scopes,
    redirect_uri: `${config.appUrl}/auth/shopify/callback`,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${p.toString()}`;
}

export async function shopifyExchangeCode(shop: string, code: string): Promise<string> {
  const res = await axios.post(`https://${shop}/admin/oauth/access_token`, {
    client_id: config.shopify.apiKey,
    client_secret: config.shopify.apiSecret,
    code,
  });
  return res.data.access_token;
}

/** Verify HMAC on OAuth callback query params. */
export function verifyShopifyHmac(queryParams: Record<string, any>): boolean {
  const { hmac, ...rest } = queryParams;
  if (!hmac) return false;
  const msg = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
  const digest = crypto
    .createHmac("sha256", config.shopify.apiSecret)
    .update(msg)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(hmac)));
}

/** Verify HMAC on webhook body (raw). */
export function verifyShopifyWebhook(rawBody: Buffer, hmacHeader: string): boolean {
  const digest = crypto
    .createHmac("sha256", config.shopify.apiSecret)
    .update(rawBody)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}
