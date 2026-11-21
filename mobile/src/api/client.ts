import type {
  AlertItem,
  ApiKey,
  CreatedApiKey,
  ConnectResponse,
  RisksResponse,
  StoreInfo,
  StoresResponse,
  Summary,
  VariantDetail,
  DashboardV1,
  ForecastDetailV1,
  WhatsAppStatus,
  WhatsAppLinkCode,
  WhatsAppRole,
  WhatsAppActivity,
  BotMessage,
  StoreV1,
  SummaryV1,
  ForecastList,
  PlanV1,
  AlertV1,
  Page,
  PurchaseOrder,
  Supplier,
  ReorderPlan,
  AskAnswer,
  AskUsage,
  KpiDetail,
  KpiMetric,
} from "./types";

/**
 * Thin fetch wrapper around the StockSense REST API.
 * Auth is a bearer JWT issued by the connect endpoints (the same token the
 * web dashboard keeps in its cookie).
 */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let baseUrl = "";
let token: string | null = null;

export function configureApi(opts: { baseUrl?: string; token?: string | null }) {
  if (opts.baseUrl !== undefined) baseUrl = opts.baseUrl.replace(/\/+$/, "");
  if (opts.token !== undefined) token = opts.token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  // ngrok's free tier shows an HTML warning page to clients without this.
  if (/ngrok/i.test(baseUrl)) headers["ngrok-skip-browser-warning"] = "true";
  if (init.body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  } catch (e: any) {
    throw new ApiError(0, `Cannot reach the server at ${baseUrl}. Is Docker and ngrok running?`);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, `Unexpected response from server (${res.status}).`);
  }
  if (!res.ok) {
    // /api routes send {error: "text"}; /api/v1 sends {error: {message, code}}.
    const msg = typeof data?.error === "string" ? data.error : data?.error?.message;
    throw new ApiError(res.status, msg || `Request failed (${res.status})`);
  }
  return data as T;
}

/** /api/v1 calls wrap the payload in {data}. */
async function v1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await request<{ data: T }>(`/api/v1${path}`, init);
  return r.data;
}
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body ?? {}) });

/* ---------- store + dashboard ---------- */

export const api = {
  store: () => request<StoreInfo>("/api/store"),
  summary: () => request<Summary>("/api/summary"),
  risks: (level: string, q: string) =>
    request<RisksResponse>(`/api/risks?level=${encodeURIComponent(level)}&q=${encodeURIComponent(q)}`),
  variant: (id: string) => request<VariantDetail>(`/api/variants/${id}`),
  updateVariant: (id: string, body: { lead_time_days: number; safety_stock: number }) =>
    request<{ ok: boolean }>(`/api/variants/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  alerts: () => request<{ items: AlertItem[] }>("/api/alerts"),
  ackAlert: (id: string) => request<{ ok: boolean }>(`/api/alerts/${id}/ack`, { method: "POST" }),

  /* ---------- session ---------- */
  stores: () => request<StoresResponse>("/auth/stores"),
  switchStore: (storeId: string) =>
    request<{ ok: boolean; token: string }>("/auth/switch", {
      method: "POST",
      body: JSON.stringify({ store_id: Number(storeId) }),
    }),

  /* ---------- connect (each returns a bearer token) ---------- */
  connectShopify: (shop: string, accessToken: string) =>
    request<ConnectResponse>("/auth/shopify/token-connect", {
      method: "POST",
      body: JSON.stringify({ shop, access_token: accessToken }),
    }),
  connectBigCommerce: (storeHash: string, accessToken: string) =>
    request<ConnectResponse>("/auth/bigcommerce/token-connect", {
      method: "POST",
      body: JSON.stringify({ store_hash: storeHash, access_token: accessToken }),
    }),
  connectWoo: (site: string, consumerKey: string, consumerSecret: string) =>
    request<ConnectResponse>("/auth/woocommerce/connect", {
      method: "POST",
      body: JSON.stringify({ site, consumer_key: consumerKey, consumer_secret: consumerSecret }),
    }),
  health: () => request<{ ok: boolean }>("/health"),

  /* ---------- public API keys ---------- */
  apiKeys: () => request<{ items: ApiKey[] }>("/api/keys"),
  createApiKey: (name: string) =>
    request<CreatedApiKey>("/api/keys", { method: "POST", body: JSON.stringify({ name }) }),
  revokeApiKey: (id: number) => request<{ ok: boolean }>(`/api/keys/${id}`, { method: "DELETE" }),

  /* ---------- charts (public API, same session) ---------- */
  dashboardV1: () => v1<DashboardV1>("/dashboard"),
  kpi: (metric: KpiMetric) => v1<KpiDetail>(`/kpis/${metric}`),
  forecastV1: (variantId: string) => v1<ForecastDetailV1>(`/forecasts/${variantId}`),

  /* ---------- WhatsApp assistant ---------- */
  whatsapp: () => v1<WhatsAppStatus>("/whatsapp"),
  whatsappLinkCode: () => v1<WhatsAppLinkCode>("/whatsapp/link-codes", post({})),
  whatsappSetRole: (id: number, role: WhatsAppRole) =>
    v1<{ id: number; role: WhatsAppRole }>(`/whatsapp/numbers/${id}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  whatsappDisconnect: (id: number) => v1<{ id: number }>(`/whatsapp/numbers/${id}`, { method: "DELETE" }),
  whatsappActivity: () => v1<WhatsAppActivity[]>("/whatsapp/activity?limit=30"),
  whatsappSimulate: (from: string, msg: { text?: string; reply_id?: string }) =>
    v1<{ replies: BotMessage[] }>("/whatsapp/simulate", post({ from, ...msg })),

  /* ---------- /api/v1: store, summary, forecasts ---------- */
  storeV1: () => v1<StoreV1>("/store"),
  summaryV1: () => v1<SummaryV1>("/summary"),
  plan: () => v1<PlanV1>("/plan"),
  forecasts: (p: { status?: string; q?: string; sort?: string; limit?: number }) =>
    request<ForecastList>(`/api/v1/forecasts${qs({ limit: 250, ...p })}`),
  forecastSettings: (variantId: string | number, body: { lead_time_days?: number | null; min_safety_stock?: number; case_pack?: number; min_order_qty?: number; unit_cost?: number | null }) =>
    v1<unknown>(`/forecasts/${variantId}/settings`, { method: "PATCH", body: JSON.stringify(body) }),
  rebuild: () => v1<{ job_id?: number }>("/forecasts/rebuild", post({})),

  /* ---------- alerts ---------- */
  alertsV1: (status: string) => request<Page<AlertV1>>(`/api/v1/alerts${qs({ status, limit: 100 })}`),
  alertAction: (id: number, action: "dismiss" | "reopen") => v1<AlertV1>(`/alerts/${id}`, post({ action })),
  checkAlerts: () => v1<unknown>("/alerts/check", post({})),

  /* ---------- reorder + purchase orders + suppliers ---------- */
  reorderPlan: (variantId: string | number, p: { supplier_id?: number; coverage_days?: number } = {}) =>
    v1<ReorderPlan>(`/reorder/${variantId}${qs(p)}`),
  createOrderFromReorder: (variantId: string | number, body: { supplier_id?: number; quantity?: number; coverage_days?: number }) =>
    v1<PurchaseOrder>(`/reorder/${variantId}/purchase-order`, post(body)),
  purchaseOrders: (status?: string) => request<Page<PurchaseOrder>>(`/api/v1/purchase-orders${qs({ status, limit: 100 })}`),
  purchaseOrder: (id: number) => v1<PurchaseOrder>(`/purchase-orders/${id}`),
  updatePurchaseOrder: (id: number, body: { lines?: { variant_id: number; quantity: number }[]; notes?: string }) =>
    v1<PurchaseOrder>(`/purchase-orders/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  purchaseOrderAction: (id: number, action: "approve" | "send" | "cancel" | "receive") =>
    v1<PurchaseOrder>(`/purchase-orders/${id}`, post({ action })),
  refreshDrafts: () => v1<{ created: number; updated: number; removed: number }>("/purchase-orders/refresh-drafts", post({})),
  suppliers: () => request<Page<Supplier>>(`/api/v1/suppliers${qs({ limit: 100 })}`),

  /* ---------- Ask StockSense ---------- */
  ask: (question: string, conversation_id?: number) => v1<AskAnswer>("/ask", post({ question, conversation_id })),
  askUsage: () => v1<AskUsage>("/ask/usage"),
};

/** ?a=1&b=2 from the defined values. */
function qs(p: Record<string, string | number | undefined | null>) {
  const parts = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Server-made image URLs (charts) point at APP_URL; load them through the address this app uses. */
export function imageSource(url: string) {
  let uri = url;
  try {
    const u = new URL(url);
    if (baseUrl) uri = baseUrl + u.pathname + u.search;
  } catch {}
  const headers: Record<string, string> = {};
  if (/ngrok/i.test(uri)) headers["ngrok-skip-browser-warning"] = "true";
  if (token) headers.Authorization = `Bearer ${token}`;
  return { uri, headers };
}

export function currentBaseUrl() {
  return baseUrl;
}
