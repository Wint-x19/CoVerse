import { expect, it } from "vitest";
import { createRegistry } from "../../packages/cli/src/index.js";
import { createDriverRegistry } from "../../packages/drivers/src/index.js";
import { verifyInjectionBundle, buildInjectionBundle, jsonArtifact, sha256Bytes } from "@coverse/core";
import { convertStream } from "@coverse/protocols";

const plugins = createRegistry();
const file = (rows: unknown[]) => [{path:"session.jsonl",bytes:Buffer.from(rows.map(r=>JSON.stringify(r)).join("\n"))}];
it("keeps a Messages context-window error as a failed protocol stream", async () => {
  const bytes = Buffer.from('event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"prompt exceeds context window"}}\n\n');
  const input = (async function*(){yield bytes;})();
  const converted=convertStream({from:"anthropic-messages",to:"responses",input});
  await expect((async()=>{for await(const chunk of converted.data) expect(chunk.byteLength).toBeGreaterThan(0);})()).rejects.toMatchObject({code:"UPSTREAM_ERROR"});
  expect((await converted.completion).status).toBe("failed");
});
it("keeps skill invocation and MCP schema errors as quoted data with distinct argument forms", async () => {
  const p=plugins.get("codex");
  const payloads=[
    {type:"custom_tool_call",call_id:"skill",name:"Skill",input:"dispatch-check v1"},
    {type:"custom_tool_call_output",call_id:"skill",output:"Read the v1 reference: ARCHIVE-81"},
    {type:"function_call",call_id:"mcp",name:"mcp__green__lookup",arguments:'{"id":"wrong-version"}'},
    {type:"function_call_output",call_id:"mcp",output:{isError:true,structuredContent:{required:"ticket"},content:[{type:"resource_link",uri:"m31://green/receipt"}]}},
  ];
  const imported=await p.import(file([{type:"session_meta",payload:{id:"s",cli_version:"0.169.0-alpha.11.1"}},
    ...payloads.map(payload=>({type:"response_item",payload})),{type:"event_msg",payload:{type:"thread_rolled_back",num_turns:1}},
    {type:"compacted",payload:{message:"Historical checkpoint"}}]));
  expect(imported.session.turns.slice(-2).map(t=>t.origin?.kind)).toEqual(["reverted","compaction"]);
  expect(imported.session.turns[0]?.content[0]).toMatchObject({type:"tool_call",arguments:"dispatch-check v1"});
  const result=await p.export(imported.session,{ledger:imported.ledger});
  const {context}=verifyInjectionBundle(result.artifacts,"codex");
  for(const word of ["ARCHIVE-81","mcp__green__lookup","wrong-version","ticket","m31://green/receipt","isError"]) expect(context).toContain(word);
  expect(result.ledger.downgraded.filter(i=>i.code==="TOOL_AS_HISTORY")).toHaveLength(4);
});
it("exports a 2.1.121 generated conversation title as historical metadata", async () => {
  const p=plugins.get("claude-code");
  const imported=await p.import(file([{type:"user",uuid:"u",sessionId:"s",parentUuid:null,version:"2.1.121",message:{role:"user",content:"hello"}},
    {type:"ai-title",aiTitle:"Dispatch receipt",sessionId:"s"}]));
  const out=await p.export(imported.session,{ledger:imported.ledger});
  expect(verifyInjectionBundle(out.artifacts,"claude-code").context).toContain("Dispatch receipt");
});
it("retains tool-only Codex MCP events and records their historical status", async () => {
  const p=plugins.get("codex");
  const input=file([{type:"session_meta",payload:{id:"test",cli_version:"0.169.0-alpha.11.1"}},
    {type:"event_msg",payload:{type:"mcp_tool_call_end",call_id:"only",invocation:{server:"alpha",tool:"lookup"},result:{receipt:"unique-204"}}}]);
  const imported=await p.import(input);
  const out=await p.export(imported.session,{ledger:imported.ledger});
  const bundle=verifyInjectionBundle(out.artifacts,"codex");
  expect(bundle.context).toContain("unique-204");
  expect(imported.ledger.downgraded).toContainEqual(expect.objectContaining({code:"TOOL_EVENT_AS_HISTORY",path:"session.jsonl:2"}));
});
it("rejects ambiguous Claude call IDs on one ancestry and allows reuse on independent forks", async () => {
  const p=plugins.get("claude-code");
  const msg=(id:string,parent:string|null,role:string,content:unknown)=>({uuid:id,parentUuid:parent,sessionId:"test",type:role,version:"2.1.121",message:{role,content}});
  const use=[{type:"tool_use",id:"k",name:"lookup",input:{ticket:1}}];
  const rows=[msg("u",null,"user","go"),msg("a","u","assistant",use),msg("b","u","assistant",use)];
  await expect(Promise.resolve(p.import(file(rows)))).resolves.toBeDefined();
  expect(()=>p.import(file([...rows,msg("c","a","assistant",use)]))).toThrow(/duplicate|ambiguous/i);
});
it("retains the actual Antigravity terminal error when partial response text exists", () => {
  const decode=createDriverRegistry().get("antigravity").plugin.decoder();
  expect(()=>decode({event:"result",result:{status:"ERROR",response:"partial answer",error:"prompt too long"}})).toThrow(/prompt too long/);
});
it("rejects an empty Antigravity success after an unresolved failed tool", () => {
  const decode=createDriverRegistry().get("antigravity").plugin.decoder();
  decode({event:"step_update",step_update:{conversation_id:"s",step_type:"tool",step_index:2,tool_name:"call_mcp_tool",state:"ERROR"}});
  expect(()=>decode({event:"result",result:{conversation_id:"s",status:"SUCCESS",response:""}})).toThrow(/failed tool/i);
});
it("rejects changed source bytes even when only the outer manifest was regenerated", () => {
  const out=buildInjectionBundle({schemaVersion:"1.0",meta:{agent:"test",id:"s",agentFormatVersion:"v1"},turns:[],xExtensions:{},
    sourceArtifacts:[{path:"a.txt",bytes:Buffer.from("original")}]}, "codex");
  const changed=out.artifacts.map(f=>f.path==="source/a.txt"?{...f,bytes:Buffer.from("replaced")}:f);
  const manifest=JSON.parse(Buffer.from(changed.at(-1)!.bytes).toString());
  const entry=manifest.files.find((f:{path:string})=>f.path==="source/a.txt");
  entry.sha256=sha256Bytes(Buffer.from("replaced"));entry.bytes=8;
  changed[changed.length-1]=jsonArtifact("manifest.json",manifest);
  expect(()=>verifyInjectionBundle(changed,"codex")).toThrow(/source/i);
});
