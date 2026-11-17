import { describe, expect, it } from "vitest";
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
