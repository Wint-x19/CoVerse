import { readFile } from "node:fs/promises";
import { it, expect } from "vitest";
import adapter from "../src/index.js";
const fixture = async () => (await readFile(new URL("../../../../fixtures/claude-code/transcript-sdk-0_3_326/sample.jsonl", import.meta.url), "utf8")).trim().split("\n").map(s => JSON.parse(s));
const input = (rows: unknown[]) => [{ path: "sample.jsonl", bytes: new TextEncoder().encode(rows.map(r => JSON.stringify(r)).join("\n")) }];
it("imports official-reader validated text, reasoning and tool chains", async () => {
  const r = await adapter.import(input(await fixture()));
  expect(r.session.turns).toHaveLength(4);
  expect(r.session.turns[1]!.content.map(b => b.type)).toEqual(["reasoning", "tool_call"]);
  expect((await adapter.export(r.session)).artifacts.map(f => f.path)).toContain("context.md");
});
it("preserves forks and subagent branches without selecting only the last leaf", async () => {
  const rows = await fixture();
  rows.push({ ...rows[3], uuid: "fork", message: { role: "assistant", content: "Alternate answer" } });
  rows.push({ ...rows[0], uuid: "child", parentUuid: null, isSidechain: true, agentId: "child-agent" });
  const r = await adapter.import(input(rows));
  expect(r.session.turns).toHaveLength(6);
  expect(r.session.turns[3]!.origin!.branchId).not.toEqual(r.session.turns[4]!.origin!.branchId);
  expect(r.session.turns[5]!.origin!.kind).toBe("subsession");
});
it("rejects missing parents, cycles, unknown writers and sibling tool results", async () => {
  const rows = await fixture();
  const orphan = structuredClone(rows); orphan[1].parentUuid = "missing";
  expect(() => adapter.import(input(orphan))).toThrow("Missing parent");
  const cyclic = structuredClone(rows); cyclic[0].parentUuid = rows[3].uuid;
  expect(() => adapter.import(input(cyclic))).toThrow("Cycle");
  const wrong = structuredClone(rows); wrong[0].version = "3.0.0";
  expect(() => adapter.import(input(wrong))).toThrow("baseline");
  const sibling = structuredClone(rows); sibling[2].parentUuid = rows[0].uuid;
  expect(() => adapter.import(input(sibling))).toThrow("no call");
});
it("retains opaque content but blocks export and distinguishes duplicate conflicts", async () => {
  const rows = await fixture(); rows[3].message.content = [{ type: "redacted_thinking", data: "opaque" }];
  const r = await adapter.import(input([...rows, rows[3]])); expect(r.session.turns).toHaveLength(4);
  expect(() => adapter.export(r.session)).toThrow("Uninterpreted");
  expect(() => adapter.import(input([...rows, { ...rows[3], unknown: true }]))).toThrow("Conflicting duplicate");
});
