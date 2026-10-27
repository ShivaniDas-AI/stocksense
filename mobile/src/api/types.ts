import type { RiskLevel } from "../theme";

export type Platform = "shopify" | "bigcommerce" | "woocommerce";

export interface StoreInfo {
  id: string;
  platform: Platform;
  store_domain: string;
  currency: string;
  sync_status: "pending" | "syncing" | "ready" | "error" | "uninstalled";
  sync_error: string | null;
}

export interface Summary {
  ready: boolean;
  run_date?: string;
  skus_forecasted?: number;
  skus_tracked?: number;
  untracked?: number;
  at_risk?: number;
  critical?: number;
  low_stock?: number;
  overstocked?: number;
  revenue_at_risk?: number;
  // present while there is no forecast yet
  forecast_job?: "queued" | "running" | "done" | "error" | null;
  forecast_error?: string | null;
  variants_total: number;
  variants_tracked: number;
  has_sales: boolean;
}

/** Row of the risk table. Postgres returns bigint/numeric columns as strings. */
export interface RiskItem {
  variant_id: string;
  sku: string | null;
  title: string;
  image_url: string | null;
  current_stock: number;
  days_of_stock: string | null;
  stockout_date: string | null;
  reorder_point: number | null;
  reorder_qty: number | null;
  revenue_at_risk: string | null;
  risk_level: RiskLevel;
  lead_time_days: number;
  safety_stock: number;
  price: string | null;
  avg_daily_demand: string | null;
  model_used: string | null;
}

export interface RisksResponse {
  run_date?: string;
  items: RiskItem[];
}

export interface VariantDetail {
  variant: {
    id: string;
    sku: string | null;
    title: string | null;
    product_title: string;
    image_url: string | null;
    price: string | null;
    current_stock: number;
    lead_time_days: number;
    safety_stock: number;
    track_inventory: boolean;
  };
  history: { sale_date: string; units_sold: number }[];
  forecast: {
    run_date: string;
    model_used: string;
    daily_forecast: { d: string; y: number }[] | string;
    avg_daily_demand: string;
  } | null;
  risk: {
    current_stock: number;
    days_of_stock: string | null;
    stockout_date: string | null;
    reorder_point: number | null;
    reorder_qty: number | null;
    revenue_at_risk: string | null;
    risk_level: RiskLevel;
  } | null;
}

export interface AlertItem {
  id: string;
  alert_type: string;
  risk_level: RiskLevel;
  sent_at: string;
  acknowledged: boolean;
  title: string;
  sku: string | null;
}

export interface StoresResponse {
  active: number;
  stores: { id: string; platform: Platform; store_domain: string }[];
}

export interface ConnectResponse {
  ok: boolean;
  token?: string;
  store_id?: number;
  error?: string;
}
