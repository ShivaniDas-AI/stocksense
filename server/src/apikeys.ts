/**
 * API keys for the public API.
 *
 *   live     ss_live_<43 chars>   reads and writes
 *   sandbox  ss_test_<43 chars>   reads live data, but every write is rolled back
 *
 * Only the SHA-256 hash of a key is stored, plus a short prefix so people can
 * tell keys apart. The full key is shown once, when it is created. Each key
 * belongs to one store and sees only that store's data.
 */
import crypto from "crypto";
import { query, queryOne } from "./db";

export type KeyMode = "live" | "sandbox";
const PREFIX: Record<KeyMode, string> = { live: "ss_live_", sandbox: "ss_test_" };

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function looksLikeApiKey(secret: string) {
  return secret.startsWith(PREFIX.live) || secret.startsWith(PREFIX.sandbox);
}

export async function createApiKey(storeId: number, name: string, mode: KeyMode = "live") {
  const secret = PREFIX[mode] + crypto.randomBytes(32).toString("base64url");
  const prefix = secret.slice(0, PREFIX[mode].length + 6); // e.g. ss_live_AbC123
  const row = await queryOne(
    `INSERT INTO api_keys (store_id, name, prefix, key_hash, mode)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, prefix, mode, created_at`,
    [storeId, name, prefix, sha256(secret), mode]
  );
  return { ...row, id: Number(row.id), key: secret };
}

export async function listApiKeys(storeId: number) {
  const rows = await query(
    `SELECT id, name, prefix, mode, created_at, last_used_at
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
export async function verifyApiKey(secret: string): Promise<{ id: number; storeId: number; mode: KeyMode } | null> {
  if (!looksLikeApiKey(secret) || secret.length < 28) return null;
  const row = await queryOne(
    `SELECT k.id, k.store_id, k.mode FROM api_keys k JOIN stores s ON s.id = k.store_id
     WHERE k.key_hash=$1 AND k.revoked_at IS NULL AND s.uninstalled_at IS NULL`,
    [sha256(secret)]
  );
  if (!row) return null;
  // Best effort; a slow write should not slow the request.
  query("UPDATE api_keys SET last_used_at = now() WHERE id=$1", [row.id]).catch(() => {});
  return { id: Number(row.id), storeId: Number(row.store_id), mode: row.mode === "sandbox" ? "sandbox" : "live" };
}
