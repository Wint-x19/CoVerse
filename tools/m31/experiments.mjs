import fs from "node:fs/promises";
import path from "node:path";
import { cases, fixture, reference, score, hash, codexFile, alternates, models } from "./cases.mjs";
import { convert, save, turn } from "./harness.mjs";

export async function paired(base, source, target, seed) {
  const test=cases.seeds[seed], route=source+"-"+target+"-"+seed;
  const dir=path.join(base,"paired",route);
  const c=await convert(dir,source,target,fixture(source,seed));
  const order=parseInt(hash(route).slice(0,2),16)%2 ? ["reference","injection"] : ["injection","reference"];
  const arms={};
  for(const arm of order) {
    if(arm==="injection" && c.status!==0){arms[arm]={conversion:c};continue;}
    const label="paired-"+route+"-"+arm;
    const opts={base,group:"paired",agent:target,cwd:path.join(dir,"work-"+arm)};
    const first=await turn({...opts,label:label+"-1",prompt:arm==="reference"?reference(test.history)+"\n\n"+cases.question:cases.question,...(arm==="injection" && {bundle:c.bundle})});
    const follow=first.status===0 && await turn({...opts,label:label+"-2",session:first.id,prompt:cases.follow});
    arms[arm]={first:first.label,status:first.status,score:score(first.answer,test.gold),follow:follow?.label,
      sameId:!!follow && follow.status===0 && follow.id===first.id, task:!!follow && follow.status===0 && follow.answer.trim().toLowerCase()===test.gold.label};
  }
  await save(path.join(dir,"result.json"),{source,target,seed,origin:"reviewed-native-shape",order,arms,conversion:c});
}

export function lengthSpec(k) {
  // Three evidence positions, shared decoys and one real update. No fact appears in the question.
  const tag=hash("length-"+k).slice(0,6), expected={start:"iris-"+tag,middle:"amber-"+tag,end:"coral-"+tag,latest:"27",join:"iris-"+tag+"/coral-"+tag};
  const line="Other manifest: batch 4158 / route violet / port 62. This unrelated record is closed.\n";
  const filler=line.repeat(Math.floor((k*1024*4-3200)/(2*(Buffer.byteLength(line)+2))));
  const history=[["user","Project Merle. Head stamp "+expected.start+". Old port 61.\n"+filler],["assistant","Mid stamp "+expected.middle+".\n"+filler],["user","Tail stamp "+expected.end+". Final correction: port 27."]];
  const question="Only for project Merle, return JSON with start, middle and end stamp, latest port, and join (head/tail). No tools.";
  return {history,question,expected};
}
export async function length(base, target, k) {
  const {history,question,expected}=lengthSpec(k);
  const label="length-"+target+"-"+k, dir=path.join(base,"length",label);
  await fs.mkdir(dir,{recursive:true});
  const input=path.join(dir,"rollout.jsonl");
  await fs.writeFile(input,codexFile(history));
  const c=await convert(dir,"codex",target,input);
  const arms={};
  for(const arm of ["reference","injection"]) {
    if(arm==="injection" && c.status!==0){arms[arm]={conversion:c};continue;}
    const row=await turn({base,group:"length",label:label+"-"+arm,agent:target,cwd:path.join(dir,"work-"+arm),
      prompt:arm==="reference"?reference(history)+"\n"+question:question,...(arm==="injection" && {bundle:c.bundle})});
    arms[arm]={label:row.label,status:row.status,score:score(row.answer,expected)};
  }
  await save(path.join(dir,"result.json"),{target,k,arms});
}
export async function modelSwitch(base,target) {
  const result=[];
  for(const alternate of [false,true]){
    const label="switch-"+target+"-"+(alternate?"changed":"same");
    const opts={agent:target,base,group:"switch",cwd:path.join(base,"switch",label)};
    const word=hash(label).slice(0,12);
    const first=await turn({...opts,label:label+"-1",prompt:"Remember marker "+word+". Reply OK. No tools."});
    const second=first.status===0 && await turn({...opts,label:label+"-2",session:first.id,model:alternate?alternates[target]:models[target],prompt:"Reply only with my marker from before. No tools."});
    result.push({alternate,first:first.label,follow:second?.label,retained:!!second && second.status===0 && second.id===first.id && second.answer.trim()===word});
  }
  await save(path.join(base,"switch",target,"result.json"),result);
}
