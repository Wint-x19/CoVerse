import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import adapter, { formatVersion } from "../src/index.js";
const encode = (rows: unknown[]) => [{ path: "rollout.jsonl", bytes: new TextEncoder().encode(rows.map(r => JSON.stringify(r)).join("\n")) }];
const header = { type: "session_meta", payload: { id: "sample-codex", cli_version: "0.169.0-alpha.11.1", cwd: "/sample", timestamp: "2026-11-17T00:00:00Z", base_instructions: { text: "Be precise." } } };
const completed = (turn_id: string, item: object) => ({ type: "event_msg", payload: { type: "item_completed", turn_id, item } });
it("reconstructs a native fork at its byte boundary, separates hidden inputs and counts net file edits", async () => {
  const id = "12345678-0000-4000-8000-000000000001";
  const base = [{...header, payload: {...header.payload, id}},
    { type: "response_item", payload: {type:"message", role:"user", content:[{type:"input_text",text:"injected workspace"}]} },
    completed("turn1", {type:"UserMessage",id:"u",content:[{type:"text",text:"first question\n"}]}),
    completed("turn1", {type:"FileChange",id:"f",status:"completed",changes:{"/sample/test.md":{type:"add",content:"a\nb\n"}}}),
    completed("turn1", {type:"FileChange",id:"f2",status:"completed",changes:{"/sample/test.md":{type:"update",unified_diff:"@@ -2,1 +2,1 @@\n-b\n+c"}}}),
    completed("turn1", {type:"AgentMessage",id:"a",phase:"final_answer",content:[{type:"Text",text:"| A | B |\n|---|---|\n| x | y |"}]})];
  const offset = encode(base)[0]!.bytes.length + 1;
  const parent = encode([...base, completed("sibling", {type:"UserMessage",id:"s",content:[{type:"text",text:"excluded sibling"}]})]);
  const child = encode([{...header,payload:{...header.payload,forked_from_id:id,history_base:{thread_id:id,end_ordinal_exclusive:base.length,end_byte_offset:offset}}},
    completed("turn2", {type:"UserMessage",id:"u2",content:[{type:"text",text:"on fork"}]})]);
  expect(() => adapter.import(child)).toThrow("parent");
  const files = await adapter.prepareLocalImport!(child, async key => {expect(key).toBe(id); return parent;});
  const imported = await adapter.import(files);
  expect(imported.session.transcript).toEqual([
    {id:"u",role:"user",text:"first question\n"},
    {id:"a",role:"assistant",text:"| A | B |\n|---|---|\n| x | y |",changedFiles:[{path:"test.md",added:2,removed:0}]},
    {id:"u2",role:"user",text:"on fork"}]);
  expect(files.some(f => new TextDecoder().decode(f.bytes).includes("excluded sibling"))).toBe(false);
  expect(imported.session.turns.some(t => t.content.some(c => c.type === "text" && c.text === "injected workspace"))).toBe(true);
});
const response = (payload: unknown) => ({ type: "response_item", payload });
const sample = [header,
  response({ type: "message", role: "user", content: [{ type: "input_text", text: "Read the sample." }] }),
  { type: "event_msg", payload: { type: "user_message", message: "Read the sample." } },
  response({ type: "reasoning", summary: [{ type: "summary_text", text: "Inspect the sample first." }] }),
  response({ type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"sample.txt"}' }),
  response({ type: "function_call_output", call_id: "c1", output: "sample result" }),
  { type: "compacted", payload: { message: "Sample was read.", replacement_history: [] } },
  response({ type: "message", role: "assistant", future_field: "retained", content: [{ type: "output_text", text: "Done." }] }),
];
it("imports verified message records without duplicating UI events", async () => {
  expect(await adapter.detect(encode(sample))).toMatchObject({ confidence: 1, formatVersion });
  const r = await adapter.import(encode(sample));
  expect(r.session.turns.filter(t => t.role === "user")).toHaveLength(1);
  expect(r.session.turns.find(t => t.origin?.kind === "compaction")).toBeDefined();
  expect(JSON.stringify(r.session.raw)).toContain("future_field");
  expect((await adapter.export(r.session, { ledger: r.ledger })).artifacts.map(a => a.path)).toContain("source/rollout.jsonl");

  const sample01691 = [{ ...header, payload: { ...header.payload, cli_version: "0.169.1" } }, ...sample.slice(1)];
  expect(await adapter.detect(encode(sample01691))).toMatchObject({ confidence: 1, formatVersion });
});
it("rejects unverified writers, corrupt input and broken tool associations", () => {
  expect(() => adapter.import(encode([{ ...header, payload: { ...header.payload, cli_version: "future" } }]))).toThrow("not been verified");
  expect(() => adapter.import([{ path: "rollout.jsonl", bytes: new TextEncoder().encode('{"x":') }])).toThrow("Invalid JSON");
  expect(() => adapter.import(encode([header, response({ type: "function_call_output", call_id: "orphan", output: "x" })]))).toThrow("no preceding call");
});
it("imports the observed desktop writers and preserves injected page context separately from tool results", async () => {
  for (const cli_version of ["0.167.0-alpha.4.1", "0.171.0-alpha.13"]) {
    const rows = [{ ...header, payload: { ...header.payload, cli_version } }, ...sample.slice(1)];
    const result = await adapter.import(encode(rows));
    expect(result.session.turns.some(turn => turn.role === "user")).toBe(true);
  }
  const page = { type: "function_call_output", namespace: "agent", name: "codex_apps_open_page", output: "Sample page" };
  const snapshot = { ...page, name: "codex_apps_selected_page_part_1_of_1", output: "Selected page contents" };
  for (const cli_version of ["0.169.0-alpha.11.1", "0.171.0-alpha.13"]) {
    const current = { ...header, payload: { ...header.payload, cli_version } };
    const result = await adapter.import(encode([current, response(page), response(snapshot)]));
    expect(result.session.turns.slice(-2).map(t => t.content[0])).toEqual([page, snapshot].map(p =>
      ({ type: "text", text: `Historical Codex page context (${p.name}):\n${p.output}` })));
    expect(result.ledger.downgraded.map(item => item.code)).toEqual(["PAGE_CONTEXT_AS_HISTORY", "PAGE_CONTEXT_AS_HISTORY"]);
    for (const invalid of [{ ...page, name: "unrecognized" }, { ...page, namespace: "functions" }, { ...page, call_id: "" }]) {
      expect(() => adapter.import(encode([current, response(invalid)]))).toThrow();
    }
  }
});
it("exports only the replacement window and subsequent turns for target continuation", async () => {
  const msg = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  const rows = [header, response(msg("archived-before")), { type: "compacted", payload: {
    message: "archived-summary", replacement_history: [msg("retained-first"), msg("retained-second")] } }, response(msg("later-message"))];
  const imported = await adapter.import(encode(rows));
  const result = await adapter.export(imported.session);
  const read = (name: string) => new TextDecoder().decode(result.artifacts.find(f => f.path === name)!.bytes);
  expect(read("context.md")).toMatch(/retained-first[\s\S]*retained-second[\s\S]*later-message/);
  expect(read("context.md")).not.toMatch(/archived-before|archived-summary/);
  expect(read("session.json")).toContain("archived-before");
});
it("archives unknown semantics but refuses a falsely complete export", async () => {
  for (const value of [{ type: "future", data: "keep" }, { type: "reasoning", summary: [], encrypted_content: "synthetic-ciphertext" }]) {
    const r = await adapter.import(encode([header, response(value)]));
    expect(() => adapter.export(r.session)).toThrow("Uninterpreted");
  }
});
it("rejects invalid compressed records", () => expect(() => adapter.import([{ path: "rollout.jsonl.zst", bytes: new Uint8Array([1, 2]) }])).toThrow("Zstandard"));
it("keeps an unreadable active compaction distinct from optional opaque history", async () => {
  const r = await adapter.import(encode([header, { type: "compacted", payload: { replacement_history: [
    { type: "compaction", encrypted_content: "opaque-window" },
  ] } }]));
  expect(() => adapter.export(r.session, { lossPolicy: { omitOpaque: true } })).toThrowError(expect.objectContaining({ code: "UNPORTABLE_COMPACTION" }));
  const readable = await adapter.import(encode([header, { type: "compacted", payload: {
    message: "source supplied summary", replacement_history: [{ type: "compaction", encrypted_content: "opaque-window" }],
  } }]));
  const out = await adapter.export(readable.session, { ledger: readable.ledger });
  const context = new TextDecoder().decode(out.artifacts.find(f => f.path === "context.md")!.bytes);
  expect(context).toContain("source supplied summary");
  expect(context).not.toContain("opaque-window");
  expect(readable.ledger.approximated[0]?.code).toBe("COMPACTION_AS_SOURCE_SUMMARY");
});
it("keeps event-only messages and additional identical requests", async () => {
  const event = { type: "event_msg", payload: { type: "user_message", message: "Read the sample." } };
  const r = await adapter.import(encode([...sample, event, { type: "event_msg", payload: { type: "agent_message", message: "An event-only answer" } }]));
  expect(r.session.turns.filter(t => t.role === "user")).toHaveLength(2);
  expect(r.session.turns.at(-1)!.content).toEqual([{ type: "text", text: "An event-only answer" }]);
});
it("imports independently reconstructed compressed and plaintext fixtures equivalently", async () => {
  const load = async (name: string) => adapter.import([{ path: name, bytes: await readFile(new URL(`../../../../fixtures/codex/rollout-2026-11-17/${name}`, import.meta.url)) }]);
  const a = await load("sample.jsonl"), b = await load("sample.jsonl.zst");
  expect(a.session.turns.map(({ origin: _origin, ...t }) => t)).toEqual(b.session.turns.map(({ origin: _origin, ...t }) => t));
  expect(a.session.raw).toEqual(b.session.raw);
});
