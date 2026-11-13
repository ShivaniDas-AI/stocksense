/**
 * API keys for the public /v1 API.
 *
 * A key looks like `ss_live_<43 url-safe chars>` (256 bits of randomness).
 * Only its SHA-256 hash is stored, plus a short prefix so people can tell
 * keys apart in the list; the full key is shown once, when it is created.
 * Each key belongs to one store and sees only that store's data.
 */
import crypto from "crypto";
import { query, queryOne } from "./db";

const PREFIX = "ss_live_";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export interface ApiKeyRecord {
  id: number;
  store_id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function createApiKey(storeId: number, name: string) {
  const secret = PREFIX + crypto.randomBytes(32).toString("base64url");
  const prefix = secret.slice(0, PREFIX.length + 6); // e.g. ss_live_AbC123
  const row = await queryOne(
    `INSERT INTO api_keys (store_id, name, prefix, key_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, prefix, created_at`,
    [storeId, name, prefix, sha256(secret)]
  );
  return { ...row, id: Number(row.id), key: secret };
}

export async function listApiKeys(storeId: number) {
  const rows = await query(
    `SELECT id, name, prefix, created_at, last_used_at
     FROM api_keys WHERE store_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC`,
    [storeId]
  );
  return rows.map((r: any) => ({ ...r, id: Number(r.id) }));
}

export async function revokeApiKey(storeId: number, id: number): Promise<boolean> {
  const rows = await query(
    "UPDATE api_keys SET revoked_at = now() WHERE id=$1 AND store_id=$2 AND revoked_at IS NULL RETURNING id",
    [id, storeId]
  );
  return rows.length > 0;
}

/** Look up an active key by its secret; returns null for unknown or revoked keys. */
export async function verifyApiKey(secret: string): Promise<{ id: number; storeId: number } | null> {
  if (!secret.startsWith(PREFIX) || secret.length < PREFIX.length + 20) return null;
  const row = await queryOne(
    `SELECT k.id, k.store_id FROM api_keys k JOIN stores s ON s.id = k.store_id
     WHERE k.key_hash=$1 AND k.revoked_at IS NULL AND s.uninstalled_at IS NULL`,
    [sha256(secret)]
  );
  if (!row) return null;
  // Best effort; a slow write should not slow the request.
  query("UPDATE api_keys SET last_used_at = now() WHERE id=$1", [row.id]).catch(() => {});
  return { id: Number(row.id), storeId: Number(row.store_id) };
}
