import { describe, expect, it } from "vitest";
import { parseWireJson, stringifyWireJson } from "@coverse/core";
import { convertRequest, convertResponse, createProtocolRegistry, decodeProtocol, encodeProtocol, type ProtocolId } from "../src/index.js";

const ids: ProtocolId[] = ["responses", "chat-completions", "anthropic-messages"];
const requests = {
  responses: { model: "synthetic", max_output_tokens: 32, input: [{ role: "user", content: "hello" }, { type: "function_call", call_id: "call1", name: "lookup", arguments: '{ "key": 1 }' }, { type: "function_call_output", call_id: "call1", output: "found" }], tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] },
  "chat-completions": { model: "synthetic", max_completion_tokens: 32, messages: [{ role: "user", content: "hello" }, { role: "assistant", content: null, tool_calls: [{ id: "call1", type: "function", function: { name: "lookup", arguments: '{ "key": 1 }' } }] }, { role: "tool", tool_call_id: "call1", content: "found" }], tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }] },
  "anthropic-messages": { model: "synthetic", max_tokens: 32, messages: [{ role: "user", content: "hello" }, { role: "assistant", content: [{ type: "tool_use", id: "call1", name: "lookup", input: { key: 1 } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call1", content: "found" }] }], tools: [{ name: "lookup", input_schema: { type: "object" } }] },
};
const responses = {
  responses: { id: "r", model: "synthetic", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } },
  "chat-completions": { id: "r", model: "synthetic", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  "anthropic-messages": { id: "r", model: "synthetic", type: "message", role: "assistant", content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 } },
};
describe.each(ids)("%s codec", from => {
  it.each(ids)("converts request to %s with linked tools", to => {
    const result = convertRequest({ from, to, input: requests[from] });
    const decoded = decodeProtocol("request", { from: to, to, input: result.data }).value;
    expect(decoded.messages.flatMap(m => m.content).map(b => b.type)).toEqual(["text", "tool_call", "tool_result"]);
    expect(decoded.tools[0]?.name).toBe("lookup");
    expect(decoded.parameters.tokenLimit?.value).toBe(32);
    expect(result.ledger).toEqual({ dropped: [], downgraded: [], approximated: [] });
    if (to === from) expect(result.data).toEqual(requests[from]);
  });
  it.each(ids)("converts response to %s", to => {
    const result = convertResponse({ from, to, input: responses[from] });
    const decoded = decodeProtocol("response", { from: to, to, input: result.data }).value;
    expect(decoded.candidates[0]?.content).toEqual([{ type: "text", text: "hello" }]);
    expect(decoded.usage).toEqual({ input: 3, output: 2 });
    if (to === from) expect(result.data).toEqual(responses[from]);
  });
});
it("refuses unknown fields unless the exact field is explicitly omitted", () => {
  const args = { from: "responses", to: "chat-completions", input: { ...requests.responses, future: { value: 1 } } };
  expect(() => convertRequest(args)).toThrowError(expect.objectContaining({ code: "LOSS_NOT_ALLOWED", path: "/future" }));
  const result = convertRequest({ ...args, options: { policy: "allow-loss", omit: ["/future"] } });
  expect(result.ledger.dropped[0]?.path).toBe("/future");
  expect(result.preserved.some(v => v.path === "/future")).toBe(true);
  expect(result.data).not.toHaveProperty("future");
});
it("does not replay unknown fields even on the same protocol", () => {
  expect(() => convertRequest({ from: "responses", to: "responses", input: { ...requests.responses, future: true } })).toThrow();
});
it("preserves nested integer tool identifiers through Anthropic JSON bytes and back", () => {
  const original = '{"items":[{"id":9007199254740993,"negative":-9007199254740993}],"label":"9007199254740993"}';
  const input = { model: "m", max_output_tokens: 30, input: [
    { type: "function_call", name: "lookup", call_id: "c", arguments: original },
    { type: "function_call_output", call_id: "c", output: "found" },
  ] };
  const wire = stringifyWireJson(convertRequest({ from: "responses", to: "anthropic-messages", input }).data);
  expect(wire).toContain('"id":9007199254740993');
  const back = convertRequest({ from: "anthropic-messages", to: "responses", input: parseWireJson(wire) });
  expect(back.data).toHaveProperty("input.0.arguments", original);
});
it("keeps the editable and one-shot conversion results and reports equivalent", () => {
  const args = { from: "responses", to: "chat-completions", input: { ...requests.responses, extra: "archived" },
    options: { policy: "allow-loss" as const, omit: ["/extra"] } };
  const edited = decodeProtocol("request", args);
  expect(convertRequest(args)).toEqual(encodeProtocol("request", edited, args.to, args.options));
});
it("retains a Responses compaction item on its native wire and diagnoses a foreign target", () => {
  const item = { type: "compaction", id: "cmp", encrypted_content: "synthetic-opaque-window" };
  const input = { model: "m", input: [item, { role: "user", content: "continue" }] };
  expect(convertRequest({ from: "responses", to: "responses", input }).data).toEqual(input);
  expect(() => convertRequest({ from: "responses", to: "chat-completions", input })).toThrowError(expect.objectContaining({ code: "UNPORTABLE_COMPACTION" }));
});
it("does not replay stale originals after editing IR", () => {
  const decoded = decodeProtocol("request", { from: "responses", to: "responses", input: requests.responses });
  decoded.value.messages[0]!.content = [{ type: "text", text: "edited" }];
  expect(JSON.stringify(encodeProtocol("request", decoded, "responses").data)).toContain("edited");
  expect(JSON.stringify(encodeProtocol("request", decoded, "responses").data)).not.toContain("hello");
});
it("requires explicit budgets and rejects invalid tool references", () => {
  expect(() => convertRequest({ from: "responses", to: "anthropic-messages", input: { model: "m", input: "hello" } })).toThrowError(expect.objectContaining({ code: "MISSING_PARAMETER" }));
  expect(convertRequest({ from: "responses", to: "anthropic-messages", input: { model: "m", input: "hello" }, options: { maxOutputTokens: 10 } }).data).toHaveProperty("max_tokens", 10);
  expect(() => convertRequest({ from: "responses", to: "chat-completions", input: { model: "m", input: [{ type: "function_call_output", call_id: "missing", output: "x" }] }, options: { policy: "allow-loss" } })).toThrowError(expect.objectContaining({ code: "INVALID_TOOL_LINK" }));
});
it("rejects malformed arguments rather than repairing them", () => {
  expect(() => convertRequest({ from: "responses", to: "responses", input: { model: "m", input: [{ type: "function_call", call_id: "c", name: "f", arguments: "{" }] } })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENTS" }));
});
it("does not conflate legacy token budgets", () => {
  expect(() => convertRequest({ from: "chat-completions", to: "responses", input: { model: "m", messages: [], max_tokens: 10 } })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
});
it("requires explicit role merge and preserves developer instructions", () => {
  const args = { from: "responses", to: "anthropic-messages", input: { model: "m", input: [{ role: "developer", content: "rules" }], max_output_tokens: 10 } };
  expect(() => convertRequest(args)).toThrow();
  expect(convertRequest({ ...args, options: { policy: "allow-loss", allowRoleMerge: true } }).ledger.downgraded[0]?.code).toBe("ROLE_MERGE");
});
it.each(ids)("converts user images and JSON schemas to %s", to => {
  const input = { model: "m", max_output_tokens: 10, input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/image.png" }] }], text: { format: { type: "json_schema", name: "response", schema: { type: "object" }, strict: true } } };
  const decoded = decodeProtocol("request", { from: to, to, input: convertRequest({ from: "responses", to, input }).data }).value;
  expect(decoded.messages[0]?.content[0]).toEqual({ type: "image", url: "https://example.test/image.png" });
  expect(decoded.parameters.outputFormat?.schema).toEqual({ type: "object" });
});
it("requires explicit candidate selection and accounts for every alternative", () => {
  const input = { ...responses["chat-completions"], choices: [responses["chat-completions"].choices[0], { index: 1, message: { role: "assistant", content: "second" }, finish_reason: "stop" }] };
  expect(() => convertResponse({ from: "chat-completions", to: "responses", input })).toThrow();
  const result = convertResponse({ from: "chat-completions", to: "responses", input, options: { policy: "allow-loss", candidateIndex: 1 } });
  expect(JSON.stringify(result.data)).toContain("second"); expect(result.ledger.dropped[0]?.code).toBe("CANDIDATE_SELECTION");
});
it("does not manufacture usage counts", () => {
  expect(() => convertResponse({ from: "responses", to: "anthropic-messages", input: { ...responses.responses, usage: null } })).toThrowError(expect.objectContaining({ code: "MISSING_PARAMETER" }));
});
it("registers third-party protocols without changing core", () => {
  const registry = createProtocolRegistry(); const existing = registry.get("responses");
  registry.register({ ...existing, id: "community" });
  expect(convertRequest({ from: "community", to: "responses", input: requests.responses, registry }).data).toHaveProperty("input");
});
it("keeps signed thinking in its original protocol and requires explicit cross-provider degradation", () => {
  const input = { ...responses["anthropic-messages"], content: [{ type: "thinking", thinking: "visible summary", signature: "synthetic-signature" }, { type: "text", text: "done" }] };
  expect(convertResponse({ from: "anthropic-messages", to: "anthropic-messages", input }).data).toEqual(input);
  expect(() => convertResponse({ from: "anthropic-messages", to: "responses", input })).toThrow();
  const converted = convertResponse({ from: "anthropic-messages", to: "responses", input, options: { policy: "allow-loss", reasoningAsText: true } });
  expect(JSON.stringify(converted.data)).not.toContain("synthetic-signature");
  expect(converted.ledger.downgraded).toHaveLength(1);
});
it("preserves timestamps across OpenAI formats and invalidates edited argument text", () => {
  const result = convertResponse({ from: "chat-completions", to: "responses", input: { ...responses["chat-completions"], created: 123 } });
  expect(result.data).toHaveProperty("created_at", 123);
  const decoded = decodeProtocol("request", { from: "responses", to: "responses", input: requests.responses });
  const b = decoded.value.messages[1]!.content[0]!;
  if (b.type === "tool_call") b.arguments = { key: 2 };
  expect(JSON.stringify(encodeProtocol("request", decoded, "responses").data)).toContain('key\\\":2');
});
it("supports omitted Chat assistant content when tool_calls are present", () => {
  const source = requests["chat-completions"];
  const { content: _content, ...assistant } = source.messages[1]!;
  const input = { ...source, messages: [source.messages[0], assistant, source.messages[2]] };
  expect(convertRequest({ from: "chat-completions", to: "responses", input }).data).toHaveProperty("input");
});
it("rejects unresolved request calls and edited non-object arguments", () => {
  expect(() => convertRequest({ from: "responses", to: "responses", input: { ...requests.responses, input: requests.responses.input.slice(0, 2) } })).toThrowError(expect.objectContaining({ code: "INVALID_TOOL_LINK" }));
  const decoded = decodeProtocol("request", { from: "responses", to: "responses", input: requests.responses });
  const b = decoded.value.messages[1]!.content[0]!;
  if (b.type === "tool_call") b.arguments = [];
  expect(() => encodeProtocol("request", decoded, "responses")).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
});
it("rejects malformed Anthropic assistant content and unsigned thinking", () => {
  expect(() => convertRequest({ from: "anthropic-messages", to: "anthropic-messages", input: { model: "m", max_tokens: 10, messages: [{ role: "assistant", content: null }] } })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  for (const content of [[{ type: "thinking", thinking: "missing signature" }], [{ type: "tool_result", tool_use_id: "c", content: "result" }]]) {
    expect(() => convertResponse({ from: "anthropic-messages", to: "chat-completions", input: { ...responses["anthropic-messages"], content } })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  }
});
it("cannot erase an existing loss ledger by exporting in strict mode", () => {
  const decoded = decodeProtocol("request", { from: "responses", to: "responses", input: { ...requests.responses, future: 1 }, options: { policy: "allow-loss", omit: ["/future"] } });
  expect(() => encodeProtocol("request", decoded, "responses")).toThrowError(expect.objectContaining({ code: "LOSS_NOT_ALLOWED" }));
});
it("can explicitly render opaque reasoning after decoding for archival", () => {
  const input = { ...responses["anthropic-messages"], content: [{ type: "thinking", thinking: "visible", signature: "synthetic" }] };
  const decoded = decodeProtocol("response", { from: "anthropic-messages", to: "anthropic-messages", input });
  const converted = encodeProtocol("response", decoded, "chat-completions", { policy: "allow-loss", reasoningAsText: true });
  expect(converted.ledger.downgraded).toHaveLength(1);
  expect(JSON.stringify(converted.data)).toContain("visible");
});
it("normalizes cache counts without inventing or silently dropping counters", () => {
  const input = { ...responses["anthropic-messages"], usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 4 } };
  const converted = convertResponse({ from: "anthropic-messages", to: "chat-completions", input });
  expect(converted.data).toHaveProperty("usage.prompt_tokens", 7);
  expect(converted.data).toHaveProperty("usage.prompt_tokens_details.cached_tokens", 4);
  expect(convertResponse({ from: "chat-completions", to: "anthropic-messages", input: converted.data }).data).toHaveProperty("usage.input_tokens", 3);
  expect(() => convertResponse({ from: "anthropic-messages", to: "responses", input: { ...input, usage: { ...input.usage, cache_creation_input_tokens: 1 } } })).toThrowError(expect.objectContaining({ code: "LOSS_NOT_ALLOWED" }));
});
it("preserves Responses message boundaries across editable re-encoding and audits merging", () => {
  const output = ["first", "second"].map(text => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] }));
  const input = { ...responses.responses, output };
  const decoded = decodeProtocol("response", { from: "responses", to: "responses", input });
  decoded.value.candidates[0]!.content[0] = { type: "text", text: "edited" };
  expect(encodeProtocol("response", decoded, "responses").data).toHaveProperty("output.1.content.0.text", "second");
  expect(() => encodeProtocol("response", decoded, "chat-completions")).toThrowError(expect.objectContaining({ code: "LOSS_NOT_ALLOWED" }));
  expect(encodeProtocol("response", decoded, "chat-completions", { policy: "allow-loss", allowMessageMerge: true }).ledger.downgraded[0]?.code).toBe("MESSAGE_BOUNDARIES_MERGED");
});
it("requires a reported approximation for a refusal mapped to a content filter", () => {
  const input = { ...responses["anthropic-messages"], stop_reason: "refusal" };
  for (const to of ["responses", "chat-completions"]) {
    const args = { from: "anthropic-messages", to, input };
    expect(() => convertResponse(args)).toThrowError(expect.objectContaining({ code: "LOSS_NOT_ALLOWED" }));
    expect(convertResponse({ ...args, options: { policy: "allow-loss", allowFinishApproximation: true } }).ledger.approximated[0]?.code).toBe("FINISH_REASON_APPROXIMATED");
  }
});
it.each(ids)("maps incomplete/tool response lifecycle to %s", to => {
  const incomplete = convertResponse({ from: "responses", to, input: { ...responses.responses, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
  expect(decodeProtocol("response", { from: to, to, input: incomplete.data }).value.candidates[0]?.finish).toBe("length");
  const tool = convertResponse({ from: "responses", to, input: { ...responses.responses, output: [{ type: "function_call", call_id: "c", name: "lookup", arguments: '{"x":1}' }] } });
  const result = decodeProtocol("response", { from: to, to, input: tool.data }).value;
  expect(result.candidates[0]?.finish).toBe("tool_calls");
  expect(result.candidates[0]?.content[0]).toMatchObject({ type: "tool_call", id: "c", name: "lookup", arguments: { x: 1 } });
});
