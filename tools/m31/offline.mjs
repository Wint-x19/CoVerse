import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import { createDriverRegistry } from "../../packages/drivers/dist/index.js";
import { agents,cases,fixture,root,hash,codexFile,score } from "./cases.mjs";
import { cli,convert,read,save } from "./harness.mjs";

const parent=path.join(root,".tmp","m31-offline");
await fs.mkdir(parent,{recursive:true});
const out=await fs.mkdtemp(path.join(parent,"run-"));
const assertions=[];
const check=(name,actual,expected)=>assertions.push({name,pass:isDeepStrictEqual(actual,expected),...(!isDeepStrictEqual(actual,expected)&&{actual,expected})});
const fake=createDriverRegistry(Object.fromEntries(agents.map(a=>[a,{command:process.execPath,prefix:[path.join(root,"packages/cli/test/fake-agent.mjs"),a]}])));
const lossRows=[];
for(const source of agents)for(const target of agents)for(const [seed,test] of Object.entries(cases.seeds)){
  const label=source+"-"+target+"-"+seed,dir=path.join(out,label);
  const input=fixture(source,seed),c=await convert(dir,source,target,input);
  check(label+"/accept",c.status,0);
  if(c.status!==0)continue;
  const csr=await read(path.join(c.bundle,"session.json")),report=await read(path.join(c.bundle,"report.json"));
  const ctx=await fs.readFile(path.join(c.bundle,"context.md"),"utf8");
  const sourceBytes=await fs.readFile(input);
  check(label+"/source-hash",hash(await fs.readFile(path.join(c.bundle,"source",path.basename(input)))),hash(sourceBytes));
  check(label+"/csr",csr.turns.map(t=>[t.role,t.content]),test.history.map(([role,text])=>[role,[{type:"text",text}]]));
  check(label+"/artifact-origin",csr.turns.map(t=>t.origin.artifact),test.history.map(()=>path.basename(input)));
  const origin=source==="codex"?2:source==="claude-code"?1:0;
  check(label+"/record-order",csr.turns.map(t=>t.origin.record),test.history.map((_,i)=>i+origin));
  if(source==="claude-code"){
    check(label+"/parents",csr.turns.map(t=>t.origin.parentId??null),[null,csr.turns[0].id,csr.turns[1].id]);
    check(label+"/branch",csr.turns.map(t=>t.origin.branchId),["main","main","main"]);
  }
  const indices=test.history.map(([,t])=>ctx.indexOf("> "+t));
  check(label+"/quoted-order",indices.every((v,i)=>v>=0 && (!i || v>indices[i-1])),true);
  const expected=["downgraded:/turns:HISTORICAL_ROLES"];
  if(source==="antigravity")expected.push("downgraded:/raw:ARCHIVED_NATIVE_STATE");
  const actual=Object.entries(report.ledger).flatMap(([kind,items])=>items.map(i=>kind+":"+i.path+":"+i.code));
  check(label+"/ledger",actual.sort(),expected.sort());
  const reasons={HISTORICAL_ROLES:/labeled history.*not native/i,ARCHIVED_NATIVE_STATE:/archived.*not restored/i};
  check(label+"/ledger-reason",Object.values(report.ledger).flat().every(i=>reasons[i.code]?.test(i.reason)),true);
  lossRows.push({label,expected,actual});
  const cwd=path.join(dir,"工作 space"); await fs.mkdir(cwd);
  const run=await cli(["run","--agent",target,"--cwd",cwd,"--bundle",c.bundle,"--json","--prompt",cases.question],undefined,fake);
  check(label+"/run",run.status,0);
  if(run.status!==0)continue;
  const capture=await read(path.join(cwd,"received.json"));
  const stdin=target==="antigravity"?JSON.parse(capture.input).message.content:capture.input;
  check(label+"/stdin-hash",hash(stdin),hash(ctx+"\n## Current user request\n\n"+cases.question));
  check(label+"/events",run.stdout.trim().split("\n").map(s=>JSON.parse(s).type),["bundle","session","text","usage","done"]);
}

const toolDir=path.join(out,"tool-graph");
await fs.mkdir(toolDir);
const msg=(uuid,parentUuid,role,content)=>({type:role,uuid,parentUuid,sessionId:"m31",version:"2.1.121",message:{role,content}});
const use=(id,token)=>({type:"tool_use",id,name:"lookup",input:{token}});
const answer=(id,text,is_error=false)=>({type:"tool_result",tool_use_id:id,content:text,is_error});
const rows=[msg("root",null,"user","Fetch both receipts"),msg("use","root","assistant",[use("a",12),use("b",93)]),
  msg("reverse","use","user",[answer("b","B93"),answer("a","not found",true)]),
  msg("retry","reverse","assistant",[use("retry-a",12)]),msg("resolved","retry","user",[answer("retry-a","A12")]),
  msg("left","resolved","assistant",[use("fork-call",8)]),msg("right","resolved","assistant",[use("fork-call",9)]),
  msg("left-result","left","user",[answer("fork-call","L8")]),msg("right-result","right","user",[answer("fork-call","R9")]),
  msg("unfinished","right-result","assistant",[use("no-result",44)])];
const graphFile=path.join(toolDir,"source.jsonl");
const lines=r=>r.map(v=>JSON.stringify(v)).join("\n");
await fs.writeFile(graphFile,lines(rows));
const graph=await convert(toolDir,"claude-code","codex",graphFile);
check("tool/accepted",graph.status,0);
const expectedEdges=["a:12:not found:true","b:93:B93:false","retry-a:12:A12:false","fork-call:8:L8:false","fork-call:9:R9:false"];
let actualEdges=[];
if(graph.status===0){
  const csr=await read(path.join(graph.bundle,"session.json")),nodes=new Map(csr.turns.map(t=>[t.id,t]));
  for(const t of csr.turns)for(const b of t.content){
    if(b.type!=="tool_result")continue;
    let parent=nodes.get(t.origin.parentId);
    while(parent){
      const call=parent.content.find(c=>c.type==="tool_call" && c.id===b.callId);
      if(call){actualEdges.push(call.id+":"+call.arguments.token+":"+b.content+":"+!!b.isError);break;}
      parent=nodes.get(parent.origin.parentId);
    }
  }
  check("tool/associated-edges",actualEdges.sort(),expectedEdges.sort());
  check("tool/unfinished",csr.turns.at(-1).content,[{type:"tool_call",id:"no-result",name:"lookup",arguments:{token:44}}]);
  check("tool/forks",nodes.get("left").origin.branchId!==nodes.get("right").origin.branchId,true);
  const report=await read(path.join(graph.bundle,"report.json"));
  check("tool/loss-paths",report.ledger.downgraded.filter(i=>i.code==="TOOL_AS_HISTORY").map(i=>i.path),
    csr.turns.flatMap((t,i)=>t.content.flatMap((b,j)=>b.type.startsWith("tool_")?["/turns/"+i+"/content/"+j]:[])));
}
const negative=[];
async function refuse(label,source,data,expected){
  const dir=path.join(out,"reject-"+label);
  await fs.mkdir(dir);
  const input=path.join(dir,"record.jsonl");await fs.writeFile(input,data);
  const c=await convert(dir,source,"codex",input);
  check("refusal/"+label,c.diagnostic[0]?.code,expected);
  negative.push({label,expected,actual:c.diagnostic[0]?.code});
}
await refuse("orphan","claude-code",lines([...rows,msg("orphan","root","user",[answer("a","x")])]),"BROKEN_TOOL_REFERENCE");
await refuse("redacted","claude-code",lines([msg("u",null,"assistant",[{type:"redacted_thinking",data:"fake"}])]),"UNINTERPRETED_CONTENT");
await refuse("encrypted","codex",codexFile([])+JSON.stringify({type:"response_item",payload:{type:"reasoning",summary:[],encrypted_content:"invented"}}),"UNINTERPRETED_CONTENT");
await refuse("truncated","codex",codexFile([])+"{","INVALID_INPUT");
const failureChecks=[];
for(const [fault,code] of Object.entries({auth:"AUTH_REQUIRED",quota:"QUOTA_EXHAUSTED",rate:"DRIVER_FAILED",model:"DRIVER_FAILED",signature:"DRIVER_FAILED",
  limit:"CONTEXT_LIMIT",incomplete:"DRIVER_FAILED",late:"DRIVER_FAILED",cancel:"CANCELLED",mismatch:"SESSION_MISMATCH"})){
  const reg=createDriverRegistry({codex:{command:process.execPath,prefix:[path.join(root,"tools/m31/fault-agent.mjs"),fault]}});
  const opts=["run","--agent","codex","--cwd",out,"--prompt",fault==="limit"?"x".repeat(1025):"x","--json"];
  if(fault==="mismatch")opts.push("--session","11111111-1111-4111-8111-111111111111");
  const r=await cli(opts,fault==="cancel"?AbortSignal.timeout(500):undefined,reg);
  const err=JSON.parse(r.stderr.at(-1)??"{}");
  check("driver/"+fault,[r.status,err.code,r.stdout.includes('"type":"done"')],[3,code,false]);
  failureChecks.push({fault,code:err.code,status:r.status});
}
check("grader/unknown-equivalence",score('{"fee":"not disclosed","port":"39"}',{fee:"unknown",port:39}).matches,{fee:true,port:true});
check("grader/contradiction",score('{"port":12}',{port:39}).matches.port,false);
const sessionDriver=createDriverRegistry({codex:{command:process.execPath,prefix:[path.join(root,"tools/m31/fault-agent.mjs"),"session-map"]}});
async function sessionProbe(prompt,id) {
  const args=["run","--agent","codex","--cwd",out,"--json","--prompt",prompt];
  if(id)args.push("--session",id);
  const r=await cli(args,undefined,sessionDriver);
  return {status:r.status,events:r.stdout.trim().split("\n").map(line=>JSON.parse(line))};
}
const older=await sessionProbe("case-one"),newer=await sessionProbe("case-two");
const olderId=older.events[0].id,newerId=newer.events[0].id;
check("sessions/distinct",olderId!==newerId,true);
const resumed=await sessionProbe("recall",olderId);
check("sessions/explicit-older",[resumed.status,resumed.events[0].id,resumed.events[1].text],[0,olderId,"case-one"]);
for(const [server,revision,key] of [["m31blue","1","id"],["m31green","2","ticket"]]){
  const log=path.join(out,server+".jsonl");
  const methods=[["initialize",{protocolVersion:"2025-11-25"}],["tools/list",{}],
    ["tools/call",{name:"lookup",arguments:{[key]:"fresh"}}],["tools/call",{name:"lookup",arguments:{[key]:"wrong"}}],
    ["resources/read",{uri:"m31://"+server+"/receipt"}]];
  const request=methods.map(([method,params],i)=>JSON.stringify({jsonrpc:"2.0",id:i+1,method,params})).join("\n")+"\n";
  const proc=spawnSync(process.execPath,[path.join(root,"tools/m31/mcp-server.mjs"),server,revision,log],{input:request,encoding:"utf8",timeout:10000});
  check(server+"/exit",proc.status,0);
  const replies=proc.stdout.trim().split("\n").map(s=>JSON.parse(s).result);
  check(server+"/schema",replies[1].tools.map(t=>[t.name,t.inputSchema.required]),[["lookup",[key]]]);
  check(server+"/receipt",replies[2].structuredContent.receipt,replies[2].content[0].text);
  check(server+"/resource",replies[2].content[1].uri,replies[4].contents[0].uri);
  check(server+"/error",replies[3].isError,true);
  check(server+"/audited-calls",(await fs.readFile(log,"utf8")).trim().split("\n").map(s=>JSON.parse(s).ok),[true,false]);
}
const results={schemaVersion:1,assertions,lossRows,expectedEdges,actualEdges,negative,failureChecks};
await save(path.join(out,"results.json"),results);
console.log(JSON.stringify({output:out,passed:assertions.filter(a=>a.pass).length,total:assertions.length,failures:assertions.filter(a=>!a.pass)},null,2));
if(assertions.some(a=>!a.pass))process.exitCode=1;
