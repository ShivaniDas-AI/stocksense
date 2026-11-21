/**
 * Google Gemini as the AI behind Ask StockSense (and AI answers on WhatsApp).
 *
 * REST generateContent with function calling. The model's turns are sent
 * back exactly as received, because Gemini 3+ puts a thoughtSignature on
 * function-call parts and rejects a follow-up request without it. Tool
 * results go back as a user turn of functionResponse parts carrying the
 * call's id.
 *
 * GEMINI_API_KEY (or GOOGLE_API_KEY) turns it on; GEMINI_MODEL picks the
 * model, otherwise the first stable Flash model that answers is used.
 */
import { config } from "../config";
import { ApiError } from "./errors";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
/** Tried in order until one exists for this key; the winner is remembered. */
const DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"];
let workingModel: string | null = null;

export const geminiConfigured = () => !!config.gemini.apiKey;
export const geminiModel = () => config.gemini.model || workingModel || DEFAULT_MODELS[0];

export interface ToolDef { name: string; description?: string; input_schema: any }
export interface PriorTurn { role: "user" | "assistant"; text: string }

/**
 * Gemini takes an OpenAPI subset of JSON Schema: no additionalProperties,
 * no type arrays like ["integer","null"], and an object must list at least
 * one property (a tool without inputs simply has no parameters).
 */
export function toGeminiSchema(s: any): any {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== "object") return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "additionalProperties" || k === "$schema" || k === "default" || k === "examples") continue;
    if (k === "type" && Array.isArray(v)) {
      out.type = (v as string[]).find((t) => t !== "null") ?? "string";
      if ((v as string[]).includes("null")) out.nullable = true;
      continue;
    }
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
      continue;
    }
    out[k] = toGeminiSchema(v);
  }
  return out;
}

function declarations(tools: ToolDef[]) {
  return tools.map((t) => {
    const params = toGeminiSchema(t.input_schema);
    const hasProps = params?.properties && Object.keys(params.properties).length > 0;
    return { name: t.name, description: t.description ?? "", ...(hasProps ? { parameters: params } : {}) };
  });
}

async function call(body: any): Promise<any> {
  const models = config.gemini.model ? [config.gemini.model] : workingModel ? [workingModel] : DEFAULT_MODELS;
  let lastErr: ApiError | null = null;
  for (const model of models) {
    let res: Response;
    try {
      res = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.gemini.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e: any) {
      throw new ApiError(502, "api_error", "ai_error", `Could not reach Gemini (${e?.name === "TimeoutError" ? "timed out" : "network error"}). Try again.`);
    }
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (res.ok) {
      if (!config.gemini.model) workingModel = model;
      return data;
    }
    const msg: string = data?.error?.message || `HTTP ${res.status}`;
    // Model not available for this key or retired: try the next one.
    if (res.status === 404 || /not found|is not supported|no longer available/i.test(msg)) {
      lastErr = new ApiError(502, "api_error", "ai_model_unavailable", `Gemini model ${model} is not available: ${msg}`);
      continue;
    }
    if (res.status === 400 && /api key/i.test(msg)) throw new ApiError(503, "api_error", "ai_not_configured", "The server's GEMINI_API_KEY was rejected by Google. Check the key in .env.");
    if (res.status === 401 || res.status === 403) throw new ApiError(503, "api_error", "ai_not_configured", `Google refused the GEMINI_API_KEY (${msg}).`);
    if (res.status === 429) throw new ApiError(503, "api_error", "ai_busy", "Gemini's rate limit or free quota was reached. Try again in a minute.");
    throw new ApiError(502, "api_error", "ai_error", `Gemini returned an error (${res.status}): ${msg.slice(0, 200)}`);
  }
  throw lastErr ?? new ApiError(502, "api_error", "ai_error", "No Gemini model was available. Set GEMINI_MODEL in .env.");
}

/**
 * One question through the tool loop. runTool returns the tool's output as
 * text (usually JSON); the final model text is the answer.
 */
export async function geminiAnswer(opts: {
  system: string;
  prior: PriorTurn[];
  question: string;
  tools: ToolDef[];
  maxRounds: number;
  runTool: (name: string, args: any) => Promise<string>;
}): Promise<{ answer: string; stop: string | null }> {
  if (!geminiConfigured()) throw new ApiError(503, "api_error", "ai_not_configured", "Ask StockSense needs GEMINI_API_KEY on the server.");

  // History as plain text turns; Gemini wants user/model alternating, so merge repeats.
  const contents: any[] = [];
  for (const t of [...opts.prior, { role: "user" as const, text: opts.question }]) {
    const role = t.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text: t.text });
    else contents.push({ role, parts: [{ text: t.text }] });
  }
  if (contents[0]?.role === "model") contents.shift();

  const tools = [{ functionDeclarations: declarations(opts.tools) }];
  let stop: string | null = null;

  for (let round = 0; round < opts.maxRounds; round++) {
    const data = await call({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents,
      tools,
      generationConfig: { maxOutputTokens: 8192 },
    });
    const cand = data?.candidates?.[0];
    if (!cand) {
      const reason = data?.promptFeedback?.blockReason;
      return { answer: reason ? "I can't help with that one. Ask me about your stock, forecasts, suppliers or orders." : "I couldn't put an answer together. Try rephrasing the question.", stop: reason ?? "no_candidate" };
    }
    stop = cand.finishReason ?? null;
    if (stop === "SAFETY" || stop === "PROHIBITED_CONTENT" || stop === "BLOCKLIST" || stop === "SPII") {
      return { answer: "I can't help with that one. Ask me about your stock, forecasts, suppliers or orders.", stop };
    }
    const content = cand.content ?? { role: "model", parts: [] };
    if (!content.role) content.role = "model";
    // Unchanged, so thoughtSignature parts go back exactly as received.
    contents.push(content);

    const parts: any[] = content.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("").trim();
    if (!calls.length) {
      return { answer: text || (stop === "MAX_TOKENS" ? "That answer ran too long. Try a narrower question." : ""), stop };
    }

    const responses = [];
    for (const p of calls) {
      const fc = p.functionCall;
      let response: any;
      try {
        const out = await opts.runTool(fc.name, fc.args ?? {});
        let parsed: any = out;
        try { parsed = JSON.parse(out); } catch { /* plain text result */ }
        response = { result: parsed };
      } catch (e: any) {
        response = { error: e instanceof ApiError ? e.message : `Tool failed: ${e?.message ?? e}` };
      }
      responses.push({ functionResponse: { name: fc.name, response, ...(fc.id ? { id: fc.id } : {}) } });
    }
    contents.push({ role: "user", parts: responses });
    if (round === opts.maxRounds - 1) return { answer: text || "I looked through a lot of data without settling on an answer. Try a narrower question.", stop };
  }
  return { answer: "", stop };
}
