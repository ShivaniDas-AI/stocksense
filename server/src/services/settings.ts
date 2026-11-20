/** Settings > Forecasting and Settings > Notifications. */
import { query, queryOne } from "../db";
import { boolField, invalid, numField, intField, onlyFields, strField } from "./errors";
import { queueForecast } from "./inventory";

export interface ForecastSettings {
  service_level: number;
  default_lead_time_days: number;
  coverage_days: number;
  overstock_days: number;
  velocity_threshold: number;
  updated_at?: string;
}

/** z-score for a service level (one-sided normal), as used for safety stock. */
export function zForServiceLevel(p: number): number {
  // Acklam's rational approximation of the inverse normal CDF.
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  if (q < 0.02425) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  if (q > 1 - 0.02425) {
    const r = Math.sqrt(-2 * Math.log(1 - q));
    return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  const r = q - 0.5;
  const s = r * r;
  return ((((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r) / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}

export async function getForecastSettings(storeId: number): Promise<ForecastSettings> {
  await query("INSERT INTO store_settings (store_id) VALUES ($1) ON CONFLICT DO NOTHING", [storeId]);
  const s = await queryOne("SELECT * FROM store_settings WHERE store_id=$1", [storeId]);
  return {
    service_level: Number(s.service_level),
    default_lead_time_days: Number(s.default_lead_time_days),
    coverage_days: Number(s.coverage_days),
    overstock_days: Number(s.overstock_days),
    velocity_threshold: Number(s.velocity_threshold),
    updated_at: s.updated_at,
  };
}

/** Saving rebuilds every forecast (guide chapter 12). */
export async function updateForecastSettings(storeId: number, body: any) {
  onlyFields(body, ["service_level", "default_lead_time_days", "coverage_days", "overstock_days", "velocity_threshold"]);
  const sl = numField(body, "service_level", { min: 0.5, max: 0.999 });
  const lt = intField(body, "default_lead_time_days", { min: 1, max: 365 });
  const cov = intField(body, "coverage_days", { min: 1, max: 365 });
  const over = intField(body, "overstock_days", { min: 7, max: 730 });
  const vel = numField(body, "velocity_threshold", { min: 1.1, max: 10 });
  if ([sl, lt, cov, over, vel].every((v) => v === undefined)) throw invalid("invalid_body", "Send at least one setting to change.");
  await getForecastSettings(storeId);
  await query(
    `UPDATE store_settings SET
       service_level = COALESCE($2, service_level),
       default_lead_time_days = COALESCE($3, default_lead_time_days),
       coverage_days = COALESCE($4, coverage_days),
       overstock_days = COALESCE($5, overstock_days),
       velocity_threshold = COALESCE($6, velocity_threshold),
       updated_at = now()
     WHERE store_id = $1`,
    [storeId, sl ?? null, lt ?? null, cov ?? null, over ?? null, vel ?? null]
  );
  const job = await queueForecast(storeId);
  return { settings: await getForecastSettings(storeId), rebuild_job_id: Number(job.id) };
}

/* ---------------- notifications ---------------- */

export interface NotificationSettings {
  email_enabled: boolean;
  alert_email: string | null;
  slack_enabled: boolean;
  slack_webhook_url: string | null;
  phone: string | null;
  sms_enabled: boolean;
  whatsapp_enabled: boolean;
  urgent_only: boolean;
}

export async function getNotificationSettings(storeId: number): Promise<NotificationSettings> {
  await query("INSERT INTO notification_settings (store_id) VALUES ($1) ON CONFLICT DO NOTHING", [storeId]);
  const s = await queryOne("SELECT * FROM notification_settings WHERE store_id=$1", [storeId]);
  return {
    email_enabled: s.email_enabled,
    alert_email: s.alert_email,
    slack_enabled: s.slack_enabled,
    slack_webhook_url: s.slack_webhook_url,
    phone: s.phone,
    sms_enabled: s.sms_enabled,
    whatsapp_enabled: s.whatsapp_enabled,
    urgent_only: s.urgent_only,
  };
}

/** Phone numbers are stored as E.164 digits without the plus. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!/^\+?\d{8,15}$/.test(digits)) {
    throw invalid("invalid_phone", "Enter the mobile number with its country code, for example +919876543210.", "phone");
  }
  if (!digits.startsWith("+") && digits.length < 11) {
    throw invalid("invalid_phone", "Include the country code, for example +91 for India or +1 for the US.", "phone");
  }
  return digits.replace(/^\+/, "");
}

export async function updateNotificationSettings(storeId: number, body: any) {
  onlyFields(body, ["email_enabled", "alert_email", "slack_enabled", "slack_webhook_url", "phone", "sms_enabled", "whatsapp_enabled", "urgent_only"]);
  const email = strField(body, "alert_email", { max: 200 });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid("invalid_email", "alert_email is not a valid email address.", "alert_email");
  const slack = strField(body, "slack_webhook_url", { max: 500 });
  if (slack && !/^https:\/\/hooks\.slack\.com\//.test(slack)) {
    throw invalid("invalid_slack_url", "slack_webhook_url must be a Slack incoming webhook (https://hooks.slack.com/...).", "slack_webhook_url");
  }
  const phoneRaw = strField(body, "phone", { max: 30 });
  const phone = phoneRaw ? normalisePhone(phoneRaw) : phoneRaw;
  const flags = ["email_enabled", "slack_enabled", "sms_enabled", "whatsapp_enabled", "urgent_only"].map((f) => boolField(body, f));

  const current = await getNotificationSettings(storeId);
  const next = {
    email_enabled: flags[0] ?? current.email_enabled,
    alert_email: email !== undefined ? email : current.alert_email,
    slack_enabled: flags[1] ?? current.slack_enabled,
    slack_webhook_url: slack !== undefined ? slack : current.slack_webhook_url,
    phone: phone !== undefined ? phone : current.phone,
    sms_enabled: flags[2] ?? current.sms_enabled,
    whatsapp_enabled: flags[3] ?? current.whatsapp_enabled,
    urgent_only: flags[4] ?? current.urgent_only,
  };
  if (next.slack_enabled && !next.slack_webhook_url) throw invalid("missing_field", "Add slack_webhook_url to turn Slack on.", "slack_webhook_url");
  if ((next.sms_enabled || next.whatsapp_enabled) && !next.phone) throw invalid("missing_field", "Add a phone number to turn on SMS or WhatsApp.", "phone");

  await query(
    `UPDATE notification_settings SET email_enabled=$2, alert_email=$3, slack_enabled=$4, slack_webhook_url=$5,
       phone=$6, sms_enabled=$7, whatsapp_enabled=$8, urgent_only=$9, updated_at=now() WHERE store_id=$1`,
    [storeId, next.email_enabled, next.alert_email, next.slack_enabled, next.slack_webhook_url, next.phone, next.sms_enabled, next.whatsapp_enabled, next.urgent_only]
  );
  return getNotificationSettings(storeId);
}
