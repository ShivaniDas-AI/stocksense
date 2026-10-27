import axios from "axios";
import {
  PlatformAdapter,
  PlatformOrderLine,
  PlatformProduct,
  StoreCreds,
} from "./types";

/**
 * WooCommerce adapter.
 * Connection model: the merchant supplies their site URL + REST API
 * consumer key/secret (WooCommerce > Settings > Advanced > REST API).
 * We store "key:secret" in access_token and the site URL in store_domain.
 *
 * Webhooks: registered via the Woo REST API; payload signature uses the
 * webhook secret (we reuse the consumer secret).
 */

function creds(store: StoreCreds) {
  const [key, secret] = store.accessToken.split(":");
  return { key, secret };
}

function api(store: StoreCreds) {
  return `https://${store.storeDomain}/wp-json/wc/v3`;
}

async function wooGet(store: StoreCreds, path: string, params?: any): Promise<any> {
  const { key, secret } = creds(store);
  const res = await axios.get(`${api(store)}${path}`, {
    params: { consumer_key: key, consumer_secret: secret, ...params },
  });
  return res;
}

export const woocommerce: PlatformAdapter = {
  platform: "woocommerce",

  async fetchProducts(store: StoreCreds): Promise<PlatformProduct[]> {
    const products: PlatformProduct[] = [];
    let page = 1;
    for (;;) {
      const res = await wooGet(store, "/products", { per_page: 100, page, status: "publish" });
      const items = res.data ?? [];
      for (const p of items) {
        const base: PlatformProduct = {
          externalId: String(p.id),
          title: p.name,
          imageUrl: p.images?.[0]?.src ?? null,
          status: "active",
          variants: [],
        };
        if (p.type === "variable") {
          let vpage = 1;
          for (;;) {
            const vres = await wooGet(store, `/products/${p.id}/variations`, {
              per_page: 100,
              page: vpage,
            });
            const vars = vres.data ?? [];
            for (const v of vars) {
              base.variants.push({
                externalId: String(v.id),
                sku: v.sku || p.sku || null,
                title:
                  `${p.name} - ` +
                  (v.attributes ?? []).map((a: any) => a.option).join(" / "),
                price: parseFloat(v.price) || null,
                currentStock: v.manage_stock ? v.stock_quantity : null,
              });
            }
            if (vars.length < 100) break;
            vpage++;
          }
        } else {
          base.variants.push({
            externalId: String(p.id),
            sku: p.sku || null,
            title: p.name,
            price: parseFloat(p.price) || null,
            currentStock: p.manage_stock ? p.stock_quantity : null,
          });
        }
        products.push(base);
      }
      const totalPages = parseInt(res.headers["x-wp-totalpages"] || "1", 10);
      if (page >= totalPages) break;
      page++;
    }
    return products;
  },

  async fetchOrderLines(store: StoreCreds, sinceISO: string): Promise<PlatformOrderLine[]> {
    const lines: PlatformOrderLine[] = [];
    let page = 1;
    for (;;) {
      const res = await wooGet(store, "/orders", {
        per_page: 100,
        page,
        after: sinceISO,
        status: "completed,processing",
        orderby: "date",
        order: "asc",
      });
      const orders = res.data ?? [];
      for (const o of orders) {
        for (const li of o.line_items ?? []) {
          lines.push({
            externalOrderId: String(o.id),
            variantExternalId: String(li.variation_id || li.product_id),
            quantity: li.quantity,
            lineRevenue: parseFloat(li.total) || 0,
            orderedAt: new Date(o.date_created_gmt + "Z").toISOString(),
          });
        }
      }
      const totalPages = parseInt(res.headers["x-wp-totalpages"] || "1", 10);
      if (page >= totalPages) break;
      page++;
    }
    return lines;
  },

  async registerWebhooks(store: StoreCreds, baseUrl: string): Promise<void> {
    const { key, secret } = creds(store);
    const topics = ["order.created", "order.updated", "product.updated"];
    for (const topic of topics) {
      try {
        await axios.post(
          `${api(store)}/webhooks`,
          {
            name: `StockSense ${topic}`,
            topic,
            delivery_url: `${baseUrl}/webhooks/woocommerce/${store.id}`,
            secret,
          },
          { params: { consumer_key: key, consumer_secret: secret } }
        );
      } catch (e: any) {
        if (e.response?.status !== 400) throw e; // 400 often = duplicate
      }
    }
  },
};
