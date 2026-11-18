import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const [server, revision, log] = process.argv.slice(2);
const key=revision==="2" ? "ticket" : "id";
const uri="m31://"+server+"/receipt";
const schema={type:"object",properties:{[key]:{type:"string"}},required:[key],additionalProperties:false};
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  const req=JSON.parse(line);
  if(req.id==null)continue;
  let result;
  switch(req.method){
    case "initialize": result={protocolVersion:req.params.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:server,version:revision}};break;
    case "ping": result={};break;
    case "tools/list": result={tools:[{name:"lookup",description:"Read a synthetic test receipt by "+key,inputSchema:schema,annotations:{readOnlyHint:true}}]};break;
    case "resources/list": result={resources:[{uri,name:"receipt",mimeType:"text/plain"}]};break;
    case "resources/read": result={contents:[{uri,mimeType:"text/plain",text:"Synthetic "+server+" receipt"}]};break;
    case "tools/call": {
      const args=req.params.arguments ?? {};
      const ok=req.params.name==="lookup" && Object.keys(args).length===1 && args[key]==="fresh";
      const receipt=ok ? server+"-"+randomBytes(5).toString("hex") : "invalid-"+key;
      appendFileSync(log,JSON.stringify({server,revision,args,ok,receipt})+"\n");
      result={isError:!ok,structuredContent:{receipt},content:[{type:"text",text:receipt},{type:"resource_link",uri,name:"receipt"}]};
      break;
    }
    default: console.log(JSON.stringify({jsonrpc:"2.0",id:req.id,error:{code:-32601,message:"Unknown method"}}));continue;
  }
  console.log(JSON.stringify({jsonrpc:"2.0",id:req.id,result}));
}
