import { driverError, object, string, targetFailure, usage, type DriverEvent, type DriverPlugin } from "./driver.js";

export const antigravity: DriverPlugin = {
  id: "antigravity", command: "agy", verifiedVersions: [],
  invocation({ model, session, prompt, attachmentDirectory }) {
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands"];
    if (model) args.push("--model", model);
    if (session) args.push("--conversation", session);
    if (attachmentDirectory) args.push("--add-dir", attachmentDirectory);
    return { args, input: JSON.stringify({ event: "user", message: { content: prompt } }) + "\n" };
  },
  decoder() {
    let anyText = false;
    return record => {
      if (record.event === "init") return [{ type: "session", id: string(record.conversation_id) }];
      if (record.event === "step_update") {
        const step = object(record.step_update);
        const events: DriverEvent[] = [{ type: "session", id: string(step.conversation_id) }];
        if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
          anyText = true;
          events.push({ type: "text", text: step.text_delta });
        }
        if (step.step_type === "tool") events.push({ type: "tool", name: string(step.tool_name), state: string(step.state) });
        return events;
      }
      if (record.event === "result") {
        const result = object(record.result);
        if (result.status !== "SUCCESS") throw targetFailure(String(result.response ?? JSON.stringify(result.error ?? result.status)));
        const events: DriverEvent[] = [{ type: "session", id: string(result.conversation_id) }];
        if (!anyText && typeof result.response === "string") events.push({ type: "text", text: result.response });
        return [...events, ...usage(result.usage), { type: "done" }];
      }
      throw driverError("Unsupported Antigravity event: " + record.event);
    };
  },
};
