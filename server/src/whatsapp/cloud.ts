/**
 * WhatsApp Cloud API (Meta Graph API) client: send text, reply buttons,
 * list menus and images. The assistant builds messages in a neutral shape
 * (OutMessage) so the same flow also runs through the simulator endpoint
 * without Meta credentials.
 */
import crypto from "crypto";
import axios from "axios";
import { config } from "../config";

export type OutMessage =
  | { type: "text"; text: string }
  | { type: "buttons"; text: string; header?: string; footer?: string; buttons: { id: string; title: string }[] }
  | { type: "list"; text: string; header?: string; footer?: string; button: string; sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[] }
  | { type: "image"; url: string; caption?: string };

export const whatsappConfigured = () => !!(config.whatsapp.token && config.whatsapp.phoneNumberId);

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Graph API payload for one message, within WhatsApp's length limits. */
export function toGraphPayload(to: string, m: OutMessage): any {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  switch (m.type) {
    case "text":
      return { ...base, type: "text", text: { body: clip(m.text, 4096), preview_url: false } };
    case "image":
      return { ...base, type: "image", image: { link: m.url, caption: m.caption ? clip(m.caption, 1024) : undefined } };
    case "buttons":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          header: m.header ? { type: "text", text: clip(m.header, 60) } : undefined,
          body: { text: clip(m.text, 1024) },
          footer: m.footer ? { text: clip(m.footer, 60) } : undefined,
          action: { buttons: m.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: clip(b.id, 256), title: clip(b.title, 20) } })) },
        },
      };
    case "list":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          header: m.header ? { type: "text", text: clip(m.header, 60) } : undefined,
          body: { text: clip(m.text, 1024) },
          footer: m.footer ? { text: clip(m.footer, 60) } : undefined,
          action: {
            button: clip(m.button, 20),
            sections: m.sections.map((s) => ({
              title: s.title ? clip(s.title, 24) : undefined,
              rows: s.rows.slice(0, 10).map((r) => ({ id: clip(r.id, 200), title: clip(r.title, 24), description: r.description ? clip(r.description, 72) : undefined })),
            })),
          },
        },
      };
  }
}

export async function sendMessages(to: string, msgs: OutMessage[]) {
  if (!whatsappConfigured()) throw new Error("WhatsApp is not configured on the server (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID).");
  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;
  for (const m of msgs) {
    await axios.post(url, toGraphPayload(to, m), {
      headers: { Authorization: `Bearer ${config.whatsapp.token}`, "Content-Type": "application/json" },
      timeout: 15000,
    });
  }
}

/**
 * Business-initiated message (an alert). Free text only reaches a number that
 * wrote in the last 24 hours; otherwise WhatsApp requires an approved
 * template, set as WHATSAPP_ALERT_TEMPLATE with one body variable.
 */
export async function sendAlertMessage(to: string, text: string) {
  if (!whatsappConfigured()) throw new Error("WhatsApp is not configured on the server (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID).");
  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;
  const payload = config.whatsapp.alertTemplate
    ? {
        messaging_product: "whatsapp", to, type: "template",
        template: { name: config.whatsapp.alertTemplate, language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: clip(text, 1000) }] }] },
      }
    : { messaging_product: "whatsapp", to, type: "text", text: { body: clip(text, 4096) } };
  await axios.post(url, payload, { headers: { Authorization: `Bearer ${config.whatsapp.token}` }, timeout: 15000 });
}

/** Meta signs webhook bodies with the app secret: X-Hub-Signature-256: sha256=<hex>. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!config.whatsapp.appSecret) return process.env.NODE_ENV !== "production"; // dev without a secret
  if (!header?.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", config.whatsapp.appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
