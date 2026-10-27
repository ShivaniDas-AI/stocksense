import type {
  AlertItem,
  ConnectResponse,
  RisksResponse,
  StoreInfo,
  StoresResponse,
  Summary,
  VariantDetail,
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
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

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
};
