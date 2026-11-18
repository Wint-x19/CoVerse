import { driverError, finalText, object, string, targetFailure, usage, type DriverEvent, type DriverPlugin } from "./driver.js";

export const antigravity: DriverPlugin = {
  id: "antigravity", command: "agy", verifiedVersions: ["1.5.11"],
  invocation({ model, session, prompt, attachmentDirectory }) {
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands"];
    if (model) args.push("--model", model);
    if (session) args.push("--conversation", session);
    if (attachmentDirectory) args.push("--add-dir", attachmentDirectory);
    return { args, input: JSON.stringify({ event: "user", message: { content: prompt } }) + "\n" };
  },
  decoder() {
    let stepText = "", stepIndex: unknown, failedTool: string | undefined;
    return record => {
      if (record.event === "init") return [{ type: "session", id: string(record.conversation_id) }];
      if (record.event === "step_update") {
        const step = object(record.step_update);
        const events: DriverEvent[] = [{ type: "session", id: string(step.conversation_id) }];
        if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
          if (stepIndex !== step.step_index) { stepText = ""; stepIndex = step.step_index; }
          stepText += step.text_delta;
          failedTool = undefined;
          events.push({ type: "text", text: step.text_delta });
        }
        if (step.step_type === "tool") {
          const name = string(step.tool_name), state = string(step.state);
          if (state === "ERROR") failedTool = name;
          if (state === "DONE") failedTool = undefined;
          events.push({ type: "tool", name, state });
        }
        return events;
      }
      if (record.event === "result") {
        const result = object(record.result);
        if (result.status !== "SUCCESS") {
          const detail = typeof result.error === "string" ? result.error : JSON.stringify(result.error);
          throw targetFailure("Antigravity terminal status " + String(result.status) + (detail ? ": " + detail : ""));
        }
        if (failedTool && !result.response) throw driverError("Antigravity ended after a failed tool without a response: " + failedTool);
        const events: DriverEvent[] = [{ type: "session", id: string(result.conversation_id) }];
        events.push(...finalText(stepText, result.response));
        return [...events, ...usage(result.usage), { type: "done" }];
      }
      throw driverError("Unsupported Antigravity event: " + record.event);
    };
  },
};
