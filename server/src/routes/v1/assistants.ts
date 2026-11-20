/** Ask StockSense (chapter 11) and WhatsApp (Settings > WhatsApp) endpoints. */
import { Router } from "express";
import {
  ask, askUsage, createConversation, deleteAllConversations, deleteConversation, getConversation, listConversations, renameConversation,
} from "../../services/ask";
import { invalid, onlyFields, strField, intField } from "../../services/errors";
import { handleMessage } from "../../whatsapp/bot";
import { toGraphPayload } from "../../whatsapp/cloud";
import {
  createLinkCode, disconnectNumber, listActivity, listNumbers, updateNumber, whatsappStatus,
} from "../../whatsapp/actions";
import { normalisePhone } from "../../services/settings";
import { queryOne } from "../../db";
import { h, idParam, intQuery, one } from "./core";

export function registerAssistants(r: Router) {
  /* ---------- Ask StockSense ---------- */
  r.get("/ask/usage", h(async (req) => one(await askUsage(req.storeId!))));
  r.get("/ask/conversations", h(async (req) => ({ data: await listConversations(req.storeId!) })));
  r.post("/ask/conversations", h(async (req) => one(await createConversation(req.storeId!, req.body ?? {})), { status: 201 }));
  r.delete("/ask/conversations", h(async (req) => one(await deleteAllConversations(req.storeId!))));
  r.get("/ask/conversations/:id", h(async (req) => one(await getConversation(req.storeId!, idParam(req)))));
  r.patch("/ask/conversations/:id", h(async (req) => one(await renameConversation(req.storeId!, idParam(req), req.body ?? {}))));
  r.delete("/ask/conversations/:id", h(async (req) => one(await deleteConversation(req.storeId!, idParam(req)))));
  r.post("/ask/conversations/:id/messages", h(async (req) => {
    const b = req.body ?? {};
    onlyFields(b, ["text"]);
    return one(await ask({ storeId: req.storeId!, channel: "app" }, idParam(req), strField(b, "text", { required: true, max: 4000 })!));
  }));
  /** One-shot question: {"question": "...", "conversation_id"?: n}. Starts a conversation when none is given. */
  r.post("/ask", h(async (req) => {
    const b = req.body ?? {};
    onlyFields(b, ["question", "conversation_id"]);
    const question = strField(b, "question", { required: true, max: 4000 })!;
    const convId = intField(b, "conversation_id", { min: 1 }) ?? (await createConversation(req.storeId!, {})).id;
    return one(await ask({ storeId: req.storeId!, channel: "app" }, convId, question));
  }));

  /* ---------- WhatsApp ---------- */
  r.get("/whatsapp", h(async (req) => one(await whatsappStatus(req.storeId!))));
  r.post("/whatsapp/link-codes", h(async (req) => one(await createLinkCode(req.storeId!)), { status: 201 }));
  r.get("/whatsapp/numbers", h(async (req) => ({ data: await listNumbers(req.storeId!) })));
  r.patch("/whatsapp/numbers/:id", h(async (req) => one(await updateNumber(req.storeId!, idParam(req), req.body ?? {}))));
  r.delete("/whatsapp/numbers/:id", h(async (req) => one(await disconnectNumber(req.storeId!, idParam(req)))));
  r.get("/whatsapp/activity", h(async (req) => ({ data: await listActivity(req.storeId!, intQuery(req, "limit", { min: 1, max: 200 }) ?? 50) })));

  /**
   * Try the assistant without Meta: {"from": "+919876543210", "text": "hi"} or
   * {"from": ..., "reply_id": "m:reorder"} (the id of a tapped button or list row).
   * The number must be connected to this store, except for a "link 123456" message.
   * Returns the replies as they would be sent, plus the Cloud API payloads.
   */
  r.post("/whatsapp/simulate", h(async (req) => {
    const b = req.body ?? {};
    onlyFields(b, ["from", "text", "reply_id"]);
    const from = normalisePhone(strField(b, "from", { required: true, max: 30 })!);
    const text = strField(b, "text", { max: 4000 }) ?? undefined;
    const replyId = strField(b, "reply_id", { max: 256 }) ?? undefined;
    if (!text && !replyId) throw invalid("missing_field", "Send text or reply_id.", "text");
    const isLink = /^link\s+\d{6}$/i.test(text ?? "");
    if (isLink) {
      const code = await queryOne("SELECT store_id FROM whatsapp_link_codes WHERE code=$1", [text!.replace(/\D/g, "")]);
      if (code && Number(code.store_id) !== req.storeId) throw invalid("wrong_store", "That link code belongs to another store.", "text");
    } else {
      const n = await queryOne("SELECT store_id FROM whatsapp_numbers WHERE phone=$1", [from]);
      if (!n || Number(n.store_id) !== req.storeId) throw invalid("not_connected", "That number is not connected to this store. Send \"link <code>\" from it first.", "from");
    }
    const replies = await handleMessage(from, { text, id: replyId });
    return one({ replies, cloud_api_payloads: replies.map((m) => toGraphPayload(from, m)) });
  }));
}
