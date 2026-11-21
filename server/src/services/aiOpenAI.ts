/**
 * OpenAI as the AI behind Ask StockSense (and AI answers on WhatsApp).
 *
 * Chat Completions with tool calling: the assistant message with
 * tool_calls goes back unchanged, then one {"role":"tool"} message per
 * call with its tool_call_id. GPT-6 Astra and GPT-6.x Sol only do tool
 * calling on the Responses API, so the defaults are models that support
 * it on Chat Completions.
 *
 * OPENAI_API_KEY turns it on; OPENAI_MODEL picks the model, otherwise the
 * first default that answers is used.
 */
import { config } from "../config";
import { ApiError } from "./errors";
import type { PriorTurn, ToolDef } from "./aiGemini";

const URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODELS = ["gpt-6-luna", "gpt-6.1-terra", "gpt-5.4-mini", "gpt-5-mini"];
let workingModel: string | null = null;

export const openaiConfigured = () => !!config.openai.apiKey;
export const openaiModel = () => config.openai.model || workingModel || DEFAULT_MODELS[0];

/** Non-strict function tools accept ordinary JSON Schema, so the Claude schemas pass as they are. */
function tools(defs: ToolDef[]) {
  return defs.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }));
}

async function call(body: any): Promise<any> {
  const models = config.openai.model ? [config.openai.model] : workingModel ? [workingModel] : DEFAULT_MODELS;
  let lastErr: ApiError | null = null;
  for (const model of models) {
    let res: Response;
    try {
      res = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.openai.apiKey}` },
        body: JSON.stringify({ ...body, model }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e: any) {
      throw new ApiError(502, "api_error", "ai_error", `Could not reach OpenAI (${e?.name === "TimeoutError" ? "timed out" : "network error"}). Try again.`);
    }
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (res.ok) {
      if (!config.openai.model) workingModel = model;
      return data;
    }
    const err = data?.error ?? {};
    const msg: string = err.message || `HTTP ${res.status}`;
    // Model missing for this key, retired, or without tool calling here: try the next one.
    if (res.status === 404 || err.code === "model_not_found" || /does not exist|not supported|do not have access|not available|Responses API/i.test(msg)) {
      lastErr = new ApiError(502, "api_error", "ai_model_unavailable", `OpenAI model ${model} is not available: ${msg}`);
      continue;
    }
    if (res.status === 401) throw new ApiError(503, "api_error", "ai_not_configured", "OpenAI rejected the server's OPENAI_API_KEY. Check the key in .env.");
    if (res.status === 429) {
      if (err.code === "insufficient_quota" || /quota|billing/i.test(msg)) {
        throw new ApiError(503, "api_error", "ai_quota", "The OpenAI account has no credit left. Add billing at platform.openai.com, then try again.");
      }
      throw new ApiError(503, "api_error", "ai_busy", "OpenAI's rate limit was reached. Try again in a minute.");
    }
    throw new ApiError(502, "api_error", "ai_error", `OpenAI returned an error (${res.status}): ${msg.slice(0, 200)}`);
  }
  throw lastErr ?? new ApiError(502, "api_error", "ai_error", "No OpenAI model was available. Set OPENAI_MODEL in .env.");
}

export async function openaiAnswer(opts: {
  system: string;
  prior: PriorTurn[];
  question: string;
  tools: ToolDef[];
  maxRounds: number;
  runTool: (name: string, args: any) => Promise<string>;
}): Promise<{ answer: string; stop: string | null }> {
  if (!openaiConfigured()) throw new ApiError(503, "api_error", "ai_not_configured", "Ask StockSense needs OPENAI_API_KEY on the server.");

  const messages: any[] = [{ role: "system", content: opts.system }];
  for (const t of opts.prior) messages.push({ role: t.role === "assistant" ? "assistant" : "user", content: t.text });
  messages.push({ role: "user", content: opts.question });
  const toolList = tools(opts.tools);
  let stop: string | null = null;

  for (let round = 0; round < opts.maxRounds; round++) {
    const data = await call({ messages, tools: toolList, tool_choice: "auto", max_completion_tokens: 8000 });
    const choice = data?.choices?.[0];
    if (!choice) return { answer: "I couldn't put an answer together. Try rephrasing the question.", stop: "no_choice" };
    stop = choice.finish_reason ?? null;
    const msg = choice.message ?? { role: "assistant", content: "" };
    if (msg.refusal) return { answer: "I can't help with that one. Ask me about your stock, forecasts, suppliers or orders.", stop: "refusal" };
    if (stop === "content_filter") return { answer: "I can't help with that one. Ask me about your stock, forecasts, suppliers or orders.", stop };

    const calls: any[] = msg.tool_calls ?? [];
    const text = typeof msg.content === "string" ? msg.content.trim() : "";
    if (!calls.length) {
      return { answer: text || (stop === "length" ? "That answer ran too long. Try a narrower question." : ""), stop };
    }
    // The assistant turn goes back as returned, then one tool message per call.
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const c of calls) {
      let out: string;
      try {
        let args: any = {};
        try { args = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { throw new ApiError(400, "invalid_request_error", "bad_arguments", "The tool arguments were not valid JSON."); }
        out = await opts.runTool(c.function?.name, args);
      } catch (e: any) {
        out = JSON.stringify({ error: e instanceof ApiError ? e.message : `Tool failed: ${e?.message ?? e}` });
      }
      messages.push({ role: "tool", tool_call_id: c.id, content: out.slice(0, 60_000) });
    }
    if (round === opts.maxRounds - 1) return { answer: text || "I looked through a lot of data without settling on an answer. Try a narrower question.", stop };
  }
  return { answer: "", stop };
}
