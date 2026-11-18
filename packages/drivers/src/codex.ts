import { driverError, object, string, targetFailure, usage, type DriverPlugin } from "./driver.js";

export const codex: DriverPlugin = {
  id: "codex", command: "codex", verifiedVersions: [],
  invocation({ model, session, prompt, attachmentDirectory }) {
    const args = ["exec", "--json"];
    if (model) args.push("--model", model);
    if (attachmentDirectory) args.push("--add-dir", attachmentDirectory);
    if (session) args.push("resume", session);
    args.push("-");
    return { args, input: prompt };
  },
  decoder: () => record => {
    switch (record.type) {
      case "thread.started": return [{ type: "session", id: string(record.thread_id) }];
      case "item.started":
      case "item.completed": {
        const item = object(record.item);
        if (item.type === "agent_message" && record.type === "item.completed") return [{ type: "text", text: string(item.text) }];
        if (["command_execution", "mcp_tool_call", "file_change", "web_search", "collab_tool_call", "dynamic_tool_call"].includes(String(item.type))) {
          return [{ type: "tool", name: String(item.tool ?? item.type), state: String(item.status ?? record.type) }];
        }
        return [];
      }
      case "turn.completed": return [...usage(record.usage), { type: "done" }];
      case "turn.failed": throw targetFailure(string(object(record.error).message));
      case "error": {
        const message = string(record.message);
        if (/^Reconnecting\.\.\./i.test(message)) return [];
        throw targetFailure(message);
      }
      case "turn.started": return [];
      default: throw driverError("Unsupported Codex event: " + record.type);
    }
  },
};
