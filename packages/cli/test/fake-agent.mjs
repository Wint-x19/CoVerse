import { writeFileSync } from "node:fs";

const [agent, ...args] = process.argv.slice(2);
if (args.includes("--version")) { console.log("fixture-1"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
for await (const text of process.stdin) input += text;
writeFileSync("received.json", JSON.stringify({ args, input, cwd: process.cwd() }));
const emit = event => console.log(JSON.stringify(event));
const id = "11111111-1111-4111-8111-111111111111";
const greeting = "测试成功";
switch (agent) {
  case "codex":
    emit({ type: "thread.started", thread_id: id });
    emit({ type: "item.completed", item: { type: "agent_message", text: greeting } });
    emit({ type: "turn.completed", usage: { input_tokens: 12 } });
    break;
  case "claude-code":
    emit({ type: "system", subtype: "init", session_id: id });
    emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: greeting } } });
    emit({ type: "assistant", message: { content: [{ type: "text", text: greeting }] } });
    emit({ type: "result", subtype: "success", is_error: false, result: greeting, session_id: id, usage: { input_tokens: 12 } });
    break;
  case "antigravity":
    emit({ event: "init", conversation_id: id });
    emit({ event: "step_update", step_update: { conversation_id: id, step_type: "agent_response", text_delta: greeting } });
    emit({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: greeting, usage: { input_tokens: 12 } } });
    break;
  default: process.exitCode = 1;
}
