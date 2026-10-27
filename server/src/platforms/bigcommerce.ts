import axios from "axios";
import { config } from "../config";
import {
  PlatformAdapter,
  PlatformOrderLine,
  PlatformProduct,
  StoreCreds,
} from "./types";

const V3 = (hash: string) => `https://api.bigcommerce.com/stores/${hash}/v3`;
const V2 = (hash: string) => `https://api.bigcommerce.com/stores/${hash}/v2`;

function headers(token: string) {
  return {
    "X-Auth-Token": token,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** GET with simple 429 retry (BC rate limits). */
async function bcGet(url: string, token: string, params?: any): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await axios.get(url, { headers: headers(token), params });
      return res.data;
    } catch (e: any) {
      if (e.response?.status === 429) {
        const wait = parseInt(e.response.headers["x-rate-limit-time-reset-ms"] || "2000", 10);
        await sleep(wait + 200);
        continue;
      }
      if (e.response?.status === 204) return null;
      throw e;
    }
  }
  throw new Error(`BigCommerce rate limit retries exhausted: ${url}`);
}

export const bigcommerce: PlatformAdapter = {
  platform: "bigcommerce",

  async fetchProducts(store: StoreCreds): Promise<PlatformProduct[]> {
    const hash = store.storeHash!;
    const products: PlatformProduct[] = [];
    let page = 1;
    for (;;) {
      const data = await bcGet(`${V3(hash)}/catalog/products`, store.accessToken, {
        include: "variants,images",
        limit: 250,
        page,
      });
      const items = data?.data ?? [];
      for (const p of items) {
        products.push({
          externalId: String(p.id),
          title: p.name,
          imageUrl: p.images?.[0]?.url_thumbnail ?? null,
          status: p.is_visible ? "active" : "hidden",
          variants: (p.variants ?? []).map((v: any) => ({
            externalId: String(v.id),
            sku: v.sku || p.sku || null,
            title: (v.option_values ?? []).map((o: any) => o.label).join(" / ") || p.name,
            price: v.calculated_price ?? v.price ?? p.price ?? null,
            inventoryItemId: null,
            // "none" = not tracked; "product" = stock held on the product, variants report 0;
            // "variant" = stock held per variant.
            currentStock:
              p.inventory_tracking === "none"
                ? null
                : p.inventory_tracking === "product"
                ? p.inventory_level ?? 0
                : v.inventory_level ?? 0,
          })),
        });
      }
      const totalPages = data?.meta?.pagination?.total_pages ?? page;
      if (page >= totalPages) break;
      page++;
    }
    return products;
  },

  async fetchOrderLines(store: StoreCreds, sinceISO: string): Promise<PlatformOrderLine[]> {
    const hash = store.storeHash!;
    const lines: PlatformOrderLine[] = [];
    let page = 1;
    for (;;) {
      // V2 orders API; completed-ish statuses only.
      const orders = await bcGet(`${V2(hash)}/orders`, store.accessToken, {
        min_date_created: sinceISO,
        limit: 250,
        page,
        sort: "date_created:asc",
      });
      if (!orders || orders.length === 0) break;
      for (const o of orders) {
        // Skip cancelled/refunded/declined.
        const bad = ["Cancelled", "Refunded", "Declined", "Disputed"];
        if (bad.includes(o.status)) continue;
        const prods = await bcGet(`${V2(hash)}/orders/${o.id}/products`, store.accessToken);
        for (const lp of prods ?? []) {
          lines.push({
            externalOrderId: String(o.id),
            variantExternalId: String(lp.variant_id || lp.product_id),
            quantity: lp.quantity,
            lineRevenue: parseFloat(lp.total_inc_tax ?? lp.price_inc_tax ?? "0") || 0,
            orderedAt: new Date(o.date_created).toISOString(),
          });
        }
      }
      if (orders.length < 250) break;
      page++;
    }
    return lines;
  },

  async registerWebhooks(store: StoreCreds, baseUrl: string): Promise<void> {
    const hash = store.storeHash!;
    const scopes = [
      "store/order/created",
      "store/order/statusUpdated",
      "store/product/inventory/updated",
      "store/product/updated",
      "store/app/uninstalled",
    ];
    for (const scope of scopes) {
      try {
        await axios.post(
          `${V3(hash)}/hooks`,
          {
            scope,
            destination: `${baseUrl}/webhooks/bigcommerce/${store.id}`,
            is_active: true,
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

/** OAuth: exchange the ?code from BC install callback for a permanent token. */
export async function bcExchangeCode(code: string, scope: string, context: string) {
  const res = await axios.post("https://login.bigcommerce.com/oauth2/token", {
    client_id: config.bigcommerce.clientId,
    client_secret: config.bigcommerce.clientSecret,
    code,
    scope,
    context, // "stores/{hash}"
    grant_type: "authorization_code",
    redirect_uri: `${config.appUrl}/auth/bigcommerce/callback`,
  });
  return res.data as { access_token: string; context: string; user: { email: string } };
}
