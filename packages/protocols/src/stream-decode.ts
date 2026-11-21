import { parseWireJson, stringifyWireJson } from "@coverse/core";
import type { JsonValue, ProtocolEvent } from "@coverse/core";
import { ConversionContext, type ProtocolId } from "./contracts.js";
import { decodeResponse, decodeUsage, finishFrom } from "./responses.js";
import { array, fields, literal, nonempty, number, object, string, type Obj } from "./validation.js";
import { readSse, sse, type SseFrame } from "./sse.js";
import { StreamState } from "./stream-state.js";

export function decodeStream(input: AsyncIterable<Uint8Array>, id: ProtocolId, c: ConversionContext): AsyncGenerator<ProtocolEvent>;
export function decodeStream(input: AsyncIterable<Uint8Array>, id: "responses", c: ConversionContext, replay: true): AsyncGenerator<Uint8Array>;
export async function* decodeStream(input: AsyncIterable<Uint8Array>, id: ProtocolId, c: ConversionContext, replay = false): AsyncGenerator<ProtocolEvent | Uint8Array> {
  const state = new StreamState(c);
  const chatTools = new Map<number, number>(); let chatText: number | undefined;
  let messageCount = 0;
  const items = new Map<number, { id: string; type: string; blocks: Map<number, number>; done: boolean }>();
  const textDone = new Set<number>(); const partDone = new Set<number>(); let nextBlock = 0; let sequence = -1;
  function* emit(events: ProtocolEvent[], frame: SseFrame) {
    for (const e of events) { state.accept(e); if (!replay) yield e; }
    if (replay) yield sse(frame.data.replaceAll("\n", "\ndata: "), frame.event === "message" ? undefined : frame.event);
  }
  for await (const frame of readSse(input, c)) {
    if (frame.data === "[DONE]") {
      if (id !== "chat-completions") c.fail("INVALID_EVENT_ORDER", "/stream", "Unexpected DONE marker");
      yield* emit([{ type: "end" }], frame); continue;
    }
    let parsed: unknown; try { parsed = parseWireJson(frame.data); } catch { c.fail("INVALID_SSE", "/stream", "Event data must be valid JSON"); }
    const o = object(parsed, c, "/stream");
    if (state.ended) c.fail("INVALID_EVENT_ORDER", "/stream", "Event after terminal event");
    if (o.error !== undefined || o.type === "error" || o.type === "response.failed") { c.preserve("/stream/error", o, "Upstream error"); c.fail("UPSTREAM_ERROR", "/stream", "Upstream reported an error"); }
    if (id !== "chat-completions" && frame.event !== "message" && frame.event !== o.type) c.fail("INVALID_SSE", "/stream", "SSE event and JSON type disagree");
    const events: ProtocolEvent[] = [];
    if (id === "chat-completions") {
      fields(o, ["id", "object", "created", "model", "choices", "usage"], c, "/stream");
      literal(o.object, ["chat.completion.chunk"], c, "/stream/object");
      const responseId = nonempty(o.id, c, "/stream/id"); const model = nonempty(o.model, c, "/stream/model");
      if (!state.started) events.push({ type: "start", id: responseId, model });
      else if (state.id !== responseId || state.model !== model) c.fail("INVALID_EVENT_ORDER", "/stream", "Response identity changed mid-stream");
      if (o.created !== undefined) { number(o.created, c, "/stream/created"); if (!state.started) c.preserve("/stream/created", o.created, "Source wire timestamp"); }
      if (o.usage != null) events.push({ type: "usage", usage: decodeUsage(o.usage, id, c) });
      const choices = array(o.choices, c, "/stream/choices");
      for (const v of choices) {
        const choice = object(v, c, "/stream/choices"); fields(choice, ["index", "delta", "finish_reason", "logprobs"], c, "/stream/choice");
        const index = number(choice.index, c, "/stream/choice/index");
        if (!Number.isSafeInteger(index) || index < 0) c.fail("INVALID_INPUT", "/stream/choice/index", "Invalid candidate index");
        const selected = c.options.candidateIndex ?? 0;
        if (index !== selected) {
          c.preserve(`/choices/${index}`, choice, "Unselected candidate stream fragment");
          c.loss("dropped", "CANDIDATE_SELECTION", `/choices/${index}`, "Multiple stream candidates require explicit selection", c.options.candidateIndex !== undefined); continue;
        }
        if (choice.logprobs != null) c.unsupported("/stream/choice/logprobs", choice.logprobs, "Log probabilities are not portable");
        const delta = object(choice.delta, c, "/stream/delta"); fields(delta, ["role", "content", "tool_calls"], c, "/stream/delta");
        if (delta.role !== undefined) literal(delta.role, ["assistant"], c, "/stream/delta/role");
        if (delta.content != null) {
          const text = string(delta.content, c, "/stream/delta/content");
          if (text.length) {
            if (chatTools.size) c.fail("UNSUPPORTED_CAPABILITY", "/stream/delta/content", "Text after tool calls cannot preserve Chat message ordering");
            if (chatText === undefined) { chatText = nextBlock++; events.push({ type: "block_start", index: chatText, kind: "text" }); }
            events.push({ type: "delta", index: chatText, text });
          }
        }
        if (delta.tool_calls !== undefined) for (const v of array(delta.tool_calls, c, "/stream/delta/tool_calls")) {
          const t = object(v, c, "/stream/tool_call"); fields(t, ["index", "id", "type", "function"], c, "/stream/tool_call");
          const toolIndex = number(t.index, c, "/stream/tool_call/index");
          if (!Number.isSafeInteger(toolIndex) || toolIndex < 0) c.fail("INVALID_INPUT", "/stream/tool_call/index", "Missing or invalid tool index");
          if (t.type !== undefined) literal(t.type, ["function"], c, "/stream/tool_call/type");
          const f = object(t.function, c, "/stream/tool_call/function"); fields(f, ["name", "arguments"], c, "/stream/tool_call/function");
          let block = chatTools.get(toolIndex);
          if (block === undefined) {
            block = nextBlock++; chatTools.set(toolIndex, block);
            events.push({ type: "block_start", index: block, kind: "tool_call", id: nonempty(t.id, c, "/stream/tool_call/id"), name: nonempty(f.name, c, "/stream/tool_call/name") });
          } else {
            const old = state.blocks.get(block) ?? events.find((e): e is Extract<ProtocolEvent, { type: "block_start" }> => e.type === "block_start" && e.index === block);
            if (!old || t.id !== undefined && t.id !== old.id || f.name !== undefined && f.name !== old.name) c.fail("INVALID_TOOL_LINK", "/stream/tool_call", "Tool identity changed mid-stream");
          }
          if (f.arguments !== undefined) events.push({ type: "delta", index: block, text: string(f.arguments, c, "/stream/tool_call/arguments") });
        }
        if (choice.finish_reason != null) {
          const open = new Set([...state.blocks.values()].filter(b => !b.ended).map(b => b.index));
          for (const e of events) if (e.type === "block_start") open.add(e.index);
          for (const index of open) events.push({ type: "block_end", index });
          events.push({ type: "finish", reason: finishFrom(choice.finish_reason, id, c, "/stream/finish_reason") });
        }
      }
    } else if (id === "anthropic-messages") {
      const type = nonempty(o.type, c, "/stream/type");
      if (type === "ping") { fields(o, ["type"], c, "/stream"); continue; }
      if (type === "message_start") {
        fields(o, ["type", "message"], c, "/stream");
        const m = object(o.message, c, "/stream/message"); fields(m, ["id", "type", "role", "model", "content", "stop_reason", "stop_sequence", "usage"], c, "/stream/message");
        literal(m.type, ["message"], c, "/stream/message/type"); literal(m.role, ["assistant"], c, "/stream/message/role");
        if (array(m.content, c, "/stream/message/content").length || m.stop_reason != null || m.stop_sequence != null) c.fail("INVALID_EVENT_ORDER", "/stream/message", "Message start must not contain completed content");
        events.push({ type: "start", id: nonempty(m.id, c, "/stream/message/id"), model: nonempty(m.model, c, "/stream/message/model") }, { type: "usage", usage: decodeUsage(m.usage, id, c) });
      } else if (type === "content_block_start") {
        fields(o, ["type", "index", "content_block"], c, "/stream");
        const index = number(o.index, c, "/stream/index"); const b = object(o.content_block, c, "/stream/content_block");
        if (b.type === "text" || b.type === "thinking") {
          fields(b, b.type === "text" ? ["type", "text"] : ["type", "thinking", "signature"], c, "/stream/content_block"); events.push({ type: "block_start", index, kind: b.type === "text" ? "text" : "reasoning" });
          const text = string(b.type === "text" ? b.text : b.thinking, c, "/stream/content_block/text"); if (text) events.push({ type: "delta", index, text });
          if (b.signature !== undefined) events.push({ type: "reasoning_state", index, source: id, value: string(b.signature, c, "/stream/content_block/signature") });
        } else if (b.type === "tool_use") {
          fields(b, ["type", "id", "name", "input"], c, "/stream/content_block");
          if (Object.keys(object(b.input, c, "/stream/content_block/input")).length) c.fail("UNSUPPORTED_CAPABILITY", "/stream/content_block/input", "M1 expects streamed tool input to start as an empty object");
          events.push({ type: "block_start", index, kind: "tool_call", id: nonempty(b.id, c, "/stream/content_block/id"), name: nonempty(b.name, c, "/stream/content_block/name") });
        } else {
          c.preserve("/stream/content_block", b, "Unsupported stream content");
          c.fail("UNSUPPORTED_CAPABILITY", "/stream/content_block", "Unverified content block type");
        }
      } else if (type === "content_block_delta") {
        fields(o, ["type", "index", "delta"], c, "/stream"); const index = number(o.index, c, "/stream/index"); const d = object(o.delta, c, "/stream/delta");
        const b = state.blocks.get(index);
        if (d.type === "text_delta" && b?.kind === "text") { fields(d, ["type", "text"], c, "/stream/delta"); events.push({ type: "delta", index, text: string(d.text, c, "/stream/delta/text") }); }
        else if (d.type === "input_json_delta" && b?.kind === "tool_call") { fields(d, ["type", "partial_json"], c, "/stream/delta"); events.push({ type: "delta", index, text: string(d.partial_json, c, "/stream/delta/partial_json") }); }
        else if (d.type === "thinking_delta" && b?.kind === "reasoning") { fields(d, ["type", "thinking"], c, "/stream/delta"); events.push({ type: "delta", index, text: string(d.thinking, c, "/stream/delta/thinking") }); }
        else if (d.type === "signature_delta" && b?.kind === "reasoning") { fields(d, ["type", "signature"], c, "/stream/delta"); events.push({ type: "reasoning_state", index, source: id, value: string(d.signature, c, "/stream/delta/signature") }); }
        else c.fail("INVALID_EVENT_ORDER", "/stream/delta", "Delta type does not match its open block");
      } else if (type === "content_block_stop") {
        fields(o, ["type", "index"], c, "/stream"); const index = number(o.index, c, "/stream/index");
        const block = state.blocks.get(index);
        if (block?.kind === "reasoning" && !block.opaque?.value) c.fail("INVALID_INPUT", "/stream/signature", "Completed Anthropic thinking requires its signature");
        // The start event already declared an empty object; zero deltas retain it.
        if (block?.kind === "tool_call" && block.text === "") events.push({ type: "delta", index, text: "{}" });
        events.push({ type: "block_end", index });
      } else if (type === "message_delta") {
        fields(o, ["type", "delta", "usage"], c, "/stream"); const d = object(o.delta, c, "/stream/delta"); fields(d, ["stop_reason", "stop_sequence"], c, "/stream/delta");
        if (d.stop_sequence != null) c.unsupported("/stream/delta/stop_sequence", d.stop_sequence, "Matched stop sequence is not portable");
        events.push({ type: "usage", usage: decodeUsage(o.usage, id, c) }, { type: "finish", reason: finishFrom(d.stop_reason, id, c, "/stream/stop_reason") });
      } else if (type === "message_stop") { fields(o, ["type"], c, "/stream"); events.push({ type: "end" }); }
      else { c.preserve("/stream", o, "Unknown event"); c.fail("UNSUPPORTED_EVENT", "/stream/type", `Unknown event: ${type}`); }
    } else {
      const type = nonempty(o.type, c, "/stream/type");
      if (o.sequence_number !== undefined) { const n = number(o.sequence_number, c, "/stream/sequence_number"); if (!Number.isSafeInteger(n) || n <= sequence) c.fail("INVALID_EVENT_ORDER", "/stream/sequence_number", "Sequence numbers must increase"); sequence = n; }
      const envelope = ["type", "sequence_number"];
      if (type === "response.created" || type === "response.in_progress") {
        fields(o, [...envelope, "response"], c, "/stream"); const r = object(o.response, c, "/stream/response");
        fields(r, ["id", "model", "object", "created_at", "status", "output", "error", "incomplete_details", "usage"], c, "/stream/response");
        literal(r.status, ["in_progress"], c, "/stream/response/status");
        if (r.error != null || r.incomplete_details != null || array(r.output, c, "/stream/response/output").length) c.fail("INVALID_EVENT_ORDER", "/stream/response", "Unexpected content at response start");
        const responseId = nonempty(r.id, c, "/stream/response/id"); const model = nonempty(r.model, c, "/stream/response/model");
        if (type === "response.created") events.push({ type: "start", id: responseId, model });
        else if (!state.started || state.id !== responseId || state.model !== model || state.blocks.size) c.fail("INVALID_EVENT_ORDER", "/stream", "Invalid in-progress event");
        if (r.usage != null) events.push({ type: "usage", usage: decodeUsage(r.usage, id, c) });
        if (type === "response.created") c.preserve("/stream/response", r, "Source response metadata");
      } else if (type === "response.output_item.added") {
        fields(o, [...envelope, "output_index", "item"], c, "/stream"); const index = number(o.output_index, c, "/stream/output_index");
        if (!state.started || state.finished || !Number.isSafeInteger(index) || index < 0 || items.has(index)) c.fail("INVALID_EVENT_ORDER", "/stream/output_index", "Invalid output item start");
        const item = object(o.item, c, "/stream/item"); const itemId = nonempty(item.id, c, "/stream/item/id");
        if ([...items.values()].some(v => v.id === itemId)) c.fail("INVALID_EVENT_ORDER", "/stream/item/id", "Duplicate item ID");
        if (item.status !== undefined) literal(item.status, ["in_progress"], c, "/stream/item/status");
        const entry = { id: itemId, type: string(item.type, c, "/stream/item/type"), blocks: new Map<number, number>(), done: false }; items.set(index, entry);
        if (item.type === "function_call") {
          fields(item, ["type", "id", "call_id", "name", "arguments", "status"], c, "/stream/item");
          const block = nextBlock++; entry.blocks.set(0, block);
          events.push({ type: "block_start", index: block, kind: "tool_call", id: nonempty(item.call_id, c, "/stream/item/call_id"), name: nonempty(item.name, c, "/stream/item/name") });
          const text = string(item.arguments, c, "/stream/item/arguments"); if (text) events.push({ type: "delta", index: block, text });
        } else if (item.type === "message") {
          if (++messageCount > 1 && c.target !== "responses") c.loss("downgraded", "MESSAGE_BOUNDARIES_MERGED",
            `/output/${index}`, "Separate assistant messages share one target response message", c.options.allowMessageMerge);
          fields(item, ["type", "id", "role", "content", "status"], c, "/stream/item"); literal(item.role, ["assistant"], c, "/stream/item/role");
          if (array(item.content, c, "/stream/item/content").length) c.fail("INVALID_EVENT_ORDER", "/stream/item/content", "Streamed message must begin empty");
        } else if (item.type === "reasoning") {
          fields(item, ["type", "id", "summary", "status"], c, "/stream/item");
          if (array(item.summary, c, "/stream/item/summary").length) c.fail("INVALID_EVENT_ORDER", "/stream/item/summary", "Reasoning item must begin empty");
        } else c.fail("UNSUPPORTED_EVENT", "/stream/item/type", "Unverified output item");
      } else if (type === "response.completed" || type === "response.incomplete") {
        fields(o, [...envelope, "response"], c, "/stream");
        if ([...items.values()].some(item => !item.done)) c.fail("INVALID_EVENT_ORDER", "/stream", "Response completed before output items");
        // Validate final content as its source protocol; reasoning is bridged later.
        const finalContext = new ConversionContext(id, id, c.options);
        const r = decodeResponse(o.response, id, finalContext);
        c.report.preserved.push(...finalContext.report.preserved);
        for (const category of ["dropped", "downgraded", "approximated"] as const) c.report.ledger[category].push(...finalContext.report.ledger[category]);
        if (r.id !== state.id || r.model !== state.model) c.fail("INVALID_EVENT_ORDER", "/stream", "Final response identity mismatch");
        const raw = object(o.response, c, "/stream/response"); literal(raw.status, [type === "response.completed" ? "completed" : "incomplete"], c, "/stream/response/status");
        const final = r.candidates[0]!;
        const finalItems = array(raw.output, c, "/stream/response/output");
        if (finalItems.length !== items.size || finalItems.some((v, i) => {
          const item = items.get(i), wire = object(v, c, `/stream/response/output/${i}`);
          return !item || item.id !== wire.id || item.type !== wire.type ||
            (item.type === "message" && item.blocks.size !== array(wire.content, c, "/stream/response/output/content").length);
        })) c.fail("INVALID_EVENT_ORDER", "/stream/response/output", "Final output item boundaries disagree with the stream");
        const actual = [...state.blocks.values()].map(b => b.kind === "tool_call" ? { type: "tool_call", id: b.id, name: b.name, arguments: parseWireJson(b.text) } : b.kind === "reasoning" ? { type: "reasoning", text: b.text, encrypted: b.opaque?.value ?? null } : { type: "text", text: b.text });
        const expected = final.content.map(b => b.type === "tool_call" ? { type: "tool_call", id: b.id, name: b.name, arguments: b.arguments } : b.type === "opaque" ? { type: "reasoning", text: ((b.value as Obj).summary as Obj[]).map(s => s.text).join(""), encrypted: (b.value as Obj).encrypted_content ?? null } : b);
        if (stringifyWireJson(actual) !== stringifyWireJson(expected)) c.fail("INVALID_EVENT_ORDER", "/stream/response/output", "Final output disagrees with streamed content");
        events.push({ type: "usage", usage: r.usage }, { type: "finish", reason: final.finish }, { type: "end" });
      } else {
        const index = number(o.output_index, c, "/stream/output_index"); const item = items.get(index);
        if (!item || item.done || o.item_id !== undefined && o.item_id !== item.id) c.fail("INVALID_EVENT_ORDER", "/stream", "Event refers to an unknown or closed item");
        const partIndex = o.content_index === undefined && o.summary_index === undefined ? 0 : number(o.content_index ?? o.summary_index, c, "/stream/content_index");
        if (type === "response.content_part.added" || type === "response.reasoning_summary_part.added") {
          const reasoning = type === "response.reasoning_summary_part.added";
          fields(o, [...envelope, "item_id", "output_index", reasoning ? "summary_index" : "content_index", "part"], c, "/stream");
          if (item.type !== (reasoning ? "reasoning" : "message") || item.blocks.has(partIndex) || !Number.isSafeInteger(partIndex) || partIndex < 0 || reasoning && item.blocks.size > 0) c.fail("INVALID_EVENT_ORDER", "/stream", "Invalid content part; M1 supports one summary part per reasoning item");
          const part = object(o.part, c, "/stream/part"); fields(part, ["type", "text", "annotations"], c, "/stream/part"); literal(part.type, [reasoning ? "summary_text" : "output_text"], c, "/stream/part/type");
          if (part.annotations !== undefined && array(part.annotations, c, "/stream/part/annotations").length) c.unsupported("/stream/part/annotations", part.annotations, "Annotations are not portable");
          const block = nextBlock++; item.blocks.set(partIndex, block); events.push({ type: "block_start", index: block, kind: reasoning ? "reasoning" : "text" });
          const text = string(part.text, c, "/stream/part/text"); if (text) events.push({ type: "delta", index: block, text });
        } else if (type === "response.output_item.done") {
          fields(o, [...envelope, "output_index", "item"], c, "/stream"); const done = object(o.item, c, "/stream/item");
          literal(done.id, [item.id], c, "/stream/item/id"); literal(done.type, [item.type], c, "/stream/item/type"); if (done.status !== undefined) literal(done.status, ["completed"], c, "/stream/item/status");
          if (item.type === "reasoning") {
            fields(done, ["id", "type", "status", "summary", "encrypted_content"], c, "/stream/item");
            const block = item.blocks.values().next().value as number | undefined;
            if (block === undefined || !textDone.has(block) || !partDone.has(block)) c.fail("INVALID_EVENT_ORDER", "/stream/item", "Reasoning must have a completed summary");
            const summaries = array(done.summary, c, "/stream/item/summary");
            if (summaries.length !== 1) c.fail("UNSUPPORTED_CAPABILITY", "/stream/item/summary", "M1 supports one reasoning summary per item");
            const summary = object(summaries[0], c, "/stream/item/summary/0"); fields(summary, ["type", "text"], c, "/stream/item/summary/0"); literal(summary.type, ["summary_text"], c, "/stream/item/summary/0/type");
            if (summary.text !== state.blocks.get(block)!.text) c.fail("INVALID_EVENT_ORDER", "/stream/item/summary", "Reasoning summary mismatch");
            if (done.encrypted_content !== undefined) events.push({ type: "reasoning_state", index: block, source: id, value: string(done.encrypted_content, c, "/stream/item/encrypted_content") });
            events.push({ type: "block_end", index: block }); item.done = true;
            yield* emit(events, frame); continue;
          }
          const decoded = decodeResponse({ id: state.id, model: state.model, status: "completed", output: [done] }, id, c).candidates[0]!.content;
          const actual = [...item.blocks.values()].map(i => state.blocks.get(i)!);
          if (actual.some(b => !b.ended) || decoded.length !== actual.length || decoded.some((b, i) => b.type === "text" ? b.text !== actual[i]!.text : b.type === "tool_call" ? b.id !== actual[i]!.id || b.name !== actual[i]!.name || b.argumentsText !== actual[i]!.text : true)) c.fail("INVALID_EVENT_ORDER", "/stream/item", "Completed item disagrees with deltas");
          item.done = true;
        } else {
          const block = item.blocks.get(partIndex); if (block === undefined) c.fail("INVALID_EVENT_ORDER", "/stream", "Delta before content start");
          const b = state.blocks.get(block)!;
          if (["response.output_text.delta", "response.function_call_arguments.delta", "response.reasoning_summary_text.delta"].includes(type)) {
            fields(o, [...envelope, "item_id", "output_index", "content_index", "summary_index", "delta"], c, "/stream");
            if (textDone.has(block) || (type === "response.output_text.delta" ? b.kind !== "text" : type === "response.reasoning_summary_text.delta" ? b.kind !== "reasoning" : b.kind !== "tool_call")) c.fail("INVALID_EVENT_ORDER", "/stream", "Delta type/order mismatch");
            events.push({ type: "delta", index: block, text: string(o.delta, c, "/stream/delta") });
          } else if (["response.output_text.done", "response.function_call_arguments.done", "response.reasoning_summary_text.done"].includes(type)) {
            fields(o, [...envelope, "item_id", "output_index", "content_index", "summary_index", "text", "arguments", "name"], c, "/stream");
            if (textDone.has(block) || (type === "response.output_text.done" ? b.kind !== "text" : type === "response.reasoning_summary_text.done" ? b.kind !== "reasoning" : b.kind !== "tool_call")) c.fail("INVALID_EVENT_ORDER", "/stream", "Duplicate or mismatched done event");
            if (string(b.kind !== "tool_call" ? o.text : o.arguments, c, "/stream/text") !== b.text || o.name !== undefined && o.name !== b.name) c.fail("INVALID_EVENT_ORDER", "/stream", "Final text disagrees with deltas");
            textDone.add(block); if (b.kind === "tool_call") events.push({ type: "block_end", index: block });
          } else if (type === "response.content_part.done" || type === "response.reasoning_summary_part.done") {
            const reasoning = type === "response.reasoning_summary_part.done";
            fields(o, [...envelope, "item_id", "output_index", "content_index", "summary_index", "part"], c, "/stream");
            const part = object(o.part, c, "/stream/part"); fields(part, ["type", "text", "annotations"], c, "/stream/part"); literal(part.type, [reasoning ? "summary_text" : "output_text"], c, "/stream/part/type");
            if (part.annotations !== undefined && array(part.annotations, c, "/stream/part/annotations").length) c.unsupported("/stream/part/annotations", part.annotations, "Annotations are not portable");
            if (!textDone.has(block) || part.text !== b.text) c.fail("INVALID_EVENT_ORDER", "/stream/part", "Part done without matching text done");
            if (partDone.has(block)) c.fail("INVALID_EVENT_ORDER", "/stream/part", "Duplicate part done");
            partDone.add(block);
            if (!reasoning) events.push({ type: "block_end", index: block });
          } else { c.preserve("/stream", o, "Unknown event"); c.fail("UNSUPPORTED_EVENT", "/stream/type", `Unknown event: ${type}`); }
        }
      }
    }
    yield* emit(events, frame);
  }
  state.ensureEnd();
}
