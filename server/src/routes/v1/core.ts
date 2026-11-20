/**
 * Shared plumbing for the StockSense API (/api/v1, also served at /v1).
 *
 *   Auth      API key: Authorization: Bearer ss_live_... (or X-API-Key); Pro plan
 *             App session: the bearer token or cookie the StockSense app uses
 *   Sandbox   ss_test_ keys read live data; every write runs and is rolled back
 *   Limits    120 requests per minute per key (X-RateLimit-* headers)
 *   Bodies    objects { "data": {...} }; lists { "data": [...], "page", "limit", "total", "has_more" }
 *   Errors    { "error": { "type", "code", "message", "field"? } }
 */
import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { looksLikeApiKey, verifyApiKey } from "../../apikeys";
import { withTransaction } from "../../db";
import { PlanError, requireFeature } from "../../plans";
import { ApiError, intField, invalid } from "../../services/errors";
import { getSessionStoreId } from "../auth";

export type Req = Request & {
  storeId?: number;
  keyId?: number;
  via?: "key" | "session";
  sandbox?: boolean;
  requestId?: string;
};

export function fail(res: Response, status: number, type: string, code: string, message: string, field?: string) {
  return res.status(status).json({ error: { type, code, message, ...(field ? { field } : {}) } });
}

/* ---------------- request id ---------------- */

export function requestId(req: Req, res: Response, next: NextFunction) {
  req.requestId = "req_" + crypto.randomBytes(8).toString("hex");
  res.setHeader("X-Request-Id", req.requestId);
  next();
}

/* ---------------- auth ---------------- */

export function authenticate(req: Req, res: Response, next: NextFunction) {
  (async () => {
    const bearer = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const headerKey = req.get("x-api-key")?.trim();
    const secret = headerKey || bearer || "";

    if (secret && looksLikeApiKey(secret)) {
      const key = await verifyApiKey(secret);
      if (!key) return fail(res, 401, "authentication_error", "invalid_api_key", "This API key is not valid or has been revoked.");
      try {
        await requireFeature(key.storeId, "api");
      } catch (e: any) {
        return fail(res, 402, "plan_error", "plan_required", "The REST API needs the Pro plan.");
      }
      req.storeId = key.storeId;
      req.keyId = key.id;
      req.via = "key";
      req.sandbox = key.mode === "sandbox";
      if (req.sandbox) res.setHeader("X-StockSense-Sandbox", "true");
      return next();
    }

    const storeId = getSessionStoreId(req);
    if (storeId) {
      req.storeId = storeId;
      req.via = "session";
      req.sandbox = false;
      return next();
    }
    return fail(
      res, 401, "authentication_error", secret ? "invalid_token" : "missing_api_key",
      secret
        ? "This token is not a valid API key or app session."
        : "Send your key as 'Authorization: Bearer ss_live_...' or 'X-API-Key'. Create keys in StockSense under Settings > API & webhooks."
    );
  })().catch(next);
}

/** Some endpoints (managing API keys) are only for the signed-in app, not for keys. */
export function sessionOnly(req: Req, res: Response, next: NextFunction) {
  if (req.via !== "session") return fail(res, 403, "permission_error", "session_required", "Manage this from the StockSense app; API keys cannot.");
  next();
}

/* ---------------- rate limit (keys) ---------------- */

const LIMIT = 120;
const WINDOW_MS = 60_000;
const buckets = new Map<number, { start: number; count: number }>();

export function rateLimit(req: Req, res: Response, next: NextFunction) {
  if (req.via !== "key") return next();
  const now = Date.now();
  let b = buckets.get(req.keyId!);
  if (!b || now - b.start >= WINDOW_MS) {
    b = { start: now, count: 0 };
    buckets.set(req.keyId!, b);
  }
  b.count++;
  const reset = Math.ceil((b.start + WINDOW_MS) / 1000);
  res.setHeader("X-RateLimit-Limit", String(LIMIT));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, LIMIT - b.count)));
  res.setHeader("X-RateLimit-Reset", String(reset));
  if (b.count > LIMIT) {
    res.setHeader("Retry-After", String(Math.max(1, reset - Math.floor(now / 1000))));
    return fail(res, 429, "rate_limit_error", "rate_limited", `Limit of ${LIMIT} requests per minute reached. Retry after the time in the Retry-After header.`);
  }
  next();
}

/* ---------------- handlers ---------------- */

interface HOpts {
  write?: boolean; // run in a transaction (rolled back for sandbox keys)
  status?: number; // success status (201 create, 202 accepted)
}

/**
 * Wrap a handler that returns the response body. Writes run in one
 * transaction; the response is sent only after it commits (or, for sandbox
 * keys, after it rolls back), so a client never sees a change that did not
 * happen.
 */
export const h =
  (fn: (req: Req, res: Response) => Promise<any>, opts: HOpts = {}) =>
  (req: Req, res: Response, next: NextFunction) => {
    const run = () => fn(req, res);
    const p = opts.write || req.method !== "GET" ? withTransaction(run, { rollback: !!req.sandbox }) : run();
    p.then((body) => {
      if (res.headersSent || body === undefined) return;
      if (req.sandbox && req.method !== "GET" && body && typeof body === "object") body = { ...body, sandbox: true };
      if (opts.status) res.status(opts.status); // else keep a status the handler set (default 200)
      res.json(body);
    }).catch(next);
  };

export const one = (data: any) => ({ data });

/* ---------------- params ---------------- */

export function idParam(req: Req, name = "id"): number {
  const v = Number(req.params[name]);
  if (!Number.isInteger(v) || v < 1) throw invalid("invalid_id", `${name} must be a positive whole number.`, name);
  return v;
}

export function listParam(req: Req, name: string): string[] | undefined {
  const v = req.query[name];
  if (v === undefined || v === "") return undefined;
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

export function intQuery(req: Req, name: string, opts: { min?: number; max?: number } = {}): number | undefined {
  return intField(req.query, name, opts);
}

export function boolQuery(req: Req, name: string): boolean | undefined {
  const v = req.query[name];
  if (v === undefined) return undefined;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw invalid("invalid_value", `${name} must be true or false.`, name);
}

/* ---------------- errors ---------------- */

export function errorHandler(err: any, req: Req, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) return fail(res, err.status, err.type, err.code, err.message, err.field);
  if (err instanceof PlanError) return fail(res, 402, "plan_error", err.code, err.message);
  if (err?.type === "entity.parse.failed") return fail(res, 400, "invalid_request_error", "invalid_json", "The request body is not valid JSON.");
  if (err?.code === "23514" || err?.code === "22P02" || err?.code === "22003") {
    return fail(res, 400, "invalid_request_error", "invalid_value", "A value is out of range or the wrong type.");
  }
  console.error(`[api ${req.requestId}] ${req.method} ${req.originalUrl}:`, err?.stack || err);
  fail(res, 500, "api_error", "internal_error", `Something went wrong. Quote request id ${req.requestId} when reporting it.`);
}
