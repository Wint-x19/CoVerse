import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { it, expect } from "vitest";
import adapter from "../src/index.js";
import { decodeWire, wireRoot } from "../src/wire.js";
const require = createRequire(import.meta.url);
const fixture = () => readFile(new URL("../../../../fixtures/antigravity/sqlite-2_32_1-step0/sample.db", import.meta.url));
const files = (bytes: Uint8Array) => [{ path: "sample.db", bytes }];
const sql = initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") });
async function mutate(statement: string) { const db = new (await sql).Database(await fixture()); try { db.run(statement); return db.export(); } finally { db.close(); } }
it("decodes independently encoded SQLite/protobuf golden data and all six supported step types", async () => {
  const input = files(await fixture()); expect(await adapter.detect(input)).toMatchObject({ confidence: 1 });
  const r = await adapter.import(input);
  expect(r.session.turns).toHaveLength(7);
  expect(r.session.turns[0]!.content).toEqual([{ type: "text", text: "Read example.txt and explain it." }]);
  expect(r.session.turns[2]!.content[0]).toEqual({ type: "tool_result", callId: "sample-call", content: "Hello from the sample.", isError: false });
  expect(r.session.turns[5]!.origin!.kind).toBe("compaction");
  expect(r.session.meta.cwd).toBe("file:///sample/workspace");
  const output = await adapter.export(r.session, { ledger: r.ledger });
  expect(output.artifacts.find(f => f.path === "source/sample.db")!.bytes).toEqual(input[0]!.bytes);
});
it("rejects schema drift, unknown step formats, column/payload disagreement and missing subtrajectories", async () => {
  for (const [statement, error] of [
    ["ALTER TABLE steps ADD COLUMN future TEXT", "column layout"],
    ["UPDATE steps SET step_format=1 WHERE idx=0", "step_format"],
    ["UPDATE steps SET step_type=999 WHERE idx=0", "disagree"],
    ["UPDATE steps SET has_subtrajectory=1 WHERE idx=0", "Subtrajectory"],
  ]) await expect(adapter.import(files(await mutate(statement!)))).rejects.toThrow(error!);
});
it("rejects nonempty WAL and truncated binary input", async () => {
  await expect(adapter.import([...files(await fixture()), { path: "sample.db-wal", bytes: Uint8Array.of(1) }])).rejects.toThrow("WAL");
  await expect(adapter.import(files((await fixture()).subarray(0, 128)))).rejects.toThrow();
});
it("detects unknown nested protobuf fields and wrong wire types", () => {
  expect(decodeWire("UserInput", Uint8Array.from([0x12, 1, 65, 0xf8, 7, 1]), "test").unknown).toEqual(["test/127"]);
  expect(() => decodeWire("UserInput", Uint8Array.from([0x10, 1]), "test")).toThrow("Corrupt");
});
it("requires referenced full output files and refuses opaque native tool payloads", async () => {
  const db = new (await sql).Database(await fixture());
  try {
    const original = db.exec("SELECT step_payload FROM steps WHERE idx=2")[0]!.values[0]![0] as Uint8Array;
    const value = decodeWire("Step", original, "step").value;
    const generic = value.generic as { result: Record<string, unknown> }; generic.result.full_output_uri = "file:///sample/full-output.txt";
    const stepType = wireRoot.lookupType("Step");
    db.run("UPDATE steps SET step_payload=? WHERE idx=2", [stepType.encode(stepType.fromObject(value)).finish()]);
    await expect(adapter.import(files(db.export()))).rejects.toThrow("full tool output");
    const input = [...files(db.export()), { path: "full-output.txt", bytes: new TextEncoder().encode("entire output") }];
    expect((await adapter.export((await adapter.import(input)).session)).artifacts.map(f => f.path)).toContain("source/full-output.txt");
    generic.result.payload = "AQ==";
    db.run("UPDATE steps SET step_payload=? WHERE idx=2", [stepType.encode(stepType.fromObject(value)).finish()]);
    const r = await adapter.import([{ ...input[0]!, bytes: db.export() }, input[1]!]);
    expect(() => adapter.export(r.session)).toThrow("Uninterpreted");
  } finally { db.close(); }
});
