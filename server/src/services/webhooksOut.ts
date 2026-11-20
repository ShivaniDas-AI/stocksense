/**
 * Outgoing webhooks (guide chapter 14).
 *
 * Every delivery is signed:
 *   X-StockSense-Timestamp: <unix seconds>
 *   X-StockSense-Signature: sha256=hex(HMAC_SHA256(secret, timestamp + "." + body))
 * Deliveries are queued in webhook_deliveries (so a sandbox request's events
 * roll back with it) and sent by a loop with retries: after 30 s, 5 min,
 * 30 min and 2 h, then marked failed.
 */
import crypto from "crypto";
import axios from "axios";
import { afterCommit, query, queryOne } from "../db";
import { requireFeature } from "../plans";
import { boolField, invalid, notFound, onlyFields, strField } from "./errors";

export const EVENTS = [
  "alert.stockout_risk",
  "alert.reorder_point",
  "alert.velocity_shift",
  "alert.lead_time_drift",
  "alert.overstock",
  "purchase_order.approved",
  "purchase_order.sent",
  "purchase_order.received",
] as const;

const RETRY_SECONDS = [30, 300, 1800, 7200];

export function sign(secret: string, timestamp: string, body: string) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function endpointOut(e: any, withSecret = false) {
  return {
    id: Number(e.id),
    url: e.url,
    events: e.events,
    description: e.description,
    active: e.active,
    created_at: e.created_at,
    ...(withSecret ? { secret: e.secret } : { secret_hint: `${String(e.secret).slice(0, 10)}…` }),
  };
}

function validateEvents(v: any): string[] {
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string")) {
    throw invalid("invalid_events", `events must be a list such as ["*"] or ${JSON.stringify(EVENTS.slice(0, 2))}.`, "events");
  }
  const bad = v.find((e: string) => e !== "*" && !(EVENTS as readonly string[]).includes(e) && !/^(alert|purchase_order)\.\*$/.test(e));
  if (bad) throw invalid("invalid_events", `Unknown event '${bad}'. Use * or any of: ${EVENTS.join(", ")}.`, "events");
  return Array.from(new Set(v));
}

function validateUrl(url: string) {
  let u: URL;
  try { u = new URL(url); } catch { throw invalid("invalid_url", "url is not a valid URL.", "url"); }
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1|host\.docker\.internal$)/.test(u.hostname);
  // Plain http only for local addresses in development (or with WEBHOOKS_ALLOW_HTTP=true for local testing).
  const devHttp = process.env.NODE_ENV !== "production" || process.env.WEBHOOKS_ALLOW_HTTP === "true";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && devHttp)) {
    throw invalid("invalid_url", "Webhook URLs must use https://.", "url");
  }
}

export async function listEndpoints(storeId: number) {
  await requireFeature(storeId, "webhooks");
  return (await query("SELECT * FROM webhook_endpoints WHERE store_id=$1 ORDER BY created_at", [storeId])).map((e) => endpointOut(e));
}

export async function createEndpoint(storeId: number, body: any) {
  await requireFeature(storeId, "webhooks");
  onlyFields(body, ["url", "events", "description"]);
  const url = strField(body, "url", { required: true, max: 500 })!;
  validateUrl(url);
  const events = body.events === undefined ? ["*"] : validateEvents(body.events);
  const secret = "whsec_" + crypto.randomBytes(24).toString("base64url");
  const e = await queryOne(
    "INSERT INTO webhook_endpoints (store_id, url, events, secret, description) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [storeId, url, events, secret, strField(body, "description", { max: 200 }) ?? null]
  );
  // The secret is shown once, like an API key.
  return endpointOut(e, true);
}

export async function updateEndpoint(storeId: number, id: number, body: any) {
  await requireFeature(storeId, "webhooks");
  onlyFields(body, ["url", "events", "description", "active"]);
  const e = await queryOne("SELECT * FROM webhook_endpoints WHERE id=$1 AND store_id=$2", [id, storeId]);
  if (!e) throw notFound("webhook endpoint", id);
  const url = strField(body, "url", { max: 500 });
  if (url) validateUrl(url);
  const events = body.events !== undefined ? validateEvents(body.events) : null;
  const active = boolField(body, "active");
  const row = await queryOne(
    `UPDATE webhook_endpoints SET url = COALESCE($3, url), events = COALESCE($4, events),
       description = CASE WHEN $5::boolean THEN $6 ELSE description END, active = COALESCE($7, active)
     WHERE id=$1 AND store_id=$2 RETURNING *`,
    [id, storeId, url ?? null, events, body.description !== undefined, strField(body, "description", { max: 200 }) ?? null, active ?? null]
  );
  return endpointOut(row);
}

export async function deleteEndpoint(storeId: number, id: number) {
  await requireFeature(storeId, "webhooks");
  const r = await query("DELETE FROM webhook_endpoints WHERE id=$1 AND store_id=$2 RETURNING id", [id, storeId]);
  if (!r.length) throw notFound("webhook endpoint", id);
  return { id, deleted: true };
}

export async function listDeliveries(storeId: number, endpointId: number, limit = 50) {
  await requireFeature(storeId, "webhooks");
  const e = await queryOne("SELECT id FROM webhook_endpoints WHERE id=$1 AND store_id=$2", [endpointId, storeId]);
  if (!e) throw notFound("webhook endpoint", endpointId);
  const rows = await query(
    `SELECT id, event_id, event, status, attempts, last_status_code, last_error, created_at, delivered_at, next_attempt_at
       FROM webhook_deliveries WHERE endpoint_id=$1 ORDER BY id DESC LIMIT $2`,
    [endpointId, Math.min(Math.max(limit, 1), 200)]
  );
  return rows.map((d: any) => ({ ...d, id: Number(d.id) }));
}

/**
 * Queue an event for every active endpoint of the store that subscribes to
 * it. Webhooks are a Pro feature; on other plans nothing is queued.
 */
export async function emit(storeId: number, event: string, data: any) {
  const plan = await queryOne("SELECT plan FROM stores WHERE id=$1", [storeId]);
  if (plan?.plan !== "pro") return 0;
  const family = event.split(".")[0] + ".*";
  const eps = await query(
    "SELECT id FROM webhook_endpoints WHERE store_id=$1 AND active AND ($2 = ANY(events) OR '*' = ANY(events) OR $3 = ANY(events))",
    [storeId, event, family]
  );
  if (!eps.length) return 0;
  const eventId = "evt_" + crypto.randomBytes(12).toString("hex");
  const payload = { id: eventId, type: event, created_at: new Date().toISOString(), store_id: storeId, data };
  for (const ep of eps) {
    await query("INSERT INTO webhook_deliveries (endpoint_id, event_id, event, payload) VALUES ($1,$2,$3,$4)", [ep.id, eventId, event, payload]);
  }
  afterCommit(() => processDueDeliveries());
  return eps.length;
}

/** Send a test event to one endpoint now and report the result. */
export async function sendTest(storeId: number, endpointId: number) {
  await requireFeature(storeId, "webhooks");
  const ep = await queryOne("SELECT * FROM webhook_endpoints WHERE id=$1 AND store_id=$2", [endpointId, storeId]);
  if (!ep) throw notFound("webhook endpoint", endpointId);
  const payload = {
    id: "evt_test_" + crypto.randomBytes(6).toString("hex"),
    type: "test",
    created_at: new Date().toISOString(),
    store_id: storeId,
    data: { message: "Test delivery from StockSense. Verify the signature, then answer 2xx." },
  };
  const r = await deliver(ep, payload);
  return { delivered: r.ok, status_code: r.status ?? null, error: r.error ?? null, duration_ms: r.ms };
}

async function deliver(ep: any, payload: any): Promise<{ ok: boolean; status?: number; error?: string; ms: number }> {
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const started = Date.now();
  try {
    const res = await axios.post(ep.url, body, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "StockSense-Webhooks/1.0",
        "X-StockSense-Event": payload.type,
        "X-StockSense-Delivery": payload.id,
        "X-StockSense-Timestamp": ts,
        "X-StockSense-Signature": sign(ep.secret, ts, body),
      },
      timeout: 10_000,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, error: ok ? undefined : `HTTP ${res.status}`, ms: Date.now() - started };
  } catch (e: any) {
    return { ok: false, error: e.code || e.message, ms: Date.now() - started };
  }
}

let running = false;

/** Send every due delivery once; reschedule failures with backoff. */
export async function processDueDeliveries() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const batch = await query(
        `SELECT d.*, e.url, e.secret, e.active FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
          WHERE d.status='pending' AND d.next_attempt_at <= now() ORDER BY d.id LIMIT 20`
      );
      if (!batch.length) break;
      for (const d of batch) {
        if (!d.active) {
          await query("UPDATE webhook_deliveries SET status='failed', last_error='endpoint disabled' WHERE id=$1", [d.id]);
          continue;
        }
        const r = await deliver(d, d.payload);
        const attempts = Number(d.attempts) + 1;
        if (r.ok) {
          await query("UPDATE webhook_deliveries SET status='delivered', attempts=$2, last_status_code=$3, last_error=NULL, delivered_at=now() WHERE id=$1", [d.id, attempts, r.status ?? null]);
        } else if (attempts > RETRY_SECONDS.length) {
          await query("UPDATE webhook_deliveries SET status='failed', attempts=$2, last_status_code=$3, last_error=$4 WHERE id=$1", [d.id, attempts, r.status ?? null, r.error ?? null]);
        } else {
          await query(
            "UPDATE webhook_deliveries SET attempts=$2, last_status_code=$3, last_error=$4, next_attempt_at = now() + ($5 || ' seconds')::interval WHERE id=$1",
            [d.id, attempts, r.status ?? null, r.error ?? null, String(RETRY_SECONDS[attempts - 1])]
          );
        }
      }
    }
  } catch (e: any) {
    console.error("[webhooks] delivery loop failed:", e.message);
  } finally {
    running = false;
  }
}
