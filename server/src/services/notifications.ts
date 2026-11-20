/**
 * Alert notifications (Settings > Notifications): email on every plan;
 * Slack, SMS and WhatsApp on Scale and Pro. SMS and WhatsApp can be limited
 * to urgent alerts (stockout risk, reorder point).
 */
import axios from "axios";
import { query, queryOne } from "../db";
import { config } from "../config";
import { hasFeature } from "../plans";
import { getNotificationSettings } from "./settings";
import { sendAlertMessage, whatsappConfigured } from "../whatsapp/cloud";

type Channel = "email" | "slack" | "sms" | "whatsapp";
interface ChannelResult { channel: Channel; status: "sent" | "skipped" | "failed"; detail: string }

async function sendEmail(to: string, subject: string, html: string) {
  if (!config.alerts.resendApiKey) throw new Error("Email is not configured on the server (RESEND_API_KEY).");
  await axios.post(
    "https://api.resend.com/emails",
    { from: config.alerts.fromEmail, to: [to], subject, html },
    { headers: { Authorization: `Bearer ${config.alerts.resendApiKey}` }, timeout: 15000 }
  );
}

async function sendSlack(url: string, text: string) {
  await axios.post(url, { text }, { timeout: 10000 });
}

async function sendSms(to: string, body: string) {
  const { accountSid, authToken, from } = config.twilio;
  if (!accountSid || !authToken || !from) throw new Error("SMS is not configured on the server (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM).");
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    new URLSearchParams({ To: "+" + to, From: from, Body: body.slice(0, 1500) }).toString(),
    { auth: { username: accountSid, password: authToken }, headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
  );
}

function describe(e: any): string {
  const status = e?.response?.status;
  const data = e?.response?.data;
  const msg = data?.error?.message || data?.message || data?.error || e?.message || String(e);
  return status ? `HTTP ${status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}` : String(msg);
}

/** Send to every enabled channel; returns what happened per channel. */
async function dispatch(storeId: number, items: { title: string; message: string; urgent: boolean }[], opts: { test?: boolean } = {}): Promise<ChannelResult[]> {
  const s = await getNotificationSettings(storeId);
  const store = await queryOne("SELECT name, store_domain FROM stores WHERE id=$1", [storeId]);
  const storeName = store?.name || store?.store_domain;
  const messaging = await hasFeature(storeId, "messaging_alerts");
  const results: ChannelResult[] = [];
  const dashboard = `${config.appUrl}/dashboard`;
  const head = opts.test ? `StockSense test alert for ${storeName}` : `StockSense: ${items.length} new alert${items.length === 1 ? "" : "s"} for ${storeName}`;
  const plain = [head, ...items.map((i) => `• ${i.title}: ${i.message}`)].join("\n");
  const urgentItems = items.filter((i) => i.urgent);

  // Email
  const to = s.alert_email || process.env.ALERT_TO_EMAIL;
  if (!s.email_enabled) results.push({ channel: "email", status: "skipped", detail: "Email alerts are off." });
  else if (!to) results.push({ channel: "email", status: "skipped", detail: "No alert email is set." });
  else {
    try {
      await sendEmail(to, head, `<div style="font-family:Arial,sans-serif"><h3>${head}</h3><ul>${items.map((i) => `<li><b>${i.title}</b><br>${i.message}</li>`).join("")}</ul><p><a href="${dashboard}">Open StockSense</a></p></div>`);
      results.push({ channel: "email", status: "sent", detail: `Sent to ${to}.` });
    } catch (e) { results.push({ channel: "email", status: "failed", detail: describe(e) }); }
  }

  const gate = (ch: Channel, enabled: boolean, needsUrgent: boolean): string | null => {
    if (!enabled) return `${ch === "sms" ? "SMS" : ch[0].toUpperCase() + ch.slice(1)} alerts are off.`;
    if (!messaging) return "Slack, SMS and WhatsApp alerts need the Scale or Pro plan.";
    if (needsUrgent && s.urgent_only && !opts.test && !urgentItems.length) return "Only urgent alerts are sent to this channel, and none of these are urgent.";
    return null;
  };
  const textFor = (needsUrgent: boolean) => {
    const list = needsUrgent && s.urgent_only && !opts.test ? urgentItems : items;
    return [head, ...list.map((i) => `• ${i.title}`), dashboard].join("\n");
  };

  // Slack
  const slackGate = gate("slack", s.slack_enabled, false);
  if (slackGate) results.push({ channel: "slack", status: "skipped", detail: slackGate });
  else {
    try { await sendSlack(s.slack_webhook_url!, plain); results.push({ channel: "slack", status: "sent", detail: "Posted to Slack." }); }
    catch (e) { results.push({ channel: "slack", status: "failed", detail: describe(e) }); }
  }

  // SMS
  const smsGate = gate("sms", s.sms_enabled, true);
  if (smsGate) results.push({ channel: "sms", status: "skipped", detail: smsGate });
  else {
    try { await sendSms(s.phone!, textFor(true)); results.push({ channel: "sms", status: "sent", detail: `Sent to +${s.phone}.` }); }
    catch (e) { results.push({ channel: "sms", status: "failed", detail: describe(e) }); }
  }

  // WhatsApp
  const waGate = gate("whatsapp", s.whatsapp_enabled, true);
  if (waGate) results.push({ channel: "whatsapp", status: "skipped", detail: waGate });
  else if (!whatsappConfigured()) results.push({ channel: "whatsapp", status: "failed", detail: "WhatsApp is not configured on the server (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID)." });
  else {
    try { await sendAlertMessage(s.phone!, textFor(true)); results.push({ channel: "whatsapp", status: "sent", detail: `Sent to +${s.phone}.` }); }
    catch (e) {
      const d = describe(e);
      results.push({
        channel: "whatsapp", status: "failed",
        detail: /131047|24 hours|re-engagement/i.test(d)
          ? `${d}. WhatsApp only allows free text within 24 hours of the last message from this number; set WHATSAPP_ALERT_TEMPLATE to an approved template, or message the business number once.`
          : d,
      });
    }
  }
  return results;
}

export async function notifyNewAlerts(storeId: number, alertIds: number[]) {
  const alerts = await query("SELECT id, title, message, urgent FROM inventory_alerts WHERE id = ANY($1) AND status='open'", [alertIds]);
  if (!alerts.length) return [];
  const results = await dispatch(storeId, alerts.map((a: any) => ({ title: a.title, message: a.message, urgent: a.urgent })));
  await query("UPDATE inventory_alerts SET notified_at = now() WHERE id = ANY($1)", [alertIds]);
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length) console.warn(`[notify ${storeId}]`, failed.map((f) => `${f.channel}: ${f.detail}`).join("; "));
  return results;
}

/** Settings > Notifications > Send a test alert: the result names any problem. */
export async function sendTestAlert(storeId: number) {
  const results = await dispatch(
    storeId,
    [{ title: "Test alert", message: "If you can read this, StockSense alerts reach you here.", urgent: true }],
    { test: true }
  );
  return { results, all_ok: results.every((r) => r.status !== "failed") };
}
