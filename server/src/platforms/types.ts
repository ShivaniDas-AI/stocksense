/**
 * Platform adapter interface — every store platform (Shopify, BigCommerce,
 * WooCommerce) implements this so the sync layer and API stay platform-agnostic.
 */

export interface PlatformProduct {
  externalId: string;
  title: string;
  imageUrl?: string | null;
  status?: string;
  vendor?: string | null; // brand / maker; suppliers are matched on it
  productType?: string | null; // the product's category
  variants: PlatformVariant[];
}

export interface PlatformLocation {
  externalId: string;
  name: string;
  active: boolean;
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
  locationExternalId?: string | null; // where the order was placed, when the platform says
}

export interface PlatformAdapter {
  platform: "shopify" | "bigcommerce" | "woocommerce";

  /** Fetch all products with variants + current stock. */
  fetchProducts(store: StoreCreds): Promise<PlatformProduct[]>;

  /** Fetch order lines since a date (paid/completed orders only), paginated internally. */
  fetchOrderLines(store: StoreCreds, sinceISO: string): Promise<PlatformOrderLine[]>;

  /** Register webhooks (orders create/update, inventory updates, uninstall). */
  registerWebhooks(store: StoreCreds, baseUrl: string): Promise<void>;

  /** Locations with stock, when the platform reports them. */
  fetchLocations?(store: StoreCreds): Promise<PlatformLocation[]>;

  /** Stock per location for the given variants, keyed by variant external id. */
  fetchInventoryLevels?(store: StoreCreds, variants: { externalId: string; inventoryItemId: string | null }[]):
    Promise<{ variantExternalId: string; locationExternalId: string; onHand: number }[]>;

  /** Add (or remove) units at a location in the platform. Needs write access to inventory. */
  adjustInventory?(store: StoreCreds, inventoryItemId: string, locationExternalId: string, delta: number): Promise<void>;
}

export interface StoreCreds {
  id: number;
  storeDomain: string;
  storeHash?: string | null;
  accessToken: string;
}
