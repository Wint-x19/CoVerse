import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { agents, cases, hash, score } from "./cases.mjs";
import { campaign, read, save } from "./harness.mjs";
import { lengthSpec } from "./experiments.mjs";

const {values}=parseArgs({options:{campaign:{type:"string",default:"first"},offline:{type:"string"}}});
const base=campaign(values.campaign);
async function optional(file){try{return await read(file);}catch(e){if(e.code==="ENOENT")return null;throw e;}}
const rows=new Map();
for(const file of await fs.readdir(path.join(base,"turns"))){
  if(!file.endsWith(".json"))continue;
  const row=await read(path.join(base,"turns",file));
  rows.set(row.label,row);
}
function outcome(r){
  if(!r)return "not-run";
  if(r.status===0)return r.answer.trim()?"complete":r.tools.length?"tool-only-terminal-success":"empty-terminal-success";
  const err=r.errors.map(s=>JSON.parse(s)).at(-1);
  if(err?.code==="CANCELLED")return "evaluation-timeout";
  if(/503|no capacity|resource.exhausted|rate limit|429/i.test(err?.message))return "service-unavailable";
  return err?.code??"runtime-error";
}
function describe(r){
  if(!r)return {outcome:"not-run"};
  return {label:r.label,outcome:outcome(r),status:r.status,modelRequested:r.model,modelObserved:r.wire?.models??null,
    estimatedTokens:r.estimatedTokens,usage:r.usage.map(e=>e.usage),ms:r.durationMs,inputFingerprint:r.fingerprint,
    stdinHash:r.wire?.stdinSha256??null,terminal:r.terminal??null,compactionEvents:r.wire?.compactions??null,
    observedTools:r.tools.map(e=>[e.name,e.state]),answerHash:hash(r.answer)};
}
// Adjudication accepts equivalent field names and nesting. The gold stamp strings and arithmetic never change.
function lengthScore(answer,expected){
  let v;
  try{v=JSON.parse(answer.trim());}catch{try{v=JSON.parse(answer.match(/\x60{3}(?:json)?\s*([\s\S]*?)\x60{3}/i)?.[1]);}catch{return score("",expected).matches;}}
  if(!v || typeof v!=="object")return score("",expected).matches;
  const stamp=(x)=>x && typeof x==="object"?x.stamp:x;
  return score(JSON.stringify({start:stamp(v.start??v.start_stamp??v.head_stamp),middle:stamp(v.middle??v.middle_stamp),
    end:stamp(v.end??v.end_stamp??v.tail_stamp),latest:v.latest??v.latest_port??v.port??v.end?.port,join:v.join}),expected).matches;
}
const summary={schemaVersion:1,campaign:values.campaign,environment:await optional(path.join(base,"environment-paired.json")),
  budgets:{},paired:[],length:[],source:[],capability:[],switch:[],relay:{},retests:[],turns:[...rows.values()].map(describe).sort((a,b)=>a.label.localeCompare(b.label))};
for(const group of await fs.readdir(path.join(base,"budget")))summary.budgets[group]=(await fs.readdir(path.join(base,"budget",group))).length;
for(const target of agents){
  for(const seed of Object.keys(cases.seeds)){
    const native=await optional(path.join(base,"source","source-"+target+"-"+seed,"result.json"));
    if(native){
      const targets={};
      for(const [id,c] of Object.entries(native.targets)){
        const session=c.bundle && await read(path.join(c.bundle,"session.json"));
        const ctx=c.bundle && await fs.readFile(path.join(c.bundle,"context.md"),"utf8");
        targets[id]={stage:c.stage,status:c.status,code:c.diagnostic?.[0]?.code,path:c.diagnostic?.[0]?.path,sourceHash:c.sha256,
          format:session?.meta.agentFormatVersion,modelRecorded:session?.meta.model,statistics:c.summary?.statistics,
          storySentencesPresent:ctx?cases.seeds[seed].history.map(([,text])=>ctx.includes(text)):null};
      }
      summary.source.push({agent:target,seed,sourceStatus:native.sourceStatus,targets});
    }
    for(const source of agents.filter(a=>a!==target)){
      const d={source,target,seed};
      for(const arm of ["reference","injection"]){
        const label="paired-"+source+"-"+target+"-"+seed+"-"+arm;
        const a=rows.get(label+"-1"),b=rows.get(label+"-2");
        const semantic=score(a?.answer??"",cases.seeds[seed].gold);
        const sameId=b?.status===0 && a?.id===b.id;
        const followCorrect=sameId && b.answer.trim().toLowerCase()===cases.seeds[seed].gold.label;
        d[arm]={first:outcome(a),follow:outcome(b),score:semantic,sameId,followCorrect,
          complete:a?.status===0 && Object.values(semantic.matches).every(Boolean) && followCorrect};
      }
      summary.paired.push(d);
    }
  }
  for(const k of [4,16,64,128]){
    const d={target,k};
    for(const arm of ["reference","injection"]){
      const row=rows.get("length-"+target+"-"+k+"-"+arm);
      const {expected}=lengthSpec(k);
      d[arm]={outcome:outcome(row),strict:score(row?.answer??"",expected).matches,adjudicated:lengthScore(row?.answer??"",expected)};
    }
    summary.length.push(d);
  }
  for(const variant of ["installed","absent"]){
    const label="capability-"+target+"-"+variant;
    const c=await optional(path.join(base,"capability",label,"result.json"));
    if(c)summary.capability.push({target,variant,past:outcome(rows.get(c.past)),current:outcome(rows.get(c.current)),
      history:score(rows.get(c.past)?.answer??"",{receipt:"old-332",skill:"listed"}).matches,replays:c.replay,wrongServer:c.wrongBindings,
      calls:c.observed.length,successReceipts:c.receiptConfirmed,skillReference:c.skillReferenceConfirmed,absenceReported:c.absentAcknowledged,
      skillToolObserved:rows.get(c.current)?.tools.some(t=>t.name.toLowerCase()==="skill")??false});
  }
  for(const sub of ["same","changed"]){
    const a=rows.get("switch-"+target+"-"+sub+"-1"),b=rows.get("switch-"+target+"-"+sub+"-2");
    summary.switch.push({target,sub,first:outcome(a),follow:outcome(b),retained:b?.status===0 && a?.id===b.id && b.answer.trim()===hash("switch-"+target+"-"+sub).slice(0,12)});
  }
  const r=await optional(path.join(base,"retest",target,"result.json"));
  if(r)summary.retests.push({target,relay:r.relay,switched:r.switched,native:r.nativeSource,
    invalidModelRejected:r.modelRejected,greenConfirmed:r.currentTool.confirmed,calls:r.currentTool.calls.length});
}
const relay=await optional(path.join(base,"relay","result.json"));
if(relay)summary.relay={firstConversion:relay.first.status,secondConversion:relay.second?.status,bFirst:outcome(rows.get(relay.bFirst)),
  bFollow:outcome(rows.get(relay.bFollow)),cFirst:outcome(rows.get(relay.cFirst)),firstScore:relay.score?.matches,previous:relay.previous??null};
if(values.offline){
  const o=await read(values.offline);
  const expected=o.lossRows.flatMap(r=>r.expected.map(v=>r.label+" "+v));
  const actual=o.lossRows.flatMap(r=>r.actual.map(v=>r.label+" "+v));
  summary.offline={passed:o.assertions.filter(a=>a.pass).length,total:o.assertions.length,lossExpected:expected.length,lossFound:actual.length,
    lossMatched:actual.filter(v=>expected.includes(v)).length,toolEdges:{expected:o.expectedEdges.length,actual:o.actualEdges.length,
      matched:o.actualEdges.filter(e=>o.expectedEdges.includes(e)).length},negative:o.negative,controlledFailures:o.failureChecks,
    assertions:o.assertions.map(a=>[a.name,a.pass])};
}
await save(path.join(base,"summary.json"),summary);
console.log("Report: "+path.join(base,"summary.json")+" ("+rows.size+" recorded model turns)");
