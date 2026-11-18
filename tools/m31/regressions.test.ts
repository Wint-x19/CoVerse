import { expect, it } from "vitest";
import { createRegistry } from "../../packages/cli/src/index.js";
import { createDriverRegistry } from "../../packages/drivers/src/index.js";
import { verifyInjectionBundle, buildInjectionBundle, jsonArtifact, sha256Bytes } from "@coverse/core";

const plugins = createRegistry();
const file = (rows: unknown[]) => [{path:"session.jsonl",bytes:Buffer.from(rows.map(r=>JSON.stringify(r)).join("\n"))}];
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
