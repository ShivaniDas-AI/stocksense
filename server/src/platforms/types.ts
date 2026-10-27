/**
 * Platform adapter interface — every store platform (Shopify, BigCommerce,
 * WooCommerce) implements this so the sync layer and API stay platform-agnostic.
 */

export interface PlatformProduct {
  externalId: string;
  title: string;
  imageUrl?: string | null;
  status?: string;
  variants: PlatformVariant[];
}

export interface PlatformVariant {
  externalId: string;
  sku?: string | null;
  title?: string | null;
  price?: number | null;
  inventoryItemId?: string | null;
  currentStock?: number | null;
}

export interface PlatformOrderLine {
  externalOrderId: string;
  variantExternalId: string;
  quantity: number;
  lineRevenue: number;
  orderedAt: string; // ISO timestamp
}

export interface PlatformAdapter {
  platform: "shopify" | "bigcommerce" | "woocommerce";

  /** Fetch all products with variants + current stock. */
  fetchProducts(store: StoreCreds): Promise<PlatformProduct[]>;

  /** Fetch order lines since a date (paid/completed orders only), paginated internally. */
  fetchOrderLines(store: StoreCreds, sinceISO: string): Promise<PlatformOrderLine[]>;

  /** Register webhooks (orders create/update, inventory updates, uninstall). */
  registerWebhooks(store: StoreCreds, baseUrl: string): Promise<void>;
}

export interface StoreCreds {
  id: number;
  storeDomain: string;
  storeHash?: string | null;
  accessToken: string;
}
