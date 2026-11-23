import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { inflateSync } from "node:zlib";
import initSqlJs from "sql.js";
import { it, expect } from "vitest";
import adapter from "../src/index.js";
import { decodeWire, wireRoot } from "../src/wire.js";
const require = createRequire(import.meta.url);
const fixture = () => readFile(new URL("../../../../fixtures/antigravity/sqlite-2_32_1-step0/sample.db", import.meta.url));
const files = (bytes: Uint8Array) => [{ path: "sample.db", bytes }];
it("opens embedded subtrajectory messages separately and verifies their declared parent", async () => {
  const db = new (await sql).Database(await fixture());
  try {
    const encode = (name:string,value:object) => wireRoot.lookupType(name).encode(wireRoot.lookupType(name).fromObject(value)).finish();
    const raw = db.exec("SELECT step_payload FROM steps WHERE idx=3")[0]!.values[0]![0] as Uint8Array;
    const step = decodeWire("Step",raw,"parent").value;
    const child = {trajectory_id:"child",parent_references:[{trajectory_id:"00000000-0000-4000-8000-000000000003",step_index:3}],
      steps:[encode("Step",{type:14,status:3,user_input:{query:"child input"}}),
        encode("Step",{type:15,status:3,planner_response:{response:"child output"}})]};
    step.subtrajectory = Buffer.from(encode("ChildTrajectory",child)).toString("base64");
    db.run("UPDATE steps SET step_payload=?,has_subtrajectory=1 WHERE idx=3",[encode("Step",step)]);
    const result = await adapter.import(files(db.export()));
    const parent = result.session.turns[3]!, nested = parent.childTrajectory!;
    expect(nested.turns.map(t => t.content[0])).toEqual([{type:"text",text:"child input"},{type:"text",text:"child output"}]);
    expect(nested.turns[0]?.origin).toMatchObject({subsession:true,parentId:parent.id,branchId:nested.id});
    expect(result.ledger.downgraded.some(item => item.code === "SUBSESSION_ARCHIVED")).toBe(true);
    const exported = await adapter.export(result.session);
    expect(new TextDecoder().decode(exported.artifacts.find(a => a.path === "context.md")!.bytes)).not.toContain("child output");
    expect(new TextDecoder().decode(exported.artifacts.find(a => a.path === "session.json")!.bytes)).toContain("child output");
  } finally {db.close();}
});
it("displays a verified task-boundary step with its state and summary", async () => {
  const db = new (await sql).Database(await fixture());
  try {
    const type = wireRoot.lookupType("Step");
    const step = {type:81,status:3,task_boundary:{task_name:"Check screenshots",task_status:"In review",task_summary:"Two screens captured"}};
    db.run("UPDATE steps SET step_type=81,step_payload=? WHERE idx=6",[type.encode(type.fromObject(step)).finish()]);
    const {session} = await adapter.import(files(db.export()));
    expect(session.turns.at(-1)!.plan?.steps).toEqual([{title:"Check screenshots",status:"In review",detail:"Two screens captured"}]);
  } finally {db.close();}
});
it("opens recorded artifact revisions and resolves supplied recording companions by unique name", async () => {
  const db = new (await sql).Database(await fixture());
  try {
    const original = db.exec("SELECT step_payload FROM steps WHERE idx=5")[0]!.values[0]![0] as Uint8Array;
    const step = decodeWire("Step",original,"test").value;
    const encode = (name:string,value:object) => wireRoot.lookupType(name).encode(wireRoot.lookupType(name).fromObject(value)).finish();
    (step.checkpoint as Record<string,unknown>).artifact_snapshots = [
      encode("ArtifactSnapshot",{artifact_name:"Walkthrough",artifact_absolute_uri:"file:///project/walkthrough.md",content:"# Original"}),
      encode("ArtifactSnapshot",{artifact_name:"Recording",artifact_absolute_uri:"file:///project/demo.webm"}),
    ];
    db.run("UPDATE steps SET step_payload=? WHERE idx=5",[encode("Step",step)]);
    const {session} = await adapter.import([...files(db.export()),{path:"assets/demo.webm",bytes:new Uint8Array([1])}]);
    const media = session.turns[5]!.content.filter(block => block.type === "media");
    expect(media).toMatchObject([{asset:{location:"text",value:"# Original",mediaType:"text/markdown",label:"Walkthrough"}},
      {asset:{location:"attachment",value:"assets/demo.webm",label:"Recording"}}]);
    expect(adapter.export(session)).toBeDefined();
  } finally {db.close();}
});
it("decodes image captions and embedded media and preserves unfamiliar media payloads", async () => {
  const db = new (await sql).Database(await fixture());
  try {
    const original = db.exec("SELECT step_payload FROM steps WHERE idx=0")[0]!.values[0]![0] as Uint8Array;
    const step = decodeWire("Step", original, "test").value;
    const user = step.user_input as Record<string,unknown>;
    const encode = (name:string,obj:object) => wireRoot.lookupType(name).encode(wireRoot.lookupType(name).fromObject(obj)).finish();
    user.images = [encode("ImageData",{base64_data:"AQID",mime_type:"image/png",caption:"source image"})];
    user.media = [encode("Media",{mime_type:"video/webm",data:"BAUG"}),Buffer.from([0xf8,7,1])];
    db.run("UPDATE steps SET step_payload=? WHERE idx=0",[encode("Step",step)]);
    const {session} = await adapter.import(files(db.export()));
    expect(session.turns[0]!.content).toContainEqual({type:"media",asset:{location:"embedded",mediaType:"image/png",value:"data:image/png;base64,AQID",label:"source image"}});
    expect(session.turns[0]!.content).toContainEqual({type:"media",asset:{location:"embedded",mediaType:"video/webm",value:"data:video/webm;base64,BAUG"}});
    expect(session.turns[0]!.content.filter(b => b.type === "opaque")).toHaveLength(1);
  } finally {db.close();}
});
it("retains both review sides, file comments and artifact selections on their original user turn", async () => {
  const db = new (await sql).Database(await fixture());
  try {
    const original = db.exec("SELECT step_payload FROM steps WHERE idx=0")[0]!.values[0]![0] as Uint8Array;
    const step = decodeWire("Step", original, "test").value;
    const encode = (type:string, value:object) => wireRoot.lookupType(type).encode(wireRoot.lookupType(type).fromObject(value)).finish();
    const user = step.user_input as Record<string, unknown>;
    const sel = {content:"alpha",start_line:2,end_line:2};
    user.file_comments = [encode("FileComment",{file_uri:"a.md",file_comment_infos:[{comment:"file note",selection:sel}]})];
    user.file_diff_comments = [encode("FileDiffComment",{file_uri:"a.md",diff_comment_infos:[
      {comment:"review edit",original_selection:sel,modified_selection:{...sel,content:"beta"}}]})];
    user.artifact_comments = [encode("ArtifactComment",{artifact_uri:"plan.md",comment:"plan note",selections:{selections:[{text_selection:sel}]}})];
    db.run("UPDATE steps SET step_payload=? WHERE idx=0",[encode("Step",step)]);
    const {session} = await adapter.import(files(db.export()));
    expect(session.turns[0]!.reviews?.map(review => [review.path,review.comment,review.selections.map(s => [s.side,s.text])])).toEqual([
      ["a.md","file note",[["file","alpha"]]],["a.md","review edit",[["original","alpha"],["modified","beta"]]],
      ["plan.md","plan note",[["file","alpha"]]],
    ]);
    expect(session.turns[0]!.content.filter(b => b.type === "opaque")).toHaveLength(0);
  } finally { db.close(); }
});
it("opens paired checkpoint snapshots as a historical diff, preserving hash-only and future records", async () => {
  const db = new (await sql).Database(await fixture());
  try {
    const original = db.exec("SELECT step_payload FROM steps WHERE idx=5")[0]!.values[0]![0] as Uint8Array;
    const step = decodeWire("Step", original, "test").value;
    const checkpoint = step.checkpoint as Record<string, unknown>;
    // Independent wire tags: uri, original_content, modified_content.
    const uri = "file:///sample/workspace/old.txt";
    const pair = Buffer.concat([Buffer.from([10,uri.length]), Buffer.from(uri), Buffer.from([18,4,111,108,100,10,26,4,110,101,119,10])]);
    checkpoint.trajectory_file_diffs = [pair, Buffer.concat([Buffer.from([10,uri.length]),Buffer.from(uri),Buffer.from([90,1,65])]),
      Buffer.from([0xf8, 7, 1])];
    const type = wireRoot.lookupType("Step");
    db.run("UPDATE steps SET step_payload=? WHERE idx=5",[type.encode(type.fromObject(step)).finish()]);
    const {session} = await adapter.import(files(db.export()));
    const turn = session.turns[5]!;
    expect(turn.changedFiles).toEqual([{path:uri,added:1,removed:1,patches:["@@ -1,1 +1,1 @@\n-old\n+new"]},
      {path:uri,added:null,removed:null}]);
    expect(turn.content.filter(b => b.type === "opaque")).toHaveLength(1);
    expect(() => adapter.export(session)).toThrow("Uninterpreted");
    const output = await adapter.export(session,{lossPolicy:{omitOpaque:true}});
    expect(new TextDecoder().decode(output.artifacts.find(f => f.path === "context.md")!.bytes)).toContain(uri);
  } finally { db.close(); }
});
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
  expect(await adapter.readProjectDirectory!(input)).toBe(r.session.meta.cwd);
  const output = await adapter.export(r.session, { ledger: r.ledger });
  const context = new TextDecoder().decode(output.artifacts.find(f => f.path === "context.md")!.bytes);
  expect(context).toContain("The file was inspected");
  expect(context).not.toContain("Hello from the sample.");
  expect(r.ledger.approximated[0]?.code).toBe("UNVERIFIED_CHECKPOINT_COVERAGE");
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
it("resolves CLI cascade IDs separately from trajectory IDs and imports mirrored user text once", async () => {
  const db = new (await sql).Database(await fixture());
  const id = "12345678-aaaa-4bbb-8ccc-123456789abc";
  try {
    db.run("UPDATE trajectory_meta SET cascade_id=?", [id]);
    const type = wireRoot.lookupType("Step");
    const original = db.exec("SELECT step_payload FROM steps WHERE idx=0")[0]!.values[0]![0] as Uint8Array;
    const step = decodeWire("Step", original, "test").value;
    step.user_input = {user_response: "Original prompt", items: [{text: "Original prompt"}]};
    db.run("UPDATE steps SET step_payload=? WHERE idx=0", [type.encode(type.fromObject(step)).finish()]);
    const {session} = await adapter.import(files(db.export()));
    expect(session.turns[0]!.content).toEqual([{type:"text", text:"Original prompt"}]);
    expect(session.meta.id).not.toBe(id);
    const base = path.join(os.homedir(), ".gemini");
    expect(adapter.localResumeId!(session, path.join(base, "antigravity-cli", "conversations", id + ".db"))).toBe(id);
    expect(adapter.localResumeId!(session, path.join(base, "antigravity", "conversations", id + ".db"))).toBeUndefined();
  } finally { db.close(); }
});
it("rejects malformed WAL and truncated binary input", async () => {
  await expect(adapter.import([...files(await fixture()), { path: "sample.db-wal", bytes: Uint8Array.of(1) }])).rejects.toThrow("WAL");
  await expect(adapter.import(files((await fixture()).subarray(0, 128)))).rejects.toThrow();
});
it("reads the committed SQLite WAL view and rejects mismatched frames or index copies", async () => {
  // SQLite's own journal for the reviewed sample after PRAGMA journal_mode=WAL and
  // UPDATE trajectory_meta SET cascade_id='committed-receipt'. No native user data.
  const main = await fixture();
  main[18] = main[19] = 2;
  main[27] = main[95] = 9;
  const wal = inflateSync(Buffer.from("eJwzr2drYtB9JMHAIMAAAs8ufBL1mGR98NXNyz+T/9o+AwoxATEXTLyvZevtd/+1HvMCBRn5jzAA0SgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCgYL8GVkDQ3l4DCAAl0gtgIK6aMKGeiagAgLGBcKjJPzc3MzS0pSU3SLUpNTMwtKABs4Kso=", "base64"));
  const shm = inflateSync(Buffer.from("eJztzr0JwmAUBdAvdkklSCAzCFnALOA0mSJ1CovM4AIO4Abp0ynEzsIF8oNNiJWVIOfA5cHlFi+75WEWvbOdbzKlu1T1fT88+/aVHk/F9VHuznHZHLIv92FhWAgrm3UBAAAAAAAAAAAAAAAAAAAAAPDHol8/AAAAAAAAAAAAAAAAAADAhxFCbSmM", "base64"));
  const input = [...files(main), {path:"sample.db-wal", bytes:wal}, {path:"sample.db-shm", bytes:shm}];
  const readId = async (snapshot: typeof input) =>
    (await adapter.import(snapshot)).session.xExtensions["x-antigravity-trajectory"];
  expect(await readId(files(main))).not.toMatchObject({cascade_id:"committed-receipt"});
  expect(await readId(input)).toMatchObject({cascade_id:"committed-receipt"});
  expect(await readId([input[0]!, {...input[1]!, bytes:Buffer.concat([wal, Buffer.alloc(16, 255)])}, input[2]!]))
    .toMatchObject({cascade_id:"committed-receipt"}); // Ignore bytes beyond the indexed commit.
  for (const [bytes, offset] of [[wal, 55], [shm, 64], [shm, 32]] as const) {
    bytes[offset] = bytes[offset]! ^ 1;
    await expect(readId(input)).rejects.toMatchObject({code:"UNSTABLE_INPUT"});
    bytes[offset] = bytes[offset]! ^ 1;
  }
});
it("uses the checkpoint's explicit covered indices and retains uncovered steps", async () => {
  const db = new (await sql).Database(await fixture());
  try {
    const bytes = db.exec("SELECT step_payload FROM steps WHERE idx=5")[0]!.values[0]![0] as Uint8Array;
    const step = decodeWire("Step", bytes, "test").value;
    Object.assign(step.checkpoint as object, { included_step_indices: [0, 1, 2] });
    const type = wireRoot.lookupType("Step");
    db.run("UPDATE steps SET step_payload=? WHERE idx=5", [type.encode(type.fromObject(step)).finish()]);
    const imported = await adapter.import(files(db.export()));
    const out = await adapter.export(imported.session);
    const context = new TextDecoder().decode(out.artifacts.find(f => f.path === "context.md")!.bytes);
    expect(context).not.toContain("Hello from the sample.");
    expect(context).toMatch(/The file contains a greeting[\s\S]*The file was inspected[\s\S]*synthetic diagnostic/);
    expect(imported.ledger.approximated).toHaveLength(0);
  } finally { db.close(); }
});
it("detects unknown nested protobuf fields and wrong wire types", () => {
  expect(decodeWire("UserInput", Uint8Array.from([0x12, 1, 65, 0xf8, 7, 1]), "test").unknown).toEqual(["test/127"]);
  expect(() => decodeWire("UserInput", Uint8Array.from([0x10, 1]), "test")).toThrow("Corrupt");
});
it("requires referenced full output files and refuses opaque native tool payloads", async () => {
  const db = new (await sql).Database(await fixture());
  try {
    db.run("DELETE FROM steps WHERE step_type=23"); // Exercise a tool result in the active window.
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
