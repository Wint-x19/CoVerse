import { isRecord } from "@coverse/core";
import { finalText, object, string, targetFailure, usage, type DriverEvent, type DriverPlugin } from "./driver.js";

export const claude: DriverPlugin = {
  id: "claude-code", command: "claude", verifiedVersions: [],
  invocation({ model, session, prompt, attachmentDirectory }) {
    const args = ["--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages", "--disable-slash-commands"];
    if (model) args.push("--model", model);
    if (session) args.push("--resume", session);
    if (attachmentDirectory) args.push("--add-dir", attachmentDirectory);
    return { args, input: prompt };
  },
  decoder() {
    let textStreamed = false, messageText = "";
    return record => {
      if (record.parent_tool_use_id) return [];
      if (record.type === "system" && record.subtype === "init") return [{ type: "session", id: string(record.session_id) }];
      if (record.type === "stream_event") {
        const event = object(record.event);
        if (event.type === "message_start") { textStreamed = false; messageText = ""; }
        if (event.type === "content_block_delta" && isRecord(event.delta) && event.delta.type === "text_delta") {
          const text = string(event.delta.text);
          textStreamed = true;
          messageText += text;
          return [{ type: "text", text }];
        }
        return [];
      }
      if (record.type === "assistant" || record.type === "user") {
        const events: DriverEvent[] = [];
        const message = object(record.message);
        if (Array.isArray(message.content)) for (const block of message.content) {
          if (!isRecord(block)) continue;
          if (record.type === "assistant" && block.type === "text" && !textStreamed) {
            const text = string(block.text);
            messageText += text;
            events.push({ type: "text", text });
          }
          if (block.type === "tool_use") events.push({ type: "tool", name: string(block.name), state: "started" });
          if (block.type === "tool_result") events.push({ type: "tool", name: string(block.tool_use_id), state: block.is_error ? "failed" : "completed" });
        }
        if (record.error) throw targetFailure(String(record.error) + ": " + events.filter(e => e.type === "text").map(e => e.text).join(""));
        return events;
      }
      if (record.type === "result") {
        if (record.is_error !== false || record.subtype !== "success") {
          throw targetFailure(String(record.result ?? JSON.stringify(record.errors ?? record.subtype)));
        }
        const events: DriverEvent[] = [{ type: "session", id: string(record.session_id) }];
        events.push(...finalText(messageText, record.result));
        return [...events, ...usage(record.usage), { type: "done" }];
      }
      return [];
    };
  },
};
