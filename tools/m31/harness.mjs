import fs from "node:fs/promises";
import path from "node:path";
import { runCli } from "../../packages/cli/dist/index.js";
import { AgentDriver, createDriverRegistry, DriverRegistry } from "../../packages/drivers/dist/index.js";
import { agents, hash, models, root } from "./cases.mjs";

const caps = { source:9, paired:48, length:24, switch:12, capability:12, relay:4, retest:11 };
export async function read(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
export async function save(file, value) {
  await fs.mkdir(path.dirname(file), {recursive:true});
  if (path.basename(file)==="result.json") {
    try {
      const prior=await fs.readFile(file);
      await fs.writeFile(path.join(path.dirname(file),"observation-"+hash(prior).slice(0,16)+".json"),prior,{flag:"wx"});
    } catch(e){if(!["ENOENT","EEXIST"].includes(e.code))throw e;}
  }
  const temp = file + "." + process.pid + ".tmp";
  await fs.writeFile(temp, JSON.stringify(value,null,2)+"\n");
  await fs.rename(temp,file);
}
export async function cli(args, signal, registry) {
  let stdout = "", stderr=[];
  const status = await runCli(args,s=>{stdout+=s}, {stdin:(async function*(){})(),stderr:s=>stderr.push(s),
    stdout:async bytes=>{stdout+=Buffer.from(bytes).toString("utf8")}, ...(signal && {signal})},registry);
  return {status,stdout,stderr};
}
export async function convert(dir, source, target, input) {
  const bundle = path.join(dir,"bundle-"+target);
  await fs.mkdir(dir,{recursive:true});
  // Each conversion uses an exclusive new directory, including repeated attempts.
  const out = await fs.mkdtemp(bundle+"-");
  const destination = path.join(out,"export");
  const result = await cli(["convert-session","--from",source,"--to",target,"--input",input,"--output",destination]);
  const diagnostic = result.stderr.map(s=>{try{return JSON.parse(s)}catch{return {message:s}}});
  return {status:result.status, diagnostic, ...(result.status===0 && {bundle:destination,summary:JSON.parse(result.stdout)})};
}
export function campaign(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(name)) throw Error("Invalid campaign name");
  return path.join(root,".tmp","m31",name);
}
async function reserve(base, group, label) {
  if (!Object.hasOwn(caps,group)) throw Error("Unknown budget group");
  const folder=path.join(base,"budget",group);
  await fs.mkdir(folder,{recursive:true});
  for(let i=1;i<=caps[group];i++) {
    try { await fs.writeFile(path.join(folder,String(i)),label,{flag:"wx"});return i; }
    catch(e){if(e.code!=="EEXIST")throw e;}
  }
  throw Error("Round budget exhausted: "+group);
}
export async function turn({base,group,label,agent,cwd,prompt,bundle,session,model=models[agent],registry}) {
  if (!agents.includes(agent) || !/^[a-z0-9-]+$/.test(label)) throw Error("Invalid experiment label");
  const evidence=path.join(base,"turns",label+".json");
  const context=bundle ? await fs.readFile(path.join(bundle,"context.md"),"utf8") : "";
  if(/sk-[A-Za-z0-9_-]{18,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(context+prompt))throw Error("Unexpected credential material in evaluation input");
  const bytes=Buffer.byteLength(context+"\n## Current user request\n\n"+prompt);
  if (bytes > 128*1024*4) throw Error("Estimated prompt exceeds 128 Ki tokens (UTF-8 bytes / 4)");
  const fingerprint=hash(JSON.stringify([label,agent,model,session,context,prompt,cwd]));
  try {
    const cached=await read(evidence);
    if(cached.fingerprint!==fingerprint)throw Error("Experiment changed: use a new campaign or retest label");
    return cached;
  } catch(e){if(e.code!=="ENOENT") throw e;}
  await fs.mkdir(cwd,{recursive:true});
  const claims=path.join(base,"claims");
  await fs.mkdir(claims,{recursive:true});
  try { await fs.writeFile(path.join(claims,label),fingerprint,{flag:"wx"}); }
  catch(e){
    if(e.code==="EEXIST")throw Error("Turn already reserved or interrupted: "+label+". Inspect its evidence before scheduling a retest.");
    throw e;
  }
  const slot=await reserve(base,group,label);
  const start=Date.now();
  const args=["run","--agent",agent,"--cwd",cwd,"--prompt",prompt,"--json","--model",model];
  if(bundle)args.push("--bundle",bundle);
  if(session)args.push("--session",session);
  const driver=(registry ?? createDriverRegistry()).get(agent);
  const wire={models:[],compactions:[],terminal:[]};
  const plugin={...driver.plugin,invocation(opts){
    const request=driver.plugin.invocation(opts);
    wire.stdinSha256=hash(request.input);
    wire.stdinBytes=Buffer.byteLength(request.input);
    return request;
  },decoder(){
    const decode=driver.plugin.decoder();
    return r=>{
      const observedModel=r.init?.model ?? r.message?.model ?? (r.subtype==="init"?r.model:undefined);
      if(typeof observedModel==="string" && !wire.models.includes(observedModel))wire.models.push(observedModel);
      const kind=r.step_update?.step_type ?? r.subtype ?? r.type ?? r.event;
      if(typeof kind==="string" && /compact/i.test(kind))wire.compactions.push(kind);
      if(r.event==="result")wire.terminal.push({status:r.result?.status,error:r.result?.error});
      return decode(r);
    };
  }};
  const instrumented=new DriverRegistry().register(new AgentDriver(plugin,driver.executable));
  const result=await cli(args,AbortSignal.timeout(240000),instrumented);
  const events=result.stdout.trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
  const id=events.find(e=>e.type==="session")?.id;
  const answer=events.filter(e=>e.type==="text").map(e=>e.text).join("");
  const row={label,group,slot,agent,model,fingerprint,estimatedTokens:Math.ceil(bytes/4),durationMs:Date.now()-start,
    status:result.status,id,answer,terminal:events.at(-1)?.type,tools:events.filter(e=>e.type==="tool"),usage:events.filter(e=>e.type==="usage"),
    errors:result.stderr,contextHash:bundle?hash(context):null,wire};
  await save(evidence,row);
  console.log(label+" "+row.status+" "+row.durationMs+"ms");
  return row;
}
