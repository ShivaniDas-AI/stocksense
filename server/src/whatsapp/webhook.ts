/**
 * Meta WhatsApp Cloud API webhook.
 *   GET  /webhooks/whatsapp   subscription check (hub.verify_token)
 *   POST /webhooks/whatsapp   incoming messages, signed with X-Hub-Signature-256
 * Meta expects a 200 quickly, so messages are handled after the response.
 */
import { Router } from "express";
import { config } from "../config";
import { withTransaction } from "../db";
import { handleMessage } from "./bot";
import { sendMessages, verifyMetaSignature } from "./cloud";

export const whatsappWebhookRouter = Router();

whatsappWebhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"], token = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && config.whatsapp.verifyToken && token === config.whatsapp.verifyToken) return res.status(200).send(String(challenge));
  res.sendStatus(403);
});

const seen = new Map<string, number>(); // Meta may deliver a message more than once

whatsappWebhookRouter.post("/", (req, res) => {
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !verifyMetaSignature(raw, req.get("x-hub-signature-256"))) return res.sendStatus(401);
  res.sendStatus(200);
  let body: any;
  try { body = JSON.parse(raw.toString("utf8")); } catch { return; }

  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 3_600_000) seen.delete(k);

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        if (!msg.id || seen.has(msg.id)) continue;
        seen.set(msg.id, now);
        const from = String(msg.from || "");
        const input =
          msg.type === "text" ? { text: msg.text?.body ?? "" }
          : msg.type === "interactive" ? { id: msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id }
          : msg.type === "button" ? { text: msg.button?.text ?? "" }
          : { text: "" };
        withTransaction(() => handleMessage(from, input))
          .then((replies) => sendMessages(from, replies))
          .catch((e) => console.error("[whatsapp] reply failed:", e.response?.data?.error?.message || e.message));
      }
    }
  }
});
