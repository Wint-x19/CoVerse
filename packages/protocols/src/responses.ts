import type { ContentBlock, JsonValue, ProtocolResponse, ProtocolUsage } from "@coverse/core";
import { ConversionContext, type ProtocolId } from "./contracts.js";
import { decodeContent, decodeMessages, decodeReasoning, encodeMessages, wireMetadata } from "./messages.js";
import { array, fields, literal, nonempty, number, object, string, type Obj } from "./validation.js";

export function decodeUsage(value: unknown, id: ProtocolId, c: ConversionContext, p = "/usage"): ProtocolUsage {
  if (value === undefined || value === null) return {};
  const u = object(value, c, p); const result: ProtocolUsage = {};
  const map: Record<string, keyof ProtocolUsage> = id === "chat-completions" ? { prompt_tokens: "input", completion_tokens: "output" } : { input_tokens: "input", output_tokens: "output", ...(id === "anthropic-messages" ? { cache_read_input_tokens: "cachedInput", cache_creation_input_tokens: "cacheWrite" } as const : {}) };
  fields(u, [...Object.keys(map), ...(id === "anthropic-messages" ? [] : ["total_tokens", id === "chat-completions" ? "prompt_tokens_details" : "input_tokens_details", id === "chat-completions" ? "completion_tokens_details" : "output_tokens_details"])], c, p);
  const count = (v: unknown, path: string) => { const n = number(v, c, path); if (!Number.isSafeInteger(n) || n < 0) c.fail("INVALID_INPUT", path, "Invalid token count"); return n; };
  for (const [key, field] of Object.entries(map)) if (u[key] !== undefined) result[field] = count(u[key], `${p}/${key}`);
  if (id !== "anthropic-messages") {
    const inputKey = id === "chat-completions" ? "prompt_tokens_details" : "input_tokens_details";
    const outputKey = id === "chat-completions" ? "completion_tokens_details" : "output_tokens_details";
    if (u[inputKey] != null) { const d = object(u[inputKey], c, `${p}/${inputKey}`); fields(d, ["cached_tokens"], c, `${p}/${inputKey}`); if (d.cached_tokens !== undefined) result.cachedInput = count(d.cached_tokens, `${p}/${inputKey}/cached_tokens`); }
    if (u[outputKey] != null) { const d = object(u[outputKey], c, `${p}/${outputKey}`); fields(d, ["reasoning_tokens"], c, `${p}/${outputKey}`); if (d.reasoning_tokens !== undefined) result.reasoning = count(d.reasoning_tokens, `${p}/${outputKey}/reasoning_tokens`); }
    if (u.total_tokens !== undefined && count(u.total_tokens, p + "/total_tokens") !== (result.input ?? 0) + (result.output ?? 0)) c.fail("INVALID_INPUT", p + "/total_tokens", "Inconsistent usage total");
  } else if (result.input !== undefined) result.input += (result.cachedInput ?? 0) + (result.cacheWrite ?? 0);
  if (result.cachedInput !== undefined && result.input !== undefined && result.cachedInput > result.input) c.fail("INVALID_INPUT", p, "Cached tokens exceed input tokens");
  return result;
}
export function encodeUsage(u: ProtocolUsage, id: ProtocolId, c: ConversionContext): Obj {
  const o: Obj = {};
  if (id === "anthropic-messages") {
    if (u.reasoning !== undefined) c.unsupported("/usage/reasoning", u.reasoning, "Anthropic usage has no portable reasoning counter");
    if (u.input !== undefined) o.input_tokens = u.input - (u.cachedInput ?? 0) - (u.cacheWrite ?? 0);
    if (u.output !== undefined) o.output_tokens = u.output;
    if (u.cachedInput !== undefined) o.cache_read_input_tokens = u.cachedInput;
    if (u.cacheWrite !== undefined) o.cache_creation_input_tokens = u.cacheWrite;
  } else {
    if (u.cacheWrite !== undefined) c.unsupported("/usage/cacheWrite", u.cacheWrite, "Target has no verified cache-write counter");
    if (u.input !== undefined) o[id === "chat-completions" ? "prompt_tokens" : "input_tokens"] = u.input;
    if (u.output !== undefined) o[id === "chat-completions" ? "completion_tokens" : "output_tokens"] = u.output;
    if (u.input !== undefined && u.output !== undefined) o.total_tokens = u.input + u.output;
    if (u.cachedInput !== undefined) o[id === "chat-completions" ? "prompt_tokens_details" : "input_tokens_details"] = { cached_tokens: u.cachedInput };
    if (u.reasoning !== undefined) o[id === "chat-completions" ? "completion_tokens_details" : "output_tokens_details"] = { reasoning_tokens: u.reasoning };
  }
  return o;
}
export function finishFrom(value: unknown, id: ProtocolId, c: ConversionContext, p: string): string {
  const mappings: Record<string, string> = id === "anthropic-messages" ? { end_turn: "stop", max_tokens: "length", tool_use: "tool_calls", stop_sequence: "stop_sequence", refusal: "refusal" } : { stop: "stop", length: "length", tool_calls: "tool_calls", content_filter: "refusal" };
  const v = string(value, c, p); if (!mappings[v]) c.fail("UNSUPPORTED_CAPABILITY", p, `Unverified finish reason: ${v}`); return mappings[v]!;
}
export function finishTo(value: string, id: ProtocolId, c: ConversionContext): string {
  const map: Record<string, string> = id === "anthropic-messages" ? { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", stop_sequence: "stop_sequence", refusal: "refusal" } : { stop: "stop", length: "length", tool_calls: "tool_calls", refusal: "content_filter" };
  if (!map[value]) c.fail("UNSUPPORTED_CAPABILITY", "/finish", `Finish reason cannot be represented: ${value}`); return map[value]!;
}
export function decodeResponse(input: unknown, id: ProtocolId, c: ConversionContext): ProtocolResponse {
  const o = object(input, c, "/");
  fields(o, ["id", "model", "usage", ...(id === "chat-completions" ? ["object", "created", "choices"] : id === "responses" ? ["object", "created_at", "output", "status", "error", "incomplete_details"] : ["type", "role", "content", "stop_reason", "stop_sequence"])], c, "");
  if (o.object !== undefined) literal(o.object, [id === "responses" ? "response" : "chat.completion"], c, "/object");
  for (const key of ["created", "created_at"]) if (o[key] !== undefined) { number(o[key], c, `/${key}`); c.preserve(`/${key}`, o[key]!, "Source timestamp retained in report"); }
  const r: ProtocolResponse = { schemaVersion: "1.0", id: nonempty(o.id, c, "/id"), model: nonempty(o.model, c, "/model"), candidates: [], usage: decodeUsage(o.usage, id, c) };
  if (o.created !== undefined || o.created_at !== undefined) r.createdAt = number(o.created ?? o.created_at, c, "/created");
  if (id === "chat-completions") {
    r.candidates = array(o.choices, c, "/choices").map((v, i) => {
      const p = `/choices/${i}`; const choice = object(v, c, p); fields(choice, ["index", "message", "finish_reason", "logprobs"], c, p);
      if (choice.logprobs != null) c.unsupported(p + "/logprobs", choice.logprobs, "Log probabilities are not portable");
      const index = number(choice.index, c, p + "/index"); if (!Number.isSafeInteger(index) || index < 0) c.fail("INVALID_INPUT", p + "/index", "Invalid candidate index");
      const m = object(choice.message, c, p + "/message"); literal(m.role, ["assistant"], c, p + "/message/role");
      const messages = decodeMessages({ messages: [m] }, id, c, [p + "/message"]);
      return { index, content: messages[0]!.content, finish: finishFrom(choice.finish_reason, id, c, p + "/finish_reason") };
    });
    if (!r.candidates.length || new Set(r.candidates.map(v => v.index)).size !== r.candidates.length) c.fail("INVALID_INPUT", "/choices", "Empty or duplicate candidates");
  } else if (id === "anthropic-messages") {
    literal(o.type, ["message"], c, "/type"); literal(o.role, ["assistant"], c, "/role");
    if (o.stop_sequence != null) c.unsupported("/stop_sequence", o.stop_sequence, "Matched stop sequence is not modeled in M1");
    r.candidates = [{ index: 0, content: decodeContent(o.content, id, c, "/content"), finish: finishFrom(o.stop_reason, id, c, "/stop_reason") }];
  } else {
    if (o.error != null) c.fail("UPSTREAM_ERROR", "/error", "Source response failed");
    literal(o.status, ["completed", "incomplete"], c, "/status");
    let finish = "stop";
    if (o.status === "incomplete") { const d = object(o.incomplete_details, c, "/incomplete_details"); fields(d, ["reason"], c, "/incomplete_details"); literal(d.reason, ["max_output_tokens", "content_filter"], c, "/incomplete_details/reason"); finish = d.reason === "max_output_tokens" ? "length" : "refusal"; }
    else if (o.incomplete_details != null) c.fail("INVALID_INPUT", "/incomplete_details", "Completed response has incomplete details");
    const content: ContentBlock[] = [];
    array(o.output, c, "/output").forEach((v, i) => {
      const p = `/output/${i}`; const item = object(v, c, p);
      if (item.type === "reasoning") content.push(...decodeReasoning(item, c, p));
      else {
        if (!["message", "function_call"].includes(String(item.type))) { c.unsupported(p, v, "Unverified output item"); return; }
        if (item.type === "message") literal(item.role, ["assistant"], c, p + "/role");
        content.push(...decodeMessages({ input: [item] }, id, c, [p]).flatMap(m => m.content));
      }
    });
    if (finish === "stop" && content.some(b => b.type === "tool_call")) finish = "tool_calls";
    r.candidates = [{ index: 0, content, finish }];
  }
  for (const candidate of r.candidates) {
    const calls = candidate.content.filter(b => b.type === "tool_call");
    if (new Set(calls.map(b => b.id)).size !== calls.length) c.fail("INVALID_TOOL_LINK", "/output", "Duplicate output tool calls");
  }
  return r;
}
export function encodeResponse(r: ProtocolResponse, id: ProtocolId, c: ConversionContext): JsonValue {
  let candidates = r.candidates;
  if (candidates.length !== 1 && id !== "chat-completions" || c.options.candidateIndex !== undefined) {
    const selected = candidates.find(v => v.index === c.options.candidateIndex);
    if (!selected) c.fail("UNSUPPORTED_CAPABILITY", "/candidates", "Explicit candidateIndex is required for a single-candidate target");
    c.preserve("/candidates", candidates as unknown as JsonValue, "Original alternatives");
    c.loss("dropped", "CANDIDATE_SELECTION", "/candidates", "Only the explicitly selected candidate is emitted", true); candidates = [selected];
  }
  const usage = encodeUsage(r.usage, id, c); const model = c.options.targetModel ?? r.model;
  // Zero is an explicit unavailable timestamp sentinel, never wall-clock fabrication.
  if (r.createdAt === undefined && id !== "anthropic-messages") c.preserve("/created", 0, "Generated wire timestamp sentinel: source did not report creation time");
  if (id === "chat-completions") return { id: r.id, object: "chat.completion", created: r.createdAt ?? 0, model, choices: candidates.map(v => {
    const m = encodeMessages([{ id: "output", role: "assistant", content: v.content }], id, c).messages as JsonValue[];
    if (m.length !== 1) c.fail("UNSUPPORTED_CAPABILITY", "/output", "Chat response needs exactly one assistant message");
    return { index: v.index, message: m[0]!, finish_reason: finishTo(v.finish, id, c), logprobs: null };
  }), ...(Object.keys(usage).length ? { usage } : {}) };
  const v = candidates[0]; if (!v) return c.fail("INVALID_INPUT", "/candidates", "Missing candidate");
  if (id === "anthropic-messages") {
    if (r.usage.input === undefined || r.usage.output === undefined) c.fail("MISSING_PARAMETER", "/usage", "Anthropic response requires reported input/output usage");
    const m = encodeMessages([{ id: "output", role: "assistant", content: v.content }], id, c).messages as Obj[];
    return { id: r.id, type: "message", role: "assistant", model, content: m[0]!.content!, stop_reason: finishTo(v.finish, id, c), stop_sequence: null, usage };
  }
  const output = encodeMessages([{ id: "output", role: "assistant", content: v.content }], id, c).input as Obj[];
  output.forEach((item, i) => {
    if (item.id === undefined) item.id = `item_${i}`;
    if (item.type === "message" || item.type === "function_call") item.status = "completed";
    if (item.type === "message") for (const b of item.content as Obj[]) if (b.type === "output_text") b.annotations = [];
  });
  if (!["stop", "tool_calls", "length", "refusal"].includes(v.finish)) c.fail("UNSUPPORTED_CAPABILITY", "/finish", "Unsupported Responses finish reason");
  return { id: r.id, object: "response", created_at: r.createdAt ?? 0, model, status: ["length", "refusal"].includes(v.finish) ? "incomplete" : "completed", output, error: null, incomplete_details: v.finish === "length" ? { reason: "max_output_tokens" } : v.finish === "refusal" ? { reason: "content_filter" } : null, ...(Object.keys(usage).length ? { usage } : {}) };
}
