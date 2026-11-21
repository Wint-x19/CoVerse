import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCli, type CliIO } from "../src/index.js";
import { createSandbox, removeSandbox } from "../../../tools/test-helpers.js";

let sandbox: string;
beforeEach(async () => { sandbox = await createSandbox(); });
afterEach(async () => { await removeSandbox(sandbox); });
function transport(text: string) {
  const output: Uint8Array[] = []; const errors: string[] = [];
  const io: CliIO = { stdin: (async function* () { yield new TextEncoder().encode(text); })(), stdout: async bytes => { output.push(bytes); }, stderr: text => { errors.push(text); } };
  return { io, errors, text: () => Buffer.concat(output).toString("utf8") };
}
const command = ["convert-protocol", "--from", "responses", "--to", "chat-completions", "--kind", "request"];
const request = JSON.stringify({ model: "synthetic", input: "hello" });
it("lists codec capabilities and preserves the native resume boundary", async () => {
  const output: string[] = []; expect(await runCli(["protocols", "--json"], v => output.push(v))).toBe(0);
  expect(JSON.parse(output[0]!)).toHaveLength(3);
  expect(await runCli(["doctor"], v => output.push(v))).toBe(0); expect(output[1]).toContain("Cross-agent native session synthesis: not implemented");
});
it("converts stdin to clean JSON stdout", async () => {
  const t = transport(request); expect(await runCli(command, () => {}, t.io)).toBe(0);
  expect(JSON.parse(t.text())).toHaveProperty("messages.0.content.0.text", "hello"); expect(t.errors).toEqual([]);
});
it("writes exact integer identifiers from structured tool inputs to quoted arguments", async () => {
  const source = '{"model":"m","max_tokens":32,"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"c","name":"f","input":{"id":9007199254740993}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"c","content":"ok"}]}]}';
  const t = transport(source);
  expect(await runCli(["convert-protocol", "--kind", "request", "--from", "anthropic-messages", "--to", "responses"], () => {}, t.io)).toBe(0);
  expect(JSON.parse(t.text()).input[0].arguments).toBe('{"id":9007199254740993}');
});
it("writes output and a separate provenance report", async () => {
  const source = path.join(sandbox, "in.json"); const output = path.join(sandbox, "out.json"); const report = path.join(sandbox, "report.json");
  await writeFile(source, request); const t = transport("");
  expect(await runCli([...command, "--input", source, "--output", output, "--report", report], () => {}, t.io)).toBe(0);
  expect(JSON.parse(await readFile(output, "utf8"))).toHaveProperty("messages");
  expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({ status: "completed", preserved: [{ source: "responses", path: "" }] });
  expect(t.text()).toBe(""); expect((await readdir(sandbox)).some(v => v.endsWith(".tmp"))).toBe(false);
});
it("does not overwrite output on strict conversion failure", async () => {
  const output = path.join(sandbox, "out.json"); const report = path.join(sandbox, "report.json"); await writeFile(output, "original");
  const t = transport(JSON.stringify({ model: "m", input: "x", future: true }));
  expect(await runCli([...command, "--output", output, "--report", report], () => {}, t.io)).toBe(3);
  expect(await readFile(output, "utf8")).toBe("original"); expect(JSON.parse(await readFile(report, "utf8"))).toHaveProperty("status", "failed");
});
it("requires a report for explicit loss and keeps discarded fields out of stdout", async () => {
  const report = path.join(sandbox, "report.json"); const t = transport(JSON.stringify({ model: "m", input: "x", future: true }));
  expect(await runCli([...command, "--policy", "allow-loss"], () => {}, t.io)).toBe(2);
  const next = transport(JSON.stringify({ model: "m", input: "x", future: true }));
  expect(await runCli([...command, "--policy", "allow-loss", "--omit", "/future", "--report", report], () => {}, next.io)).toBe(0);
  expect(JSON.parse(next.text())).not.toHaveProperty("future"); expect(JSON.parse(await readFile(report, "utf8")).ledger.dropped).toHaveLength(1);
});
it.each([
  ["--from", "unknown"], ["--unknown", "x"], ["--policy", "relaxed"], ["--max-output-tokens", "0"], ["--report", "-"], ["--omit", "future"], ["--target-model"], ["--candidate-index", "1"],
])("rejects invalid arguments %j", async (...args) => {
  const t = transport(request); expect(await runCli([...command, ...args], () => {}, t.io)).toBe(2); expect(t.text()).toBe("");
});
it("distinguishes parse, linkage, and file errors", async () => {
  expect(await runCli(command, () => {}, transport("{").io)).toBe(2);
  expect(await runCli(command, () => {}, transport(JSON.stringify({ model: "m", input: [{ type: "function_call_output", call_id: "absent", output: "x" }] })).io)).toBe(2);
  expect(await runCli([...command, "--input", path.join(sandbox, "missing.json")], () => {}, transport("").io)).toBe(1);
});
it("rejects source/report/output path collisions without changing input", async () => {
  const source = path.join(sandbox, "in.json"); await writeFile(source, request);
  expect(await runCli([...command, "--input", source, "--report", source], () => {}, transport("").io)).toBe(2);
  expect(await readFile(source, "utf8")).toBe(request);
});
const streamCommand = ["convert-protocol", "--from", "chat-completions", "--to", "responses", "--kind", "stream"];
const start = 'data: {"id":"r","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n';
const finish = 'data: {"id":"r","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
it("atomically publishes successful SSE output", async () => {
  const output = path.join(sandbox, "output.sse"); const t = transport(start + finish);
  expect(await runCli([...streamCommand, "--output", output], () => {}, t.io)).toBe(0);
  expect(await readFile(output, "utf8")).toContain("event: response.completed"); expect(t.text()).toBe("");
});
it("keeps existing stream files on failure and reports partial stdout separately", async () => {
  const output = path.join(sandbox, "output.sse"); await writeFile(output, "original");
  expect(await runCli([...streamCommand, "--output", output], () => {}, transport(start).io)).toBe(3);
  expect(await readFile(output, "utf8")).toBe("original"); expect(await readdir(sandbox)).toEqual(["output.sse"]);
  const t = transport(start); expect(await runCli(streamCommand, () => {}, t.io)).toBe(3);
  expect(t.text()).toContain("response.created"); expect(t.text()).not.toContain("response.completed"); expect(t.errors[0]).toContain("TRUNCATED_STREAM");
});
