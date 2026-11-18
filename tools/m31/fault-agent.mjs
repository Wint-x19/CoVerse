import { createHash } from "node:crypto";
const [fault]=process.argv.slice(2);
let prompt="";
process.stdin.setEncoding("utf8");
for await(const chunk of process.stdin)prompt+=chunk;
const event=(type,fields)=>console.log(JSON.stringify({type,...fields}));
const id=createHash("md5").update(prompt).digest("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,"$1-$2-$3-$4-$5");
event("thread.started",{thread_id:id});
const errors={auth:"Authentication required",quota:"Insufficient user quota",rate:"HTTP 429 rate limit",model:"HTTP 404 model not found",signature:"Invalid signature in thinking block"};
if(fault in errors || fault==="limit" && Buffer.byteLength(prompt)>1024)event("turn.failed",{error:{message:errors[fault]??"maximum context length exceeded"}});
else {
  event("item.completed",{item:{type:"agent_message",text:"partial"}});
  if(fault==="late"){event("turn.completed",{});process.exitCode=9;}
  else if(fault==="cancel")await new Promise(resolve=>setTimeout(resolve,30000));
  else if(fault!=="incomplete")event("turn.completed",{});
}
