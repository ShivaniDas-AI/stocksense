/**
 * Errors services throw; the API turns them into
 * { "error": { "type", "code", "message", "field"? } } with the right status.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public type: string,
    public code: string,
    message: string,
    public field?: string
  ) {
    super(message);
  }
}

export const notFound = (what: string, id: number | string) =>
  new ApiError(404, "not_found", `${what.toLowerCase().replace(/\s+/g, "_")}_not_found`, `No ${what} ${id} in this store.`);

export const invalid = (code: string, message: string, field?: string) =>
  new ApiError(400, "invalid_request_error", code, message, field);

export const conflict = (code: string, message: string) => new ApiError(409, "invalid_request_error", code, message);

/** Parse an optional whole number within bounds, or throw a field error. */
export function intField(body: any, field: string, opts: { min?: number; max?: number; required?: boolean } = {}): number | undefined {
  const v = body?.[field];
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw invalid("missing_field", `${field} is required.`, field);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw invalid("invalid_value", `${field} must be a whole number.`, field);
  if (opts.min !== undefined && n < opts.min) throw invalid("invalid_value", `${field} must be at least ${opts.min}.`, field);
  if (opts.max !== undefined && n > opts.max) throw invalid("invalid_value", `${field} must be at most ${opts.max}.`, field);
  return n;
}

export function numField(body: any, field: string, opts: { min?: number; max?: number; required?: boolean } = {}): number | undefined {
  const v = body?.[field];
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw invalid("missing_field", `${field} is required.`, field);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw invalid("invalid_value", `${field} must be a number.`, field);
  if (opts.min !== undefined && n < opts.min) throw invalid("invalid_value", `${field} must be at least ${opts.min}.`, field);
  if (opts.max !== undefined && n > opts.max) throw invalid("invalid_value", `${field} must be at most ${opts.max}.`, field);
  return n;
}

export function strField(body: any, field: string, opts: { max?: number; required?: boolean } = {}): string | undefined | null {
  const v = body?.[field];
  if (v === undefined) {
    if (opts.required) throw invalid("missing_field", `${field} is required.`, field);
    return undefined;
  }
  if (v === null) {
    if (opts.required) throw invalid("missing_field", `${field} is required.`, field);
    return null;
  }
  if (typeof v !== "string") throw invalid("invalid_value", `${field} must be text.`, field);
  const s = v.trim();
  if (opts.required && !s) throw invalid("missing_field", `${field} is required.`, field);
  if (opts.max && s.length > opts.max) throw invalid("invalid_value", `${field} must be at most ${opts.max} characters.`, field);
  return s || null;
}

export function boolField(body: any, field: string): boolean | undefined {
  const v = body?.[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw invalid("invalid_value", `${field} must be true or false.`, field);
  return v;
}

export function dateField(body: any, field: string, opts: { required?: boolean } = {}): string | undefined {
  const v = body?.[field];
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw invalid("missing_field", `${field} is required.`, field);
    return undefined;
  }
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw invalid("invalid_value", `${field} must be a date as YYYY-MM-DD.`, field);
  }
  return v;
}

export function onlyFields(body: any, allowed: string[]) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw invalid("invalid_body", "Send a JSON object.");
  const unknown = Object.keys(body).find((k) => !allowed.includes(k));
  if (unknown) throw invalid("unknown_field", `'${unknown}' is not a field you can set here. Allowed: ${allowed.join(", ")}.`, unknown);
}
