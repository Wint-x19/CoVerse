import { parseWireJson } from "@coverse/core";
import type { JsonValue, ProtocolEvent, ProtocolResponse } from "@coverse/core";
import { ConversionContext, type ProtocolId } from "./contracts.js";
import { encodeResponse, encodeUsage, finishTo } from "./responses.js";
import { StreamState, type BlockState } from "./stream-state.js";
import { sse } from "./sse.js";
import type { Obj } from "./validation.js";

export async function* encodeStream(input: AsyncIterable<ProtocolEvent>, id: ProtocolId, c: ConversionContext): AsyncGenerator<Uint8Array> {
  const state = new StreamState(c); let sequence = 0; let toolCounter = 0;
  const tools = new Map<number, number>(); const wireIndexes = new Map<number, number>();
  let sawTools = false;
  const event = (type: string, body: Obj = {}) => sse({ type, ...(id === "responses" ? { sequence_number: sequence++ } : {}), ...body }, type);
  const chat = (delta: Obj, finish: JsonValue = null, usage?: Obj) => sse({ id: state.id, object: "chat.completion.chunk", created: 0, model: c.options.targetModel ?? state.model, choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });
  const response = (): ProtocolResponse => ({ schemaVersion: "1.0", id: state.id, model: c.options.targetModel ?? state.model, candidates: [{ index: 0, content: [...state.blocks.values()].map(b => b.kind === "tool_call" ? { type: "tool_call", id: b.id!, name: b.name!, arguments: parseWireJson(b.text) as JsonValue, argumentsText: b.text } : b.kind === "reasoning" ? { type: "opaque", source: id, value: item(b, true) } : { type: "text", text: b.text }), finish: state.reason }], usage: state.usage });
  const item = (b: BlockState, done: boolean): Obj => b.kind === "tool_call" ? { type: "function_call", id: `item_${wireIndexes.get(b.index)}`, call_id: b.id!, name: b.name!, arguments: done ? b.text : "", status: done ? "completed" : "in_progress" } : b.kind === "reasoning" ? { type: "reasoning", id: `item_${wireIndexes.get(b.index)}`, summary: done ? [{ type: "summary_text", text: b.text }] : [], ...(done && b.opaque ? { encrypted_content: b.opaque.value } : {}) } : { type: "message", id: `item_${wireIndexes.get(b.index)}`, role: "assistant", status: done ? "completed" : "in_progress", content: done ? [{ type: "output_text", text: b.text, annotations: [] }] : [] };
  for await (const e of input) {
    if (c.options.signal?.aborted) c.fail("CANCELLED", "/stream", "Conversion cancelled");
    state.accept(e);
    if (e.type === "start") {
      if (id === "chat-completions") yield chat({ role: "assistant", content: "" });
      else if (id === "anthropic-messages") yield event("message_start", { message: { id: state.id, type: "message", role: "assistant", model: c.options.targetModel ?? state.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      else {
        const r = { id: state.id, object: "response", created_at: 0, model: c.options.targetModel ?? state.model, status: "in_progress", output: [], error: null, incomplete_details: null };
        yield event("response.created", { response: r }); yield event("response.in_progress", { response: r });
      }
    } else if (e.type === "block_start") {
      wireIndexes.set(e.index, wireIndexes.size);
      if (e.kind === "reasoning" && id === "chat-completions") c.fail("UNSUPPORTED_CAPABILITY", "/stream", "Standard Chat has no reasoning block");
      const b = state.blocks.get(e.index)!; const index = wireIndexes.get(e.index)!;
      if (id === "chat-completions") {
        if (e.kind === "tool_call") { sawTools = true; tools.set(e.index, toolCounter++); yield chat({ tool_calls: [{ index: tools.get(e.index)!, id: e.id!, type: "function", function: { name: e.name!, arguments: "" } }] }); }
        else if (sawTools) c.fail("UNSUPPORTED_CAPABILITY", "/stream", "Text after tool calls cannot preserve Chat message ordering");
      } else if (id === "anthropic-messages") yield event("content_block_start", { index, content_block: e.kind === "tool_call" ? { type: "tool_use", id: e.id!, name: e.name!, input: {} } : e.kind === "reasoning" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" } });
      else {
        yield event("response.output_item.added", { output_index: index, item: item(b, false) });
        if (e.kind === "text") yield event("response.content_part.added", { item_id: `item_${index}`, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        if (e.kind === "reasoning") yield event("response.reasoning_summary_part.added", { item_id: `item_${index}`, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } });
      }
    } else if (e.type === "delta") {
      const b = state.blocks.get(e.index)!; const index = wireIndexes.get(e.index)!;
      if (id === "chat-completions") yield chat(b.kind === "tool_call" ? { tool_calls: [{ index: tools.get(e.index)!, function: { arguments: e.text } }] } : { content: e.text });
      else if (id === "anthropic-messages") yield event("content_block_delta", { index, delta: b.kind === "tool_call" ? { type: "input_json_delta", partial_json: e.text } : b.kind === "reasoning" ? { type: "thinking_delta", thinking: e.text } : { type: "text_delta", text: e.text } });
      else yield event(b.kind === "tool_call" ? "response.function_call_arguments.delta" : b.kind === "reasoning" ? "response.reasoning_summary_text.delta" : "response.output_text.delta", { item_id: `item_${index}`, output_index: index, ...(b.kind === "text" ? { content_index: 0 } : b.kind === "reasoning" ? { summary_index: 0 } : {}), delta: e.text });
    } else if (e.type === "reasoning_state") {
      if (e.source !== id) c.fail("UNSUPPORTED_CAPABILITY", "/stream", "Opaque reasoning cannot cross providers");
      if (id === "anthropic-messages") yield event("content_block_delta", { index: wireIndexes.get(e.index)!, delta: { type: "signature_delta", signature: e.value } });
    } else if (e.type === "block_end") {
      const b = state.blocks.get(e.index)!; const index = wireIndexes.get(e.index)!;
      if (id === "anthropic-messages") yield event("content_block_stop", { index });
      else if (id === "responses") {
        const base = { item_id: `item_${index}`, output_index: index };
        if (b.kind === "tool_call") yield event("response.function_call_arguments.done", { ...base, arguments: b.text });
        else if (b.kind === "reasoning") {
          yield event("response.reasoning_summary_text.done", { ...base, summary_index: 0, text: b.text });
          yield event("response.reasoning_summary_part.done", { ...base, summary_index: 0, part: { type: "summary_text", text: b.text } });
        }
        else {
          yield event("response.output_text.done", { ...base, content_index: 0, text: b.text });
          yield event("response.content_part.done", { ...base, content_index: 0, part: { type: "output_text", text: b.text, annotations: [] } });
        }
        yield event("response.output_item.done", { output_index: index, item: item(b, true) });
      }
    } else if (e.type === "end") {
      if (id === "chat-completions") {
        yield chat({}, finishTo(state.reason, id, c));
        if (Object.keys(state.usage).length) yield chat({}, null, encodeUsage(state.usage, id, c));
        yield sse("[DONE]");
      } else if (id === "anthropic-messages") {
        if (state.usage.input === undefined || state.usage.output === undefined) c.fail("MISSING_PARAMETER", "/usage", "Final Anthropic stream requires measured input/output usage");
        yield event("message_delta", { delta: { stop_reason: finishTo(state.reason, id, c), stop_sequence: null }, usage: encodeUsage(state.usage, id, c) });
        yield event("message_stop");
      } else {
        const r = encodeResponse(response(), id, c) as Obj;
        // Each semantic block is an output item in this streaming encoder.
        r.output = [...state.blocks.values()].map(b => item(b, true));
        yield event(r.status === "completed" ? "response.completed" : "response.incomplete", { response: r });
      }
    }
  }
  state.ensureEnd();
}
