import { Pool, types } from "pg";

// Return DATE columns as plain "YYYY-MM-DD" strings instead of JS Date objects.
types.setTypeParser(1082, (v: string) => v);
import { config } from "./config";

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export interface StoreRow {
  id: number;
  platform: "shopify" | "bigcommerce" | "woocommerce";
  store_domain: string;
  store_hash: string | null;
  access_token: string;
  currency: string;
  timezone: string;
  sync_status: string;
}

export async function getStore(id: number): Promise<StoreRow | null> {
  return queryOne<StoreRow>("SELECT * FROM stores WHERE id = $1", [id]);
}

export async function upsertStore(s: {
  platform: string;
  store_domain: string;
  store_hash?: string | null;
  access_token: string;
}): Promise<StoreRow> {
  const rows = await query<StoreRow>(
    `INSERT INTO stores (platform, store_domain, store_hash, access_token, sync_status, uninstalled_at)
     VALUES ($1, $2, $3, $4, 'pending', NULL)
     ON CONFLICT (platform, store_domain) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       store_hash = COALESCE(EXCLUDED.store_hash, stores.store_hash),
       uninstalled_at = NULL
     RETURNING *`,
    [s.platform, s.store_domain, s.store_hash ?? null, s.access_token]
  );
  return rows[0];
}
