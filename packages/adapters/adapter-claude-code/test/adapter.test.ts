import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { it, expect, vi } from "vitest";
import adapter from "../src/index.js";
const fixture = async () => (await readFile(new URL("../../../../fixtures/claude-code/transcript-sdk-0_3_326/sample.jsonl", import.meta.url), "utf8")).trim().split("\n").map(s => JSON.parse(s));
const input = (rows: unknown[]) => [{ path: "sample.jsonl", bytes: new TextEncoder().encode(rows.map(r => JSON.stringify(r)).join("\n")) }];
it("imports official-reader validated text, reasoning and tool chains", async () => {
  const r = await adapter.import(input(await fixture()));
  expect(r.session.turns).toHaveLength(4);
  expect(r.session.turns[1]!.content.map(b => b.type)).toEqual(["reasoning", "tool_call"]);
  expect((await adapter.export(r.session)).artifacts.map(f => f.path)).toContain("context.md");
});
it("pairs server web searches in one message and retains clickable result and sentence citations", async () => {
  const rows = await fixture(), url = "https://example.org/paper";
  rows[3].message.content = [
    {type:"server_tool_use",id:"server-1",name:"web_search",input:{query:"research"}},
    {type:"web_search_tool_result",tool_use_id:"server-1",content:[{type:"web_search_result",url,title:"Paper"}]},
    {type:"text",text:"A finding.",citations:[{type:"web_search_result_location",url,title:"Paper",cited_text:"sample finding"}]},
  ];
  const turn = (await adapter.import(input(rows))).session.turns.at(-1)!;
  expect(turn.content[1]).toMatchObject({type:"tool_result",callTurnId:turn.id,sources:[{url,title:"Paper"}]});
  expect(turn.content[2]).toMatchObject({sources:[{url,title:"Paper",excerpt:"sample finding"}]});
});
it("reads message timestamps, actual model switches and cache usage",async () => {
  const rows = await fixture();
  rows[3].timestamp = "2026-01-01T12:00:00Z";
  Object.assign(rows[3].message,{model:"second-model",usage:{input_tokens:4,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:2}});
  const {session} = await adapter.import(input(rows));
  expect(session.turns[1]?.model).toBe("sample-model");
  expect(session.turns[3]).toMatchObject({model:"second-model",createdAt:rows[3].timestamp,
    usage:{input:4,output:1,cachedInput:0,cacheWrite:2},usageScope:"message"});
});
it("keeps a TodoWrite list with its recorded status", async () => {
  const rows = await fixture();
  Object.assign(rows[1].message.content[1],{name:"TodoWrite",input:{todos:[{content:"Ship it",status:"completed"}]}});
  expect((await adapter.import(input(rows))).session.turns[1]!.plan?.steps).toEqual([{title:"Ship it",status:"completed"}]);
});
it("preserves PDF and text documents as named previews", async () => {
  const rows = await fixture();
  rows[0].message.content = [
    {type:"document",title:"notes",source:{type:"text",data:"page body"}},
    {type:"document",title:"scan",source:{type:"base64",media_type:"application/pdf",data:"AQID"}},
  ];
  const {session} = await adapter.import(input(rows));
  expect(session.turns[0]!.content).toEqual([
    {type:"media",asset:{location:"text",label:"notes",mediaType:"text/plain",value:"page body"}},
    {type:"media",asset:{location:"embedded",label:"scan",mediaType:"application/pdf",value:"data:application/pdf;base64,AQID"}},
  ]);
  const returned = [{type:"text",text:"preview"}, {type:"image",source:{type:"base64",media_type:"image/png",data:"AQID"}}];
  rows[2].message.content[0].content = returned;
  expect((await adapter.import(input(rows))).session.turns[2]!.content[0]).toMatchObject({
    content:returned,displayText:"preview",assets:[{location:"embedded",mediaType:"image/png"}],
  });
});
it("shows the recorded Edit hunks and distinguishes new files from overwrites with unknown history", async () => {
  const rows = await fixture();
  const call = rows[1].message.content[1];
  call.name = "Edit";
  rows[2].toolUseResult = {filePath:"example.txt", structuredPatch:[
    {oldStart:2, oldLines:1, newStart:2, newLines:1, lines:["-before", "+after"]},
  ]};
  const change = async () => (await adapter.import(input(rows))).session.turns[2]!.changedFiles?.[0];
  expect(await change()).toEqual({path:"example.txt", added:1, removed:1, patches:["@@ -2,1 +2,1 @@\n-before\n+after"]});
  rows[2].message.content[0].is_error = true;
  expect(await change()).toBeUndefined();
  rows[2].message.content[0].is_error = false;
  call.name = "Write";
  rows[2].toolUseResult = {type:"create", filePath:"example.txt", content:"new\n", originalFile:null, structuredPatch:[]};
  expect(await change()).toMatchObject({added:1, removed:0, patches:["@@ -0,0 +1,1 @@\n+new"]});
  rows[2].toolUseResult.type = "update";
  expect(await change()).toEqual({path:"example.txt", added:null, removed:null});
  rows[2].toolUseResult.originalFile = "old\n";
  expect(await change()).toMatchObject({added:1, removed:1, patches:[expect.stringContaining("-old\n+new")]});
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
it("compares two archived file checkpoints on the same ancestry without reading the present worktree", async () => {
  const rows = await fixture();
  const names = ["0123456789abcdef@v1","0123456789abcdef@v2"];
  const snapshot = (id:string,i:number) => ({type:"file-history-snapshot",messageId:id,snapshot:{
    messageId:id,trackedFileBackups:{"sample.js":{backupFileName:names[i],version:i+1}},
  }});
  const log = input([rows[0],snapshot(rows[0].uuid,0),...rows.slice(1),snapshot(rows[3].uuid,1)]);
  const backups = names.map((name,i) => ({path:"file-history/" + name,bytes:new TextEncoder().encode(i ? "new\n" : "old\n")}));
  const {session} = await adapter.import([...log,...backups]);
  const last = session.turns.at(-1)!;
  expect(last.assets).toMatchObject([{value:"new\n",label:"sample.js · v2"}]);
  expect(last.changedFiles).toMatchObject([{path:"sample.js",added:1,removed:1,patches:["@@ -1,1 +1,1 @@\n-old\n+new"]}]);
  const missing = (await adapter.import(log)).session.turns.at(-1)!;
  expect(missing.changedFiles?.[0]).toEqual({path:"sample.js",added:null,removed:null});
  expect(missing.event?.text).toContain("backup unavailable");
});
it("loads only the selected native session's named backups", async () => {
  const tmp = path.resolve(import.meta.dirname,"../../../../.tmp");
  await mkdir(tmp,{recursive:true});
  const root = await mkdtemp(path.join(tmp,"checkpoint-"));
  try {
    vi.stubEnv("CLAUDE_CONFIG_DIR",root);
    const rows = await fixture(), id = rows[0].sessionId, name = "0123456789abcdef@v1";
    const dir = path.join(root,"projects","fixture"), backups = path.join(root,"file-history",id);
    await mkdir(dir,{recursive:true}); await mkdir(backups,{recursive:true});
    await writeFile(path.join(backups,name),"recorded");
    rows.push({type:"file-history-snapshot",snapshot:{trackedFileBackups:{"code.ts":{backupFileName:name}}}});
    const files = [{...input(rows)[0]!,path:id+".jsonl"}];
    const resolve = async () => {throw new Error("Unexpected lookup");};
    const result = await adapter.prepareLocalImport!(files,resolve,path.join(dir,id+".jsonl"));
    expect(result.map(file => file.path)).toEqual([id+".jsonl","file-history/"+name]);
    expect(await adapter.prepareLocalImport!(files,resolve,path.join(root,"elsewhere",id+".jsonl"))).toEqual(files);
  } finally {vi.unstubAllEnvs(); await rm(root,{recursive:true,force:true});}
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
it("includes legacy summary records in the transcript with a compaction label", async () => {
  const r = await adapter.import(input([...await fixture(), { type: "summary", summary: "Keep this historical summary", leafUuid: "native-leaf" }]));
  expect(r.session.turns.at(-1)!.origin!.kind).toBe("compaction");
  expect(JSON.stringify(r.session.turns.at(-1)!.content)).toContain("Keep this historical summary");
});
it("uses the compact summary and subsequent messages for target continuation", async () => {
  const rows = await fixture();
  const user = rows[0];
  rows.push({ ...user, uuid: "summary", parentUuid: rows.at(-1).uuid, isCompactSummary: true, message: { role: "user", content: "latest summary" } });
  rows.push({ ...user, uuid: "next", parentUuid: "summary", message: { role: "user", content: "next question" } });
  const r = await adapter.import(input(rows));
  const result = await adapter.export(r.session);
  const context = new TextDecoder().decode(result.artifacts.find(f => f.path === "context.md")!.bytes);
  expect(context).toMatch(/latest summary[\s\S]*next question/);
  expect(context).not.toContain("Historical tool call");
  expect(r.session.turns).toHaveLength(6);
});
