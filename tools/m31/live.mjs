import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { agents, cases, models } from "./cases.mjs";
import { campaign, cli, save } from "./harness.mjs";
import { paired, length, modelSwitch } from "./experiments.mjs";

const {values}=parseArgs({options:{campaign:{type:"string",default:"first"},scenario:{type:"string",default:"all"},route:{type:"string"},seed:{type:"string"},live:{type:"boolean"}}});
if(!values.live) throw Error("Real accounts are used. Pass --live to start.");
const base=campaign(values.campaign), scenario=values.scenario;
const scenarios=["paired","length","switch","source","relay","capability","retest","verify-tool"];
if(scenario!=="all" && !scenarios.includes(scenario))throw Error("Unknown scenario");
if(values.seed && !Object.hasOwn(cases.seeds,values.seed))throw Error("Unknown seed");
const routes=agents.flatMap(a=>agents.filter(b=>a!==b).map(b=>a+":"+b));
if(values.route && !routes.includes(values.route))throw Error("Expected --route source:target");
await fs.mkdir(base,{recursive:true});
const versions=JSON.parse((await cli(["drivers","--json"])).stdout);
await save(path.join(base,"environment-"+scenario+".json"),{date:new Date().toISOString(),platform:process.platform,node:process.version,versions,models});
async function execute(target) {
  const choose=s=>scenario===s || scenario==="all";
  if(choose("source") && (!values.route || values.route.startsWith(target+":"))){
    await (await import("./native.mjs")).sourceCapture(base,target,values.seed);
  }
  if(values.route && !values.route.endsWith(":"+target))return;
  if(scenario==="verify-tool"){if(target==="antigravity")await (await import("./native.mjs")).verifyToolFailure(base);return;}
  if(scenario==="retest"){await (await import("./native.mjs")).retest(base,target);return;}
  if(choose("paired"))for(const source of agents.filter(a=>a!==target)) {
    if(values.route && values.route!==source+":"+target)continue;
    for(const seed of values.seed?[values.seed]:Object.keys(cases.seeds))await paired(base,source,target,seed);
  }
  if(choose("length"))for(const k of [4,16,64,128])await length(base,target,k);
  if(choose("switch"))await modelSwitch(base,target);
  if(choose("relay") || choose("capability")){
    const extra=await import("./native.mjs");
    if(choose("capability"))await extra.capability(base,target);
    if(choose("relay") && target==="antigravity")await extra.relay(base);
  }
}
const settled=await Promise.allSettled(agents.map(execute));
for(const r of settled)if(r.status==="rejected"){console.error(r.reason);process.exitCode=1;}
