import { AsyncLocalStorage } from "async_hooks";
import { Pool, PoolClient, types } from "pg";
import { config } from "./config";

// Return DATE columns as plain "YYYY-MM-DD" strings instead of JS Date objects.
types.setTypeParser(1082, (v: string) => v);

export const pool = new Pool({ connectionString: config.databaseUrl });

/**
 * Transaction context. Inside withTransaction() every query() call uses the
 * same client, so a request's writes commit or roll back together without
 * passing a client around. Sandbox API keys use this to run every write for
 * real and then roll it back ("reads live data, never saves changes").
 */
interface TxContext {
  client: PoolClient;
  sandbox: boolean;
  afterCommit: (() => void | Promise<void>)[];
}
const tx = new AsyncLocalStorage<TxContext>();

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const ctx = tx.getStore();
  const res = await (ctx ? ctx.client : pool).query(text, params);
  return res.rows as T[];
}

export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run fn in one transaction. Nested calls join the outer transaction.
 * rollback: true runs everything and then rolls back (sandbox mode).
 */
export async function withTransaction<T>(fn: () => Promise<T>, opts: { rollback?: boolean } = {}): Promise<T> {
  if (tx.getStore()) return fn();
  const client = await pool.connect();
  const ctx: TxContext = { client, sandbox: !!opts.rollback, afterCommit: [] };
  try {
    await client.query("BEGIN");
    const result = await tx.run(ctx, fn);
    if (ctx.sandbox) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
      for (const f of ctx.afterCommit) {
        Promise.resolve()
          .then(f)
          .catch((e) => console.error("[afterCommit]", e?.message || e));
      }
    }
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Schedule a side effect (email, webhook push, platform write) for after the
 * current transaction commits. Skipped entirely in sandbox mode; runs at once
 * outside a transaction.
 */
export function afterCommit(fn: () => void | Promise<void>) {
  const ctx = tx.getStore();
  if (!ctx) {
    Promise.resolve()
      .then(fn)
      .catch((e) => console.error("[afterCommit]", e?.message || e));
    return;
  }
  if (ctx.sandbox) return;
  ctx.afterCommit.push(fn);
}

export function inSandbox(): boolean {
  return !!tx.getStore()?.sandbox;
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
  plan: string;
  is_demo: boolean;
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

export { ensureSchema } from "./migrations";
