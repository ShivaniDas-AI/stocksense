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

export interface Kpis {
  healthy_pct: number | null;
  units_on_hand: number;
  inventory_value: number;
  reorder_units: number;
  reorder_value: number;
  overstock_units: number;
  overstock_value: number;
  median_cover_days: number | null;
  next_stockout_date: string | null;
  next_stockout_title: string | null;
  sales_30d: { units: number; revenue: number };
  sales_prev_30d: { units: number; revenue: number };
  forecast_30d: { units: number; revenue: number };
  sell_through_30d: number | null;
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
  healthy?: number;
  overstocked?: number;
  no_demand?: number;
  revenue_at_risk?: number;
  kpis?: Kpis;
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

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export interface CreatedApiKey extends ApiKey {
  key: string; // full secret, returned only at creation
}

export interface ConnectResponse {
  ok: boolean;
  token?: string;
  store_id?: number;
  error?: string;
}

/* ---------- /api/v1 shapes used by the charts ---------- */

export interface WeekPoint { week_start: string; units: number; forecast: boolean }

export interface DashboardV1 {
  ready: boolean;
  run_date: string | null;
  cards?: {
    skus_tracked: { value: number; critical: number };
    need_reordering: { value: number; draft_purchase_orders: number };
    cash_in_overstock: { value: number; units: number; overstock_days: number; basis: string };
    forecast_accuracy: { value: number | null; change_this_month: number | null; unit: string };
    revenue_protected: { value: number; alerts: number; period_days: number };
  };
  units_sold_vs_forecast?: WeekPoint[];
  running_low?: { variant_id: number; title: string; sku: string | null; cover_days: number | null; runs_out_on: string | null; status: string }[];
}

export interface ForecastDetailV1 {
  variant_id: number;
  sku: string | null;
  title: string;
  product_title: string | null;
  vendor: string | null;
  category: string | null;
  image_url: string | null;
  price: number | null;
  run_date: string | null;
  model: string | null;
  status: string;
  confidence: string | null;
  accuracy: number | null;
  summary: string;
  numbers: {
    on_hand: number;
    on_order: number;
    in_draft: number;
    rate_per_day: number | null;
    forecast_per_day: number;
    cover_days: number | null;
    runs_out_on: string | null;
    reorder_point: number | null;
    safety_stock: number | null;
    suggested_quantity: number;
    revenue_at_risk: number | null;
    lead_time_days: number;
    order_today_lands_on: string | null;
  };
  ordering: {
    supplier: { id: number; name: string } | null;
    supplier_source?: string | null;
    case_pack: number | null;
    min_order_qty: number | null;
    lead_time_override_days?: number | null;
    lead_time_source?: string | null;
    unit_cost?: number | null;
    min_safety_stock?: number | null;
  };
  stock_curve: {
    history: { date: string; stock: number; sold: number }[];
    forecast: { date: string; stock: number; low: number; high: number }[];
    markers: { today: string; order_today_lands: string | null; reorder_point: number | null };
  } | null;
  weekly_demand: WeekPoint[];
}

/* ---------- WhatsApp ---------- */

export type WhatsAppRole = "can_approve" | "view_only";

export interface WhatsAppNumber { id: number; phone: string; role: WhatsAppRole; connected_at: string; last_message_at: string | null }

export interface WhatsAppStatus {
  enabled: boolean;
  provider: string;
  business_number: string | null;
  ai_answers: boolean;
  note: string | null;
  link_code: { code: string; message: string; expires_at: string } | null;
  connected_numbers: WhatsAppNumber[];
}

export interface WhatsAppLinkCode { code: string; message: string; expires_at: string; send_to: string | null; open_whatsapp_url: string | null }

export interface WhatsAppActivity {
  id: number;
  title: string;
  source: "menu" | "ai";
  summary: string;
  phone: string;
  status: "pending" | "approved" | "done" | "failed" | "cancelled" | "expired" | string;
  result: string | Record<string, unknown> | null;
  created_at: string;
  decided_at: string | null;
}

export type BotMessage =
  | { type: "text"; text: string }
  | { type: "buttons"; text: string; header?: string; footer?: string; buttons: { id: string; title: string }[] }
  | { type: "list"; text: string; header?: string; footer?: string; button: string; sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[] }
  | { type: "image"; url: string; caption?: string };

/* ---------- /api/v1: lists, summary, store ---------- */

export interface Page<T> { data: T[]; page: number; limit: number; total: number; has_more: boolean }

export interface StoreV1 {
  id: number;
  name: string | null;
  platform: Platform;
  domain: string;
  currency: string;
  sync_status: StoreInfo["sync_status"];
  sync_error: string | null;
  plan: "launch" | "scale" | "pro";
  demo: boolean;
}

export interface SummaryV1 {
  ready: boolean;
  run_date: string | null;
  counts?: Record<string, number>;
  revenue_at_risk?: number;
  kpis?: Kpis;
}

export interface ForecastRow {
  variant_id: number;
  sku: string | null;
  title: string;
  vendor: string | null;
  category: string | null;
  image_url: string | null;
  supplier: { id: number; name: string } | null;
  status: string;
  on_hand: number;
  on_order: number;
  rate_per_day: number | null;
  forecast_per_day: number | null;
  cover_days: number | null;
  runs_out_on: string | null;
  reorder_point: number | null;
  suggested_quantity: number | null;
  revenue_at_risk: number | null;
  lead_time_days: number | null;
  safety_stock: number | null;
  confidence: string | null;
  model: string | null;
  price: number | null;
  unit_cost: number | null;
}

export interface ForecastList extends Page<ForecastRow> {
  run_date: string | null;
  counts?: Record<string, number>;
}

export interface PlanV1 {
  plan: string;
  name: string;
  price: number;
  trial_ends_at: string | null;
  limits: { skus: number | null; locations: number | null; ask_questions_per_month: number | null; forecast_rebuild: string };
  usage: { skus: number; locations: number; ask_questions_this_month: number };
  features: string[];
}

/* ---------- alerts ---------- */

export interface AlertV1 {
  id: number;
  type: "stockout_risk" | "reorder_point" | "velocity_shift" | "lead_time_drift" | "overstock" | string;
  status: "open" | "dismissed" | "resolved";
  urgent: boolean;
  title: string;
  message: string;
  what_to_do: string | null;
  revenue_at_risk: number | null;
  product: { variant_id: number; title: string; sku: string | null } | null;
  supplier: { id: number; name: string } | null;
  opened_at: string;
  updated_at: string;
  dismissed_at: string | null;
  resolved_at: string | null;
  resolved_by_purchase_order: { id: number; number: string } | null;
}

/* ---------- purchase orders, suppliers, reorder ---------- */

export type PoStatus = "draft" | "approved" | "sent" | "partial" | "received" | "cancelled";

export interface PurchaseOrder {
  id: number;
  number: string;
  status: PoStatus | string;
  automatic: boolean;
  supplier: { id: number; name: string; email: string | null } | null;
  location: { id: number; name: string } | null;
  expected_at: string | null;
  notes: string | null;
  currency: string;
  lines: { variant_id: number; title: string; sku: string | null; quantity: number; received_quantity: number; unit_cost: number | null; line_total: number | null }[];
  line_count: number;
  units: number;
  total: number;
  warnings: Warning[];
  created_at: string;
  approved_at: string | null;
  sent_at: string | null;
  emailed_at: string | null;
  received_at: string | null;
  cancelled_at: string | null;
}

export interface Supplier {
  id: number;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  lead_time_days: number;
  lead_time_effective_days: number | null;
  lead_time_latest_days: number | null;
  lead_time_trend: "faster" | "slower" | "steady" | string | null;
  deliveries_90d: number;
  min_order_value: number | null;
  currency: string;
  payment_terms: string | null;
  vendors: string[];
  categories: string[];
  product_count: number;
  scorecard: { on_time_rate: number | null; fill_rate: number | null; open_order_value: number } | null;
}

export interface ReorderPlan {
  variant_id: number;
  title: string;
  sku: string | null;
  status: string;
  confidence: string | null;
  top: { on_hand: number; on_order: number; forecast_per_day: number; runs_out_on: string | null; arrives_on: string | null; suggested_quantity: number };
  supplier_id: number | null;
  suppliers: { supplier_id: number; name: string; lead_time_days: number; lead_time_basis: string; arrives_on: string; quantity: number; unit_cost: number | null; min_order_value: number | null; tags: string[]; selected: boolean }[];
  inputs: { coverage_days: number; lead_time_days: number; lead_time_is_override: boolean; case_pack: number; min_order_qty: number };
  quantity: {
    sold_during_lead_time: number; lead_time_days: number; forecast_per_day: number; sold_during_coverage: number; coverage_days: number;
    safety_stock: number; safety_stock_basis: string; service_level: number; stock_to_have: number; on_hand: number; on_order: number;
    short_by: number; raised_to_minimum: number | null; rounded_to_case_pack: number | null; case_pack: number; min_order_qty: number;
  };
  suggested_quantity: number;
  reorder_point: number;
  effect: { date: string; without_order: number; with_order: number; safety_stock: number }[];
  warnings?: Warning[];
}

/* ---------- Ask StockSense ---------- */

export interface AskChart {
  type: "line" | "bar";
  title: string;
  series: { name: string; style?: string; points: { x: string; y: number }[] }[];
  markers?: unknown[];
}
export interface AskAnswer { conversation_id: number; answer: string; charts?: AskChart[] }
export interface AskUsage { plan: string; questions_this_month: number; monthly_limit: number | null; remaining: number | null; resets_on: string; configured: boolean; provider?: "openai" | "gemini" | "anthropic" | null; model?: string | null; key_problem?: string | null }
export interface AskConversation { id: number; title: string; messages: number; updated_at: string }

/* ---------- key number details (/api/v1/kpis/{metric}) ---------- */

export type KpiMetric = "sales" | "forecast" | "accuracy" | "cover" | "overstock" | "protected" | "at_risk";
export type KpiUnit = "money" | "units" | "percent" | "days" | "count" | "text" | "date";
export interface KpiDetail {
  metric: KpiMetric;
  title: string;
  summary: string;
  currency: string;
  run_date: string | null;
  headline: { label: string; value: number | null; unit: KpiUnit; sub?: string; change_pct?: number | null }[];
  charts: { type: "line" | "bar" | "hbar"; title: string; caption?: string; unit: KpiUnit; series: { name: string; style?: string; points: { x: string; y: number }[] }[] }[];
  tables: { title: string; caption?: string; columns: { key: string; label: string; unit?: KpiUnit }[]; rows: Record<string, any>[] }[];
}

/** Server warnings arrive as {code, message}; older ones as plain text. */
export type Warning = string | { code?: string; message?: string };
export const warningText = (w: Warning): string => (typeof w === "string" ? w : w?.message ?? w?.code ?? "");
