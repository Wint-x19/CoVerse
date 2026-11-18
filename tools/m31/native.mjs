import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDriverRegistry } from "../../packages/drivers/dist/index.js";
import { agents, cases, fixture, hash, reference, root, score, codexFile } from "./cases.mjs";
import { convert, read, save, turn } from "./harness.mjs";

async function locateSession(agent,id,cwd) {
  if(!/^[a-f0-9-]{36}$/i.test(id))throw Error("Missing target UUID");
  if(agent==="antigravity")return path.join(os.homedir(),".gemini","antigravity-cli","conversations",id+".db");
  if(agent==="claude-code")return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(),".claude"),"projects",cwd.replace(/[^a-zA-Z0-9]/g,"-"),id+".jsonl");
  const now=new Date();
  for(const offset of [0,-1,1]){
    const date=new Date(now.getTime()+offset*86400000);
    const folder=path.join(process.env.CODEX_HOME ?? path.join(os.homedir(),".codex"),"sessions",...date.toISOString().slice(0,10).split("-"));
    const names=await fs.readdir(folder).catch(()=>[]);
    const match=names.find(n=>n.endsWith("-"+id+".jsonl")||n.endsWith("-"+id+".jsonl.zst"));
    if(match)return path.join(folder,match);
  }
  throw Error("No rollout matching the dedicated session UUID");
}
async function observe(base,agent,target,row,cwd,label) {
  if(!row?.id)return {stage:"source-run",status:row?.status??1};
  try {
    const input=await locateSession(agent,row.id,cwd);
    const c=await convert(path.join(base,"native",label),agent,target,input);
    return {stage:"convert-session",inputName:path.basename(input),sha256:hash(await fs.readFile(input)),...c};
  }catch(e){return {stage:"locate-or-read",status:1,diagnostic:String(e.message)};}
}
export async function sourceCapture(base, agent, selectedSeed) {
  for(const seed of selectedSeed?[selectedSeed]:Object.keys(cases.seeds)){
    const history=cases.seeds[seed].history, label="source-"+agent+"-"+seed;
    const cwd=path.join(base,"source",label,"work");
    const opts={base,group:"source",agent,cwd};
    const split=seed==="17";
    let row=await turn({...opts,label:label+"-1",prompt:reference(split?history.slice(0,2):history)+"\nRetain the case for later. Reply ACK only, no tools."});
    if(split && row.status===0)row=await turn({...opts,label:label+"-2",session:row.id,prompt:history[2][1]+" Reply ACK only."});
    const targets={};
    for(const target of agents.filter(a=>a!==agent))targets[target]=await observe(base,agent,target,row,cwd,label+"-"+target);
    await save(path.join(base,"source",label,"result.json"),{agent,seed,sourceStatus:row.status,targets});
  }
}
export async function relay(base) {
  const dir=path.join(base,"relay"), cwd=path.join(dir,"B-work");
  const first=await convert(path.join(dir,"A"),"codex","claude-code",fixture("codex",17));
  const result={first};
  if(first.status===0){
    const opts={base,group:"relay",agent:"claude-code",cwd};
    const b=await turn({...opts,label:"relay-b1",bundle:first.bundle,prompt:"Give the current shipping label only. Do not use tools."});
    result.bFirst=b.label;
    if(b.status===0){
      const nonce=hash("relay-"+base).slice(0,12);
      const next=await turn({...opts,label:"relay-b2",session:b.id,prompt:"Mira changes port to 84 and adds seal "+nonce+". Keep cargo and region. Reply ACK, no tools."});
      result.bFollow=next.label;
      result.second=await observe(base,"claude-code","antigravity",next,cwd,"relay-b-c");
      if(next.status===0 && result.second.status===0){
        const ctx=await fs.readFile(path.join(result.second.bundle,"context.md"),"utf8");
        if(/(?:sk-[A-Za-z0-9_-]{18,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(ctx))throw Error("Sensitive material in dedicated transcript");
        const last={base,group:"relay",agent:"antigravity",cwd:path.join(dir,"C-work")};
        const c=await turn({...last,label:"relay-c1",bundle:result.second.bundle,prompt:"Return JSON with region, cargo, port, owner (person who last corrected it) and seal. No tools."});
        result.cFirst=c.label;
        result.score=score(c.answer,{region:"north",cargo:"jade",port:84,owner:"Mira",seal:nonce});
        if(c.status===0){
          const follow=await turn({...last,label:"relay-c2",session:c.id,prompt:"What port did Nora set before Mira changed it? Just the number. No tools."});
          result.previous=follow.status===0 && follow.answer.trim()==="39";
        }
      }
    }
  }
  await save(path.join(dir,"result.json"),result);
}

async function setup(agent,cwd,log,installed) {
  const registry=createDriverRegistry();
  const servers={};
  if(installed){
    const skill=path.join(cwd,agent==="claude-code"?".claude":".agents","skills","dispatch-check");
    await fs.mkdir(path.join(skill,"references"),{recursive:true});
    await fs.writeFile(path.join(skill,"SKILL.md"),"---\nname: dispatch-check\ndescription: Read the current dispatch revision when explicitly requested.\n---\nRead references/revision.txt and quote its exact marker.");
    await fs.writeFile(path.join(skill,"references","revision.txt"),"dispatch-v2-"+hash(cwd).slice(0,6));
    for(const [server,revision] of [["m31blue","1"],["m31green","2"]])servers[server]={command:process.execPath,args:[path.join(root,"tools/m31/mcp-server.mjs"),server,revision,log]};
  }
  const config={mcpServers:servers};
  if(agent==="antigravity"){
    await save(path.join(cwd,".agents","mcp_config.json"),config);return registry;
  }
  const exe=registry.get(agent).executable;
  if(!exe)return registry;
  const prefix=[];
  if(agent==="claude-code"){
    const file=path.join(cwd,"mcp.json");await save(file,config);
    prefix.push("--strict-mcp-config","--mcp-config",file,"--allowedTools=mcp__m31blue__lookup,mcp__m31green__lookup,Read,Skill");
  }else for(const [name,s] of Object.entries(servers)){
    prefix.push("-c","mcp_servers."+name+".command="+JSON.stringify(s.command),"-c","mcp_servers."+name+".args="+JSON.stringify(s.args));
  }
  return createDriverRegistry({[agent]:{command:exe.command,prefix}});
}
export async function capability(base,target) {
  for(const installed of [false,true]){
    const variant=installed?"installed":"absent",label="capability-"+target+"-"+variant;
    const dir=path.join(base,"capability",label), cwd=path.join(dir,"work"),log=path.join(dir,"calls.jsonl");
    await fs.mkdir(cwd,{recursive:true});
    const registry=await setup(target,cwd,log,installed);
    const input=path.join(dir,"history.jsonl");
    const headers=codexFile([["user","The source listed the dispatch-check skill revision v1."]]);
    const items=[{type:"function_call",call_id:"past",name:"mcp__m31blue__lookup",arguments:'{"id":"archived"}'},
      {type:"function_call_output",call_id:"past",output:"receipt old-332"}, {type:"message",role:"assistant",content:[{type:"output_text",text:"dispatch-check v1 was listed only; I did not invoke the skill."}]}];
    await fs.writeFile(input,headers+items.map(payload=>JSON.stringify({type:"response_item",payload})).join("\n")+"\n");
    const c=await convert(dir,"codex",target,input);
    if(c.status!==0)throw Error("Capability setup conversion failed");
    const opts={base,group:"capability",agent:target,cwd,registry};
    const calls=async()=> (await fs.readFile(log,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
    const before=(await calls()).length;
    const past=await turn({...opts,label:label+"-1",bundle:c.bundle,prompt:"Use history only, no tools. Give JSON with receipt (old receipt), skill (listed or invoked)."});
    const after=await calls();
    const current=past.status===0 && await turn({...opts,label:label+"-2",session:past.id,prompt:"Now use only the current dispatch-check skill and m31green lookup if available. Read the skill reference marker, then use m31green lookup with ticket fresh. If unavailable say unavailable. Never use blue or another tool to simulate an MCP receipt. Give the exact marker and receipt. Do not inspect files outside this workspace."});
    const fresh=(await calls()).slice(after.length);
    await save(path.join(dir,"result.json"),{target,installed,past:past.label,current:current?.label,historyScore:score(past.answer,{receipt:"old-332",skill:"listed"}),
      replay:after.length-before,unrequestedTools:past.tools,observed:fresh,wrongBindings:fresh.filter(x=>x.server!=="m31green").length,
      receiptConfirmed:!!current && fresh.some(x=>x.ok&&current.answer.includes(x.receipt)),skillReferenceConfirmed:!!current && current.answer.includes("dispatch-v2-"+hash(cwd).slice(0,6)),
      absentAcknowledged:!!current && /unavailable|not available|not installed|not accessible/i.test(current.answer)});
  }
}

// A separate, bounded investigation ledger. Never replace an original failed turn.
export async function retest(base,target) {
  const dir=path.join(base,"retest",target);
  const opts={base,agent:target,group:"retest",cwd:path.join(dir,"work")};
  const result={target};
  if(target==="antigravity"){
    const relayResult=await read(path.join(base,"relay","result.json"));
    if(relayResult.second?.status===0){
      const changed={...opts,model:"claude-sonnet-4-6"};
      const c=await turn({...changed,label:"retest-relay-c1",bundle:relayResult.second.bundle,
        prompt:"Return JSON with region, cargo, port, owner (person who last corrected it) and seal. No tools."});
      result.relay={first:c.label,score:score(c.answer,{region:"north",cargo:"jade",port:84,owner:"Mira",seal:hash("relay-"+base).slice(0,12)})};
      if(c.status===0){
        const f=await turn({...changed,label:"retest-relay-c2",session:c.id,prompt:"What port did Nora set before Mira changed it? Just the number. No tools."});
        result.relay.follow=f.label;
        result.relay.retained=f.status===0 && f.id===c.id && f.answer.trim()==="39";
      }
    }
    const mark=hash("switch-probe").slice(0,12);
    const a=await turn({...opts,label:"retest-switch-agy1",model:"claude-sonnet-4-6",prompt:"Retain marker "+mark+". Reply OK only."});
    if(a.status===0){
      const b=await turn({...opts,label:"retest-switch-agy2",model:"gemini-3.8-flash-low",session:a.id,prompt:"Return my previous marker only."});
      result.switched={first:a.label,follow:b.label,retained:b.status===0 && b.id===a.id && b.answer.trim()===mark};
    }
  }else{
    const source=target==="codex"?"claude-code":"antigravity";
    const sample=await read(path.join(base,"source","source-"+source+"-53","result.json"));
    const c=sample.targets[target];
    if(c.status===0){
      const row=await turn({...opts,label:"retest-native-"+source+"-"+target,bundle:c.bundle,prompt:cases.question});
      result.nativeSource={source,origin:"captured native session",turn:row.label,score:score(row.answer,cases.seeds[53].gold)};
    }
    if(target==="claude-code"){
      const row=await turn({...opts,label:"retest-unavailable-model",model:"coverse-unavailable-test-model",prompt:"Reply OK."});
      result.modelRejected=row.status!==0;
    }
  }
  const cwd=path.join(dir,"tool-work"),log=path.join(dir,"calls.jsonl");
  await fs.mkdir(cwd,{recursive:true});
  const registry=await setup(target,cwd,log,true);
  const probe=await turn({...opts,cwd,registry,label:"retest-green-"+target,...(target==="antigravity" && {model:"claude-sonnet-4-6"}),
    prompt:"Invoke the available MCP tool lookup on server m31green with ticket fresh exactly once; report its receipt. No other tool or skill. If the tool is missing, say unavailable."});
  const calls=(await fs.readFile(log,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
  result.currentTool={turn:probe.label,calls,confirmed:probe.status===0 && calls.length===1 && calls[0].server==="m31green" && calls[0].ok && probe.answer.includes(calls[0].receipt)};
  await save(path.join(dir,"result.json"),result);
}

export async function verifyToolFailure(base) {
  const dir=path.join(base,"retest","terminal-check"),cwd=path.join(dir,"work"),log=path.join(dir,"calls.jsonl");
  await fs.mkdir(cwd,{recursive:true});
  const registry=await setup("antigravity",cwd,log,true);
  const row=await turn({base,group:"retest",agent:"antigravity",model:"claude-sonnet-4-6",label:"retest-terminal-check",cwd,registry,
    prompt:"Invoke the available MCP tool lookup on server m31green with ticket fresh exactly once; report its receipt. No other tool or skill. If the tool is missing, say unavailable."});
  await save(path.join(dir,"result.json"),{label:row.label,status:row.status,terminal:row.terminal,tools:row.tools,wire:row.wire});
}
