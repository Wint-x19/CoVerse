import { parseWireJson, stringifyWireJson } from "@coverse/core";
import type { ContentBlock, JsonValue, Turn } from "@coverse/core";
import { ConversionContext, type ProtocolId } from "./contracts.js";
import { array, boolean, fields, jsonArguments, literal, nonempty, object, string, type Obj } from "./validation.js";

function call(id: unknown, name: unknown, args: unknown, c: ConversionContext, p: string): ContentBlock {
  return { type: "tool_call", id: nonempty(id, c, p + "/id"), name: nonempty(name, c, p + "/name"), ...jsonArguments(args, c, p + "/arguments") };
}
export function decodeContent(value: unknown, protocol: ProtocolId, c: ConversionContext, p: string): ContentBlock[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return array(value, c, p).flatMap((v, i): ContentBlock[] => {
    const path = `${p}/${i}`; const b = object(v, c, path);
    const allowed = protocol === "responses" ? ["input_text", "output_text", "input_image"] : protocol === "chat-completions" ? ["text", "image_url"] : ["text", "image", "tool_use", "tool_result", "thinking"];
    if (!allowed.includes(String(b.type))) { c.unsupported(path, v, "Unverified content block for this source protocol"); return []; }
    if (["text", "input_text", "output_text"].includes(String(b.type))) {
      fields(b, ["type", "text", "annotations"], c, path);
      if (b.annotations !== undefined && array(b.annotations, c, path + "/annotations").length) c.unsupported(path + "/annotations", b.annotations, "Annotations are not portable");
      return [{ type: "text", text: string(b.text, c, path + "/text") }];
    }
    if (b.type === "image_url" || b.type === "input_image" || b.type === "image") {
      fields(b, b.type === "image" ? ["type", "source"] : ["type", "image_url", "detail"], c, path);
      let url: string; let detail: string | undefined;
      if (b.type === "image") {
        const s = object(b.source, c, path + "/source");
        if (s.type === "url") { fields(s, ["type", "url"], c, path + "/source"); url = nonempty(s.url, c, path + "/source/url"); }
        else { literal(s.type, ["base64"], c, path + "/source/type"); fields(s, ["type", "media_type", "data"], c, path + "/source"); url = `data:${nonempty(s.media_type, c, path + "/source/media_type")};base64,${nonempty(s.data, c, path + "/source/data")}`; }
      } else if (b.type === "image_url") {
        const s = object(b.image_url, c, path + "/image_url"); fields(s, ["url", "detail"], c, path + "/image_url");
        url = nonempty(s.url, c, path + "/image_url/url"); if (s.detail !== undefined) detail = string(s.detail, c, path + "/image_url/detail");
      } else { url = nonempty(b.image_url, c, path + "/image_url"); if (b.detail !== undefined) detail = string(b.detail, c, path + "/detail"); }
      if (!/^(https?:\/\/|data:image\/[a-zA-Z0-9.+-]+;base64,)/.test(url)) c.fail("INVALID_INPUT", path, "Only HTTP(S) or inline image URLs are supported");
      if (detail !== undefined) literal(detail, ["auto", "low", "high"], c, path + "/detail");
      return [{ type: "image", url, ...(detail !== undefined ? { detail } : {}) }];
    }
    if (protocol === "anthropic-messages" && b.type === "tool_use") {
      fields(b, ["type", "id", "name", "input"], c, path); object(b.input, c, path + "/input");
      return [call(b.id, b.name, stringifyWireJson(b.input), c, path)];
    }
    if (protocol === "anthropic-messages" && b.type === "tool_result") {
      fields(b, ["type", "tool_use_id", "content", "is_error"], c, path);
      if (typeof b.content !== "string") { c.unsupported(path + "/content", b.content ?? null, "Only text tool results are supported in M1"); return []; }
      return [{ type: "tool_result", callId: nonempty(b.tool_use_id, c, path + "/tool_use_id"), content: b.content, ...(b.is_error !== undefined ? { isError: boolean(b.is_error, c, path + "/is_error") } : {}) }];
    }
    if (protocol === "anthropic-messages" && b.type === "thinking") {
      fields(b, ["type", "thinking", "signature"], c, path);
      string(b.thinking, c, path + "/thinking");
      nonempty(b.signature, c, path + "/signature");
      if (c.source === c.target) return [{ type: "opaque", source: protocol, value: b }];
      c.preserve(path, b, "Signed thinking cannot be replayed by another provider");
      c.loss("downgraded", "REASONING_AS_TEXT", path, "Thinking is rendered as visible text; signature is not portable", c.options.reasoningAsText);
      return [{ type: "text", text: b.thinking as string }];
    }
    c.unsupported(path, v, "Unverified content block"); return [];
  });
}
export function decodeMessages(body: Obj, protocol: ProtocolId, c: ConversionContext, paths?: string[]): Turn[] {
  const messages: Turn[] = [];
  const add = (role: Turn["role"], content: ContentBlock[]) => messages.push({ id: `m${messages.length}`, role, content });
  if (protocol === "responses") {
    if (body.instructions !== undefined && body.instructions !== null) add("system", [{ type: "text", text: string(body.instructions, c, "/instructions") }]);
    if (typeof body.input === "string") add("user", [{ type: "text", text: body.input }]);
    else array(body.input, c, "/input").forEach((v, i) => {
      const p = paths?.[i] ?? `/input/${i}`; const o = object(v, c, p);
      if (o.type === "function_call") {
        fields(o, ["type", "call_id", "name", "arguments", "id", "status"], c, p);
        wireMetadata(o, c, p); add("assistant", [call(o.call_id, o.name, o.arguments, c, p)]);
      } else if (o.type === "function_call_output") {
        fields(o, ["type", "call_id", "output", "id", "status"], c, p); wireMetadata(o, c, p);
        add("tool", [{ type: "tool_result", callId: nonempty(o.call_id, c, p + "/call_id"), content: string(o.output, c, p + "/output") }]);
      } else if (o.type === "reasoning") {
        add("assistant", decodeReasoning(o, c, p));
      } else if (o.type === "compaction") {
        fields(o, ["type", "id", "encrypted_content"], c, p);
        if (o.id !== undefined) nonempty(o.id, c, p + "/id");
        nonempty(o.encrypted_content, c, p + "/encrypted_content");
        add("assistant", [{ type: "opaque", source: "responses", value: o }]);
      } else {
        fields(o, ["type", "role", "content", "id", "status"], c, p); wireMetadata(o, c, p);
        if (o.type !== undefined) literal(o.type, ["message"], c, p + "/type");
        literal(o.role, ["system", "developer", "user", "assistant"], c, p + "/role");
        add(o.role as Turn["role"], decodeContent(o.content, protocol, c, p + "/content"));
      }
    });
  } else {
    if (protocol === "anthropic-messages" && body.system !== undefined) add("system", decodeContent(body.system, protocol, c, "/system"));
    array(body.messages, c, "/messages").forEach((v, i) => {
      const p = paths?.[i] ?? `/messages/${i}`; const m = object(v, c, p);
      fields(m, protocol === "chat-completions" ? ["role", "content", "tool_calls", "tool_call_id"] : ["role", "content"], c, p);
      literal(m.role, protocol === "chat-completions" ? ["system", "developer", "user", "assistant", "tool"] : ["user", "assistant"], c, p + "/role");
      if (m.role === "tool") {
        add("tool", [{ type: "tool_result", callId: nonempty(m.tool_call_id, c, p + "/tool_call_id"), content: string(m.content, c, p + "/content") }]); return;
      }
      const content = protocol === "chat-completions" && m.content == null && m.role === "assistant" && (m.content === null || m.tool_calls !== undefined) ? [] : decodeContent(m.content, protocol, c, p + "/content");
      if (m.tool_calls !== undefined) {
        if (m.role !== "assistant") c.fail("INVALID_INPUT", p, "Only assistant messages may call tools");
        for (const [j, v] of array(m.tool_calls, c, p + "/tool_calls").entries()) {
          const q = `${p}/tool_calls/${j}`; const t = object(v, c, q); fields(t, ["id", "type", "function"], c, q); literal(t.type, ["function"], c, q + "/type");
          const f = object(t.function, c, q + "/function"); fields(f, ["name", "arguments"], c, q + "/function"); content.push(call(t.id, f.name, f.arguments, c, q));
        }
      }
      add(m.role as Turn["role"], content);
    });
  }
  return messages;
}
/** Wire-only identifiers are preserved in the report; they are not conversation text. */
export function wireMetadata(o: Obj, c: ConversionContext, p: string): void {
  for (const k of ["id", "status"]) if (o[k] !== undefined) {
    string(o[k], c, `${p}/${k}`); c.preserve(`${p}/${k}`, o[k]!, "Wire item metadata; source identity retained in report");
    if (k === "status") literal(o[k], ["completed"], c, `${p}/${k}`);
  }
}
export function decodeReasoning(o: Obj, c: ConversionContext, p: string): ContentBlock[] {
  fields(o, ["type", "id", "summary", "encrypted_content", "status"], c, p); wireMetadata(o, c, p);
  if (o.encrypted_content !== undefined) string(o.encrypted_content, c, p + "/encrypted_content");
  const summary = array(o.summary, c, p + "/summary").map((v, i) => {
    const s = object(v, c, `${p}/summary/${i}`); fields(s, ["type", "text"], c, `${p}/summary/${i}`); literal(s.type, ["summary_text"], c, p);
    return { type: "text" as const, text: string(s.text, c, p + "/summary/text") };
  });
  if (c.source === c.target) return [{ type: "opaque", source: c.source, value: o }];
  c.preserve(p, o, "Reasoning state and summaries are provider-specific");
  c.loss("downgraded", "REASONING_AS_TEXT", p, "Reasoning summaries rendered as visible text; opaque state retained only in report", c.options.reasoningAsText);
  return summary;
}
export function encodeBlock(b: ContentBlock, protocol: ProtocolId, c: ConversionContext, p: string, role: string): JsonValue {
  if (b.type === "text") return { type: protocol === "responses" ? (role === "assistant" ? "output_text" : "input_text") : "text", text: b.text };
  if (b.type === "image") {
    if (role !== "user") c.fail("UNSUPPORTED_CAPABILITY", p, "M1 supports images only in user messages");
    if (protocol === "chat-completions") return { type: "image_url", image_url: { url: b.url, ...(b.detail ? { detail: b.detail } : {}) } };
    if (protocol === "responses") return { type: "input_image", image_url: b.url, ...(b.detail ? { detail: b.detail } : {}) };
    if (b.detail !== undefined) c.unsupported(p + "/detail", b.detail, "Anthropic does not expose OpenAI image detail semantics");
    const match = /^data:([^;]+);base64,(.*)$/.exec(b.url);
    return { type: "image", source: match ? { type: "base64", media_type: match[1]!, data: match[2]! } : { type: "url", url: b.url } };
  }
  if (b.type === "opaque" && b.source === protocol) return b.value;
  if (b.type === "reasoning") {
    c.preserve(p, b as unknown as JsonValue, "Reasoning text");
    c.loss("downgraded", "REASONING_AS_TEXT", p, "Reasoning rendered as visible text", c.options.reasoningAsText);
    return encodeBlock({ type: "text", text: b.text }, protocol, c, p, role);
  }
  return c.fail("UNSUPPORTED_CAPABILITY", p, "Content cannot be encoded by this target");
}
export function argumentsText(b: Extract<ContentBlock, { type: "tool_call" }>): string {
  if (b.argumentsText !== undefined) {
    try { if (stringifyWireJson(parseWireJson(b.argumentsText)) === stringifyWireJson(b.arguments)) return b.argumentsText; } catch { /* Edited invalid original is never replayed. */ }
  }
  return stringifyWireJson(b.arguments);
}
export function encodeMessages(messages: readonly Turn[], protocol: ProtocolId, c: ConversionContext): Obj {
  const output: JsonValue[] = []; const system: JsonValue[] = []; let sawConversation = false;
  for (const [i, original] of messages.entries()) {
    const p = `/messages/${i}`;
    // A caller can decode for archival first, edit IR, and choose another target later.
    const m = { ...original, content: original.content.flatMap((b, j) => {
      if (b.type !== "opaque" || b.source === protocol) return [b];
      const q = `${p}/content/${j}`; const raw = object(b.value, c, q);
      if (b.source === "responses" && raw.type === "reasoning") return decodeReasoning(raw, c, q);
      if (b.source === "responses" && raw.type === "compaction") {
        return c.fail("UNPORTABLE_COMPACTION", q, "Target cannot read this Responses compaction item. A source-provided readable window is required");
      }
      if (b.source === "anthropic-messages" && raw.type === "thinking") return decodeContent([raw], "anthropic-messages", c, q);
      return c.fail("UNSUPPORTED_CAPABILITY", q, "Opaque state is not portable to the selected target");
    }) };
    if (protocol === "anthropic-messages" && ["system", "developer"].includes(m.role)) {
      if (m.role === "developer" || sawConversation || system.length) c.loss("downgraded", "ROLE_MERGE", p, "Instruction roles/order merged into Anthropic system", c.options.allowRoleMerge);
      system.push(...m.content.map((b, j) => encodeBlock(b, protocol, c, `${p}/content/${j}`, "system"))); continue;
    }
    sawConversation = true;
    if (protocol === "responses") {
      let parts: JsonValue[] = [];
      const flush = () => { if (parts.length) { output.push({ type: "message", role: m.role, content: parts }); parts = []; } };
      for (const [j, b] of m.content.entries()) {
        if (b.type === "tool_call") { flush(); output.push({ type: "function_call", call_id: b.id, name: b.name, arguments: argumentsText(b) }); }
        else if (b.type === "tool_result") { flush(); if (b.isError) c.unsupported(`${p}/content/${j}/isError`, true, "Tool error flag has no Responses equivalent"); output.push({ type: "function_call_output", call_id: b.callId, output: b.content }); }
        else if (b.type === "opaque" && b.source === protocol) { flush(); output.push(b.value); }
        else parts.push(encodeBlock(b, protocol, c, `${p}/content/${j}`, m.role));
      }
      flush();
      if (!m.content.length) output.push({ type: "message", role: m.role, content: [] });
    } else if (protocol === "anthropic-messages") {
      const content = m.content.map((b, j): JsonValue => {
        if (b.type === "tool_call") return { type: "tool_use", id: b.id, name: b.name, input: b.arguments };
        if (b.type === "tool_result") return { type: "tool_result", tool_use_id: b.callId, content: b.content, ...(b.isError !== undefined ? { is_error: b.isError } : {}) };
        return encodeBlock(b, protocol, c, `${p}/content/${j}`, m.role);
      });
      output.push({ role: m.role === "tool" ? "user" : m.role, content });
    } else {
      let content: JsonValue[] = []; let calls: JsonValue[] = []; let called = false;
      for (const [j, b] of m.content.entries()) {
        if (b.type === "tool_result") {
          if (m.content.length !== 1 && m.role !== "tool") c.fail("UNSUPPORTED_CAPABILITY", p, "Mixed user text and tool results require an explicit restructuring policy");
          if (b.isError) c.unsupported(`${p}/content/${j}/isError`, true, "Chat has no tool error flag");
          output.push({ role: "tool", tool_call_id: b.callId, content: b.content }); continue;
        }
        if (b.type === "tool_call") { called = true; calls.push({ id: b.id, type: "function", function: { name: b.name, arguments: argumentsText(b) } }); }
        else { if (called) c.fail("UNSUPPORTED_CAPABILITY", p, "Chat cannot preserve text after a tool call within one message"); content.push(encodeBlock(b, protocol, c, `${p}/content/${j}`, m.role)); }
      }
      if (content.length || calls.length || !m.content.length) output.push({ role: m.role, content: content.length ? content : null, ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  return protocol === "responses" ? { input: output } : { messages: output, ...(system.length ? { system } : {}) };
}
