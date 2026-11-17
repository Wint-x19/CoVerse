import { describe, expect, it } from "vitest";
import type { ProtocolEvent } from "@coverse/core";
import { ConversionContext, convertStream, createProtocolRegistry, type ProtocolId } from "../src/index.js";
import { readSse, sse } from "../src/sse.js";

const ids: ProtocolId[] = ["responses", "chat-completions", "anthropic-messages"];
const decoder = new TextDecoder(); const encoder = new TextEncoder();
export async function* chunks(text: string, width = 7): AsyncGenerator<Uint8Array> {
  const bytes = encoder.encode(text); for (let i = 0; i < bytes.length; i += width) yield bytes.slice(i, i + width);
}
async function collect(input: AsyncIterable<Uint8Array>): Promise<string> {
  let result = ""; const d = new TextDecoder(); for await (const bytes of input) result += d.decode(bytes, { stream: true }); return result + d.decode();
}
const frame = (value: unknown, event?: string) => decoder.decode(sse(value, event));
const chatFrame = (delta: unknown, finish: string | null = null, usage?: unknown) => frame({ id: "r", object: "chat.completion.chunk", created: 1, model: "synthetic", choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });
const chatText = chatFrame({ role: "assistant", content: "" }) + chatFrame({ content: "你好🙂" }) + chatFrame({}, "stop") + chatFrame({}, null, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }) + frame("[DONE]");
const anthStart = frame({ type: "message_start", message: { id: "r", type: "message", role: "assistant", model: "synthetic", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }, "message_start");
const anthText = anthStart + frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start") + frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好🙂" } }, "content_block_delta") + frame({ type: "content_block_stop", index: 0 }, "content_block_stop") + frame({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }, "message_delta") + frame({ type: "message_stop" }, "message_stop");
const outputItem = { id: "msg1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "你好🙂", annotations: [] }] };
const responseBase = { id: "r", object: "response", created_at: 1, model: "synthetic", status: "in_progress", output: [] };
const responseText = [
  { type: "response.created", response: responseBase },
  { type: "response.output_item.added", output_index: 0, item: { ...outputItem, status: "in_progress", content: [] } },
  { type: "response.content_part.added", output_index: 0, item_id: "msg1", content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
  { type: "response.output_text.delta", output_index: 0, item_id: "msg1", content_index: 0, delta: "你好🙂" },
  { type: "response.output_text.done", output_index: 0, item_id: "msg1", content_index: 0, text: "你好🙂" },
  { type: "response.content_part.done", output_index: 0, item_id: "msg1", content_index: 0, part: outputItem.content[0] },
  { type: "response.output_item.done", output_index: 0, item: outputItem },
  { type: "response.completed", response: { ...responseBase, status: "completed", output: [outputItem], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
].map(v => frame(v, v.type)).join("");
const samples = { responses: responseText, "chat-completions": chatText, "anthropic-messages": anthText };
async function semantics(text: string, id: ProtocolId): Promise<ProtocolEvent[]> {
  const events: ProtocolEvent[] = [];
  for await (const e of createProtocolRegistry().get(id).decodeStream(chunks(text), new ConversionContext(id, id))) events.push(e);
  return events;
}
describe.each(ids)("%s stream", from => {
  it.each(ids)("preserves text and usage when converted to %s", async to => {
    const result = convertStream({ from, to, input: chunks(samples[from], 1) });
    const text = await collect(result.data); const events = await semantics(text, to);
    expect(events.filter(e => e.type === "delta").map(e => e.text).join("")).toBe("你好🙂");
    expect(events.filter(e => e.type === "usage").at(-1)).toEqual({ type: "usage", usage: { input: 3, output: 2 } });
    expect(events.at(-1)?.type).toBe("end"); expect((await result.completion).status).toBe("completed");
  });
  it("fails on a missing terminal event", async () => {
    const source = samples[from].trimEnd(); const withoutLast = source.slice(0, source.lastIndexOf("\n\n") + 2);
    const result = convertStream({ from, to: "responses", input: chunks(withoutLast) });
    await expect(collect(result.data)).rejects.toMatchObject({ code: "TRUNCATED_STREAM" });
    expect((await result.completion).status).toBe("failed");
  });
});
it("parses comments, multi-line data and CRLF across every byte boundary", async () => {
  const frames = []; const source = ': keepalive\r\nevent: demo\r\ndata: {"text":\r\ndata: "中🙂"}\r\n\r\n';
  for await (const f of readSse(chunks(source, 1), new ConversionContext("a", "b"))) frames.push(f);
  expect(frames).toEqual([{ event: "demo", data: '{"text":\n"中🙂"}' }]);
});
const parallel = chatFrame({ role: "assistant" }) + chatFrame({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "first", arguments: '{"x":' } }, { index: 1, id: "c2", type: "function", function: { name: "second", arguments: '{"y":' } }] }) + chatFrame({ tool_calls: [{ index: 1, function: { arguments: '2}' } }, { index: 0, function: { arguments: '1}' } }] }) + chatFrame({}, "tool_calls") + chatFrame({}, null, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }) + frame("[DONE]");
it.each(ids)("keeps parallel tool identities and arguments through %s", async to => {
  const result = convertStream({ from: "chat-completions", to, input: chunks(parallel, 3) });
  const text = await collect(result.data); const events = await semantics(text, to);
  const calls = events.filter(e => e.type === "block_start");
  expect(calls.map(e => [e.id, e.name])).toEqual([["c1", "first"], ["c2", "second"]]);
  for (const [i, expected] of ['{"x":1}', '{"y":2}'].entries()) expect(events.flatMap(e => e.type === "delta" && e.index === i ? [e.text] : []).join("")).toBe(expected);
  // Exercise each source codec's tool path on the reverse conversion too.
  const back = convertStream({ from: to, to: "chat-completions", input: chunks(text, 2) });
  const roundtrip = await semantics(await collect(back.data), "chat-completions");
  expect(roundtrip.filter(e => e.type === "block_start").map(e => e.id)).toEqual(["c1", "c2"]);
});
it("rejects missing tool indexes and incomplete arguments", async () => {
  await expect(collect(convertStream({ from: "chat-completions", to: "responses", input: chunks(parallel.replace('"index":1,"id":"c2"', '"id":"c2"')) }).data)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(collect(convertStream({ from: "chat-completions", to: "responses", input: chunks(parallel.replace('"arguments":"1}"', '"arguments":"1"')) }).data)).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
});
it("yields before reading the whole source and closes it when the consumer stops", async () => {
  let consumed = 0; let closed = false;
  async function* input() { try { for (const part of [chatFrame({ role: "assistant" }), chatText]) { consumed++; yield encoder.encode(part); } } finally { closed = true; } }
  const result = convertStream({ from: "chat-completions", to: "responses", input: input() });
  for await (const _ of result.data) break;
  expect(consumed).toBe(1); expect(closed).toBe(true); expect((await result.completion).status).toBe("cancelled");
});
it("aborts a pending read and requests upstream closure", async () => {
  const controller = new AbortController(); let returned = false;
  const input: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => { returned = true; return { done: true, value: undefined }; } }; } };
  const result = convertStream({ from: "chat-completions", to: "responses", input, options: { signal: controller.signal } });
  const pending = collect(result.data); controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" }); expect(returned).toBe(true);
  expect((await result.completion).status).toBe("cancelled");
});
it("rejects source error events and changed final content", async () => {
  await expect(collect(convertStream({ from: "anthropic-messages", to: "responses", input: chunks(anthStart + frame({ type: "error", error: { type: "overloaded_error" } })) }).data)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  // Explicitly mutate only the completion's copy of the response text.
  const split = responseText.lastIndexOf('event: response.completed');
  const changed = responseText.slice(0, split) + responseText.slice(split).replace("你好🙂", "wrong");
  await expect(collect(convertStream({ from: "responses", to: "chat-completions", input: chunks(changed) }).data)).rejects.toMatchObject({ code: "INVALID_EVENT_ORDER" });
});
it("does not silently choose multiple stream candidates", async () => {
  const source = chatText.replace('"index":0', '"index":1');
  await expect(collect(convertStream({ from: "chat-completions", to: "responses", input: chunks(source) }).data)).rejects.toMatchObject({ code: "LOSS_NOT_ALLOWED" });
});
it("rejects content after finish, malformed UTF-8, and unknown semantic events", async () => {
  const source = chatFrame({ content: "x" }, "stop") + chatFrame({ content: "late" }) + frame("[DONE]");
  await expect(collect(convertStream({ from: "chat-completions", to: "responses", input: chunks(source) }).data)).rejects.toMatchObject({ code: "INVALID_EVENT_ORDER" });
  async function* invalid() { yield new Uint8Array([0xff]); }
  await expect(collect(convertStream({ from: "chat-completions", to: "responses", input: invalid() }).data)).rejects.toMatchObject({ code: "INVALID_SSE" });
  await expect(collect(convertStream({ from: "anthropic-messages", to: "responses", input: chunks(anthStart + frame({ type: "future_event" })) }).data)).rejects.toMatchObject({ code: "UNSUPPORTED_EVENT" });
});
const thinking = anthStart + frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }) + frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "visible" } }) + frame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "synthetic-signature" } }) + frame({ type: "content_block_stop", index: 0 }) + frame({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }) + frame({ type: "message_stop" });
it("preserves same-provider signed thinking and audits cross-provider rendering", async () => {
  const native = await collect(convertStream({ from: "anthropic-messages", to: "anthropic-messages", input: chunks(thinking) }).data);
  expect((await semantics(native, "anthropic-messages")).some(e => e.type === "reasoning_state" && e.value === "synthetic-signature")).toBe(true);
  await expect(collect(convertStream({ from: "anthropic-messages", to: "responses", input: chunks(thinking) }).data)).rejects.toMatchObject({ code: "LOSS_NOT_ALLOWED" });
  const rendered = convertStream({ from: "anthropic-messages", to: "responses", input: chunks(thinking), options: { policy: "allow-loss", reasoningAsText: true } });
  const output = await collect(rendered.data);
  expect(output).toContain("visible"); expect(output).not.toContain("synthetic-signature");
  expect(rendered.report.preserved.some(v => v.value === "synthetic-signature")).toBe(true);
});
it("handles Responses reasoning summary events and preserves encrypted state", async () => {
  const item = { id: "rs1", type: "reasoning", summary: [{ type: "summary_text", text: "visible" }], encrypted_content: "synthetic-ciphertext" };
  const input = [
    { type: "response.created", response: responseBase },
    { type: "response.output_item.added", output_index: 0, item: { id: "rs1", type: "reasoning", summary: [] } },
    { type: "response.reasoning_summary_part.added", output_index: 0, item_id: "rs1", summary_index: 0, part: { type: "summary_text", text: "" } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs1", summary_index: 0, delta: "visible" },
    { type: "response.reasoning_summary_text.done", output_index: 0, item_id: "rs1", summary_index: 0, text: "visible" },
    { type: "response.reasoning_summary_part.done", output_index: 0, item_id: "rs1", summary_index: 0, part: item.summary[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...responseBase, status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
  ].map(v => frame(v, v.type)).join("");
  const native = await collect(convertStream({ from: "responses", to: "responses", input: chunks(input) }).data);
  expect((await semantics(native, "responses")).some(e => e.type === "reasoning_state" && e.value === "synthetic-ciphertext")).toBe(true);
  const rendered = await collect(convertStream({ from: "responses", to: "chat-completions", input: chunks(input), options: { policy: "allow-loss", reasoningAsText: true } }).data);
  expect(rendered).toContain("visible"); expect(rendered).not.toContain("synthetic-ciphertext");
});
