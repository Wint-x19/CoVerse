import { decompress } from "fzstd";
import { buildInjectionBundle, emptyLedger, isRecord, parseJsonLines, requireString, SessionError, validateToolLinks, type ContentBlock, type CSR, type FileSet, type JsonValue, type SessionAdapter, type Turn } from "@coverse/core";

export const formatVersion = "rollout-2026-11-17";
const verifiedWriters = new Set(["0.169.0-alpha.11.1"]);
const operationalEvents = new Set(["task_started", "task_complete", "task_aborted", "turn_aborted", "token_count", "thread_settings_applied", "item_started", "item_completed", "agent_message_delta", "agent_reasoning_delta", "exec_command_begin", "exec_command_end", "exec_command_output_delta", "mcp_tool_call_begin", "mcp_tool_call_end", "patch_apply_begin", "patch_apply_end", "user_message", "agent_message", "agent_reasoning", "agent_reasoning_raw_content", "context_compacted", "session_configured"]);
function load(files: FileSet) {
  const logs = files.filter(f => /\.jsonl(?:\.zst)?$/.test(f.path));
  if (logs.length !== 1) throw new SessionError("AMBIGUOUS_INPUT", "/input", "Supply exactly one Codex rollout, plus any referenced attachment files");
  const file = logs[0]!;
  let bytes = file.bytes;
  if (file.path.endsWith(".zst")) {
    try { bytes = decompress(bytes); } catch { throw new SessionError("INVALID_INPUT", file.path, "Invalid or unsupported Zstandard rollout"); }
  }
  const records = parseJsonLines(bytes, file.path);
  const head = records[0]!.value;
  if (head.type !== "session_meta" || !isRecord(head.payload)) throw new SessionError("UNSUPPORTED_FORMAT", file.path, "Expected Codex session_meta header");
  if (!verifiedWriters.has(String(head.payload.cli_version))) throw new SessionError("UNSUPPORTED_VERSION", `${file.path}:1`, "Codex writer version has not been verified against this format baseline");
  return { file, records, meta: head.payload };
}
function messageBlocks(value: JsonValue | undefined, path: string): ContentBlock[] {
  if (!Array.isArray(value)) throw new SessionError("INVALID_INPUT", path, "Expected a message content array");
  return value.map((b, i) => {
    if (!isRecord(b)) throw new SessionError("INVALID_INPUT", `${path}/${i}`, "Invalid content block");
    if (["input_text", "output_text", "text", "summary_text"].includes(String(b.type)) && typeof b.text === "string") return { type: "text", text: b.text };
    if (b.type === "input_image" && typeof b.image_url === "string") return { type: "image", url: b.image_url };
    if (b.type === "input_file" && typeof b.file_path === "string") return { type: "attachment", path: b.file_path, mediaType: typeof b.mime_type === "string" ? b.mime_type : "application/octet-stream" };
    return { type: "opaque", source: "codex", value: b };
  });
}
const adapter: SessionAdapter = {
  id: "codex", displayName: "Codex", status: "ready", supportedVersions: [formatVersion],
  capabilities: { import: true, export: true, nativeResume: false, importFormats: ["rollout-jsonl", "rollout-jsonl-zstd"], exportFormats: ["injection-bundle"] },
  detect: files => { try { load(files); return { confidence: 1, formatVersion }; } catch (error) { return { confidence: 0, ...(error instanceof SessionError ? { diagnostics: [error.diagnostic] } : {}) }; } },
  import: files => {
    const { file, records, meta } = load(files);
    const ledger = emptyLedger();
    const session: CSR = { schemaVersion: "1.0", meta: { id: requireString(meta.id, `${file.path}:1/id`), agent: "codex", agentFormatVersion: formatVersion }, turns: [], xExtensions: { "x-codex-writer": meta.cli_version! }, raw: records.map(r => r.value), sourceArtifacts: files };
    if (typeof meta.cwd === "string") session.meta.cwd = meta.cwd;
    if (typeof meta.timestamp === "string") session.meta.createdAt = meta.timestamp;
    if (isRecord(meta.git)) session.xExtensions["x-codex-git"] = meta.git;
    let sequence = 0;
    // Match mirrors by occurrence, not just text equality; repeated user requests remain distinct.
    const mirrors = new Map<string, number>();
    for (const { value } of records) {
      const p = value.payload;
      if (value.type !== "response_item" || !isRecord(p) || p.type !== "message" || !Array.isArray(p.content)) continue;
      if (!p.content.every(b => isRecord(b) && typeof b.text === "string")) continue;
      const key = `${String(p.role)}\0${p.content.map(b => (b as Record<string, JsonValue>).text).join("")}`;
      mirrors.set(key, (mirrors.get(key) ?? 0) + 1);
    }
    const add = (role: Turn["role"], content: ContentBlock[], raw: JsonValue, line: number, kind?: NonNullable<Turn["origin"]>["kind"]) => {
      session.turns.push({ id: `${session.meta.id}:${++sequence}`, role, content, raw, origin: { artifact: file.path, record: line, ...(kind ? { kind } : {}) } });
    };
    if (isRecord(meta.base_instructions) && typeof meta.base_instructions.text === "string") add("system", [{ type: "text", text: meta.base_instructions.text }], meta.base_instructions, 1);
    const item = (p: Record<string, JsonValue>, line: number, kind?: NonNullable<Turn["origin"]>["kind"]) => {
      const path = `${file.path}:${line}`;
      switch (p.type) {
        case "message":
          if (!["user", "assistant", "system", "developer"].includes(String(p.role))) throw new SessionError("INVALID_INPUT", path, "Unknown message role");
          add(p.role as Turn["role"], messageBlocks(p.content, path), p, line, kind); break;
        case "function_call": case "custom_tool_call": {
          const input = p.type === "function_call" ? p.arguments : p.input;
          if (typeof input !== "string") throw new SessionError("INVALID_INPUT", path, "Tool input must be a string");
          let args: JsonValue = input;
          if (p.type === "function_call") { try { args = JSON.parse(input) as JsonValue; } catch { throw new SessionError("INVALID_INPUT", path, "Function arguments are not valid JSON"); } }
          add("assistant", [{ type: "tool_call", id: requireString(p.call_id, path), name: requireString(p.name, path), arguments: args, argumentsText: input }], p, line, kind); break;
        }
        case "function_call_output": case "custom_tool_call_output":
          if (p.output === undefined) throw new SessionError("INVALID_INPUT", path, "Missing tool output");
          add("tool", [{ type: "tool_result", callId: requireString(p.call_id, path), content: p.output }], p, line, kind); break;
        case "reasoning": {
          const blocks: ContentBlock[] = messageBlocks(p.summary ?? [], path).map(b => b.type === "text" ? { type: "reasoning", text: b.text } : b);
          if (Array.isArray(p.content)) blocks.push(...messageBlocks(p.content, path).map(b => b.type === "text" ? { type: "reasoning" as const, text: b.text } : b));
          // A readable summary cannot stand in for unrecoverable reasoning.
          if (p.encrypted_content) blocks.push({ type: "opaque", source: "codex:encrypted-reasoning", value: { encrypted: true } });
          add("assistant", blocks, p, line, kind); break;
        }
        case "additional_tools":
          add("system", [{ type: "text", text: `Historical tool definitions:\n${JSON.stringify(p.tools, null, 2)}` }], p, line, kind);
          ledger.downgraded.push({ code: "TOOL_DEFINITIONS_AS_HISTORY", path, reason: "Source tool definitions are historical data, not executable target tools" }); break;
        default: add("assistant", [{ type: "opaque", source: "codex:response_item", value: p }], p, line, kind);
      }
    };
    for (const { value: r, line } of records.slice(1)) {
      if (!isRecord(r.payload)) throw new SessionError("INVALID_INPUT", `${file.path}:${line}`, "Expected record payload");
      const p = r.payload;
      switch (r.type) {
        case "session_meta": throw new SessionError("AMBIGUOUS_INPUT", `${file.path}:${line}`, "Multiple sessions in one rollout");
        case "response_item": item(p, line); break;
        case "turn_context":
          if (typeof p.model === "string") session.meta.model = p.model;
          add("system", [{ type: "text", text: `Historical turn settings:\n${JSON.stringify(p, null, 2)}` }], p, line); break;
        case "compacted":
          if (typeof p.message === "string") add("system", [{ type: "text", text: p.message }], p, line, "compaction");
          if (Array.isArray(p.replacement_history)) {
            add("system", [{ type: "text", text: `Historical compaction replacement snapshot:\n${JSON.stringify(p.replacement_history, null, 2)}` }], p, line, "compaction");
            ledger.downgraded.push({ code: "COMPACTION_SNAPSHOT", path: `${file.path}:${line}`, reason: "Replacement snapshot is labeled separately; original history remains intact" });
          }
          if (typeof p.message !== "string" && !Array.isArray(p.replacement_history)) throw new SessionError("INVALID_INPUT", `${file.path}:${line}`, "Empty compaction record");
          break;
        case "event_msg":
          if (p.type === "user_message" || p.type === "agent_message") {
            const role = p.type === "user_message" ? "user" : "assistant";
            if (typeof p.message !== "string") throw new SessionError("INVALID_INPUT", `${file.path}:${line}`, "Malformed message event");
            const key = `${role}\0${p.message}`, remaining = mirrors.get(key) ?? 0;
            if (remaining) mirrors.set(key, remaining - 1);
            else add(role, [{ type: "text", text: p.message }], p, line);
            if ([p.images, p.local_images, p.attachments].some(v => Array.isArray(v) && v.length)) add(role, [{ type: "opaque", source: "codex:event-attachments", value: p }], p, line);
          } else if (p.type === "agent_reasoning" || p.type === "agent_reasoning_raw_content") {
            // These records are not assumed to be duplicates of a reasoning summary.
            const text = p.text;
            if (typeof text !== "string") throw new SessionError("INVALID_INPUT", `${file.path}:${line}`, "Malformed reasoning event");
            add("assistant", [{ type: "reasoning", text }], p, line);
          } else if (p.type === "thread_rolled_back") add("system", [{ type: "text", text: `Historical rollback marker (earlier records retained):\n${JSON.stringify(p)}` }], p, line, "reverted");
          else if (!operationalEvents.has(String(p.type))) add("system", [{ type: "opaque", source: "codex:event", value: p }], p, line);
          break;
        case "world_state": case "retained_context":
          add("system", [{ type: "text", text: `Historical ${String(r.type)}:\n${JSON.stringify(p, null, 2)}` }], p, line);
          ledger.downgraded.push({ code: "NATIVE_STATE_AS_HISTORY", path: `${file.path}:${line}`, reason: "Native context is preserved as labeled data, not applied to the target runtime" }); break;
        case "token_usage_record": break;
        default: add("system", [{ type: "opaque", source: "codex:record", value: r }], r, line);
      }
    }
    validateToolLinks(session.turns);
    return { session, ledger };
  },
  export: (session, context) => buildInjectionBundle(session, "codex", context),
};
export default adapter;
