import { imageAsset, parseWireJson, stringifyWireJson, webSource } from "@coverse/core";
import { decompress, Decompress } from "fzstd";
import { ancestralRecords, prepareLineage, primaryLog, verifiedWriters } from "./lineage.js";
import { nativeTranscript, patchEventFiles } from "./transcript.js";
import {readToolPlan} from "./plan.js";
import {tokenMetadata} from "./metadata.js";
import { buildInjectionBundle, emptyLedger, isRecord, parseJsonLines, requireString, SessionError, validateToolLinks, type ContentBlock, type CSR, type FileSet, type JsonValue, type SessionAdapter, type Turn } from "@coverse/core";

export const formatVersion = "rollout-2026-11-17";
const operationalEvents = new Set(["task_started", "task_complete", "task_aborted", "turn_aborted", "token_count", "thread_settings_applied", "item_started", "item_completed", "agent_message_delta", "agent_reasoning_delta", "exec_command_begin", "exec_command_end", "exec_command_output_delta", "mcp_tool_call_begin", "mcp_tool_call_end", "patch_apply_begin", "patch_apply_end", "user_message", "agent_message", "agent_reasoning", "agent_reasoning_raw_content", "context_compacted", "session_configured"]);
function load(files: FileSet) {
  const file = primaryLog(files);
  let bytes = file.bytes;
  if (file.path.endsWith(".zst")) {
    try { bytes = decompress(bytes); } catch { throw new SessionError("INVALID_INPUT", file.path, "Invalid or unsupported Zstandard rollout"); }
  }
  const records = parseJsonLines(bytes, file.path);
  const head = records[0]!.value;
  if (head.type !== "session_meta" || !isRecord(head.payload)) throw new SessionError("UNSUPPORTED_FORMAT", file.path, "Expected Codex session_meta header");
  if (!verifiedWriters.has(String(head.payload.cli_version))) throw new SessionError("UNSUPPORTED_VERSION", `${file.path}:1`, `Codex writer ${String(head.payload.cli_version)} has not been verified against this format baseline`);
  return { file, records, meta: head.payload };
}
function messageBlocks(value: JsonValue | undefined, path: string): ContentBlock[] {
  if (!Array.isArray(value)) throw new SessionError("INVALID_INPUT", path, "Expected a message content array");
  return value.map((b, i) => {
    if (!isRecord(b)) throw new SessionError("INVALID_INPUT", `${path}/${i}`, "Invalid content block");
    if (["input_text", "output_text", "text", "summary_text"].includes(String(b.type)) && typeof b.text === "string") {
      const sources = Array.isArray(b.annotations) ? b.annotations.flatMap(a => isRecord(a) && a.type === "url_citation" ? webSource(a.url,a.title) : []) : [];
      return {type:"text",text:b.text,...(sources.length ? {sources} : {})};
    }
    if (b.type === "input_image" && typeof b.image_url === "string") return { type: "image", url: b.image_url };
    if (b.type === "input_file" && typeof b.file_path === "string") return { type: "attachment", path: b.file_path, mediaType: typeof b.mime_type === "string" ? b.mime_type : "application/octet-stream" };
    return { type: "opaque", source: "codex", value: b };
  });
}
const adapter: SessionAdapter = {
  id: "codex", displayName: "Codex", status: "ready", supportedVersions: [formatVersion],
  capabilities: { import: true, export: true, nativeResume: false, importFormats: ["rollout-jsonl", "rollout-jsonl-zstd"], exportFormats: ["injection-bundle"] },
  prepareLocalImport: prepareLineage,
  readToolPlan,
  readProjectDirectory: files => {
    const file = files.find(item => item.path.endsWith(".jsonl.zst"));
    if (!file) return undefined;
    const chunks: Buffer[] = [];
    let complete = false;
    const decoder = new Decompress(chunk => {
      if (complete) return;
      const end = chunk.indexOf(10);
      complete = end >= 0;
      chunks.push(Buffer.from(complete ? chunk.subarray(0, end) : chunk));
    });
    for (let offset = 0; offset < file.bytes.length && !complete; offset += 65536) {
      const end = Math.min(offset + 65536, file.bytes.length);
      decoder.push(file.bytes.subarray(offset, end), end === file.bytes.length);
    }
    const head = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return head?.type === "session_meta" && typeof head.payload?.cwd === "string" ? head.payload.cwd : undefined;
  },
  detect: files => { try { load(files); return { confidence: 1, formatVersion }; } catch (error) { return { confidence: 0, ...(error instanceof SessionError ? { diagnostics: [error.diagnostic] } : {}) }; } },
  import: files => {
    const { file, meta, records: local } = load(files);
    const records = meta.history_base ? ancestralRecords(files) : local.slice(1).map(r => ({...r, artifact: file.path}));
    const ledger = emptyLedger();
    const session: CSR = { schemaVersion: "1.0", meta: { id: requireString(meta.id, `${file.path}:1/id`), agent: "codex", agentFormatVersion: formatVersion }, turns: [], xExtensions: { "x-codex-writer": meta.cli_version! }, sourceArtifacts: files };
    if (typeof meta.cwd === "string") session.meta.cwd = meta.cwd;
    const transcript = nativeTranscript(records, session.meta.cwd);
    if (transcript) session.transcript = transcript;
    session.raw = [local[0]!.value, ...records.map(r => r.value)];
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
    let destination = session.turns;
    let recordedAt: string | undefined, model: string | undefined;
    let lastAssistant: Turn | undefined;
    const turnGroups = new Map<string,Turn[]>();
    let activeTurn: string | undefined;
    let artifact = file.path;
    const add = (role: Turn["role"], content: ContentBlock[], raw: JsonValue, line: number, kind?: NonNullable<Turn["origin"]>["kind"]) => {
      destination.push({ id: `${session.meta.id}:${++sequence}`, role, content, raw, origin: { artifact, record: line, ...(kind ? { kind } : {}) } });
      const turn = destination.at(-1)!;
      if (recordedAt && destination === session.turns) turn.createdAt = recordedAt;
      if (model && role === "assistant") turn.model = model;
      if (destination === session.turns && role === "assistant") lastAssistant = turn;
      if (role === "user" && destination === session.turns) lastAssistant = undefined;
      if (activeTurn && destination === session.turns) turnGroups.get(activeTurn)?.push(destination.at(-1)!);
    };
    if (isRecord(meta.base_instructions) && typeof meta.base_instructions.text === "string") add("system", [{ type: "text", text: meta.base_instructions.text }], meta.base_instructions, 1);
    const item = (p: Record<string, JsonValue>, line: number, kind?: NonNullable<Turn["origin"]>["kind"]) => {
      const path = `${artifact}:${line}`;
      switch (p.type) {
        case "web_search_call": {
          if (!isRecord(p.action)) {add("assistant",[{type:"opaque",source:"codex:web_search",value:p}],p,line,kind); break;}
          const urls = Array.isArray(p.action.sources) ? p.action.sources.flatMap(s => isRecord(s) ? webSource(s.url,s.title) : []) : [];
          add("system",[{type:"text",text:"Historical web search:\n" + stringifyWireJson(p.action,null,2),...(urls.length ? {sources:urls} : {})}],p,line,kind);
          break;
        }
        case "message":
          if (!["user", "assistant", "system", "developer"].includes(String(p.role))) throw new SessionError("INVALID_INPUT", path, "Unknown message role");
          add(p.role as Turn["role"], messageBlocks(p.content, path), p, line, kind); break;
        case "function_call": case "custom_tool_call": {
          const input = p.type === "function_call" ? p.arguments : p.input;
          if (typeof input !== "string") throw new SessionError("INVALID_INPUT", path, "Tool input must be a string");
          let args: JsonValue = input;
          if (p.type === "function_call") { try { args = parseWireJson(input) as JsonValue; } catch { throw new SessionError("INVALID_INPUT", path, "Function arguments are not valid JSON"); } }
          add("assistant", [{ type: "tool_call", id: requireString(p.call_id, path), name: requireString(p.name, path), arguments: args, argumentsText: input }], p, line, kind); break;
        }
        case "function_call_output": case "custom_tool_call_output":
          if (p.output === undefined) throw new SessionError("INVALID_INPUT", path, "Missing tool output");
          // Desktop supplies page context without a preceding assistant tool call.
          if (p.type === "function_call_output" && p.call_id === undefined && p.namespace === "agent" &&
              (p.name === "codex_apps_open_page" || p.name === "codex_apps_selected_page_part_1_of_1") &&
              typeof p.output === "string") {
            add("system", [{ type: "text", text: `Historical Codex page context (${p.name}):\n${p.output}` }], p, line, kind);
            ledger.downgraded.push({ code: "PAGE_CONTEXT_AS_HISTORY", path, reason: "Desktop page context is preserved as historical text" });
            break;
          }
          add("tool", [{ type: "tool_result", callId: requireString(p.call_id, path), content: p.output }], p, line, kind); break;
        case "reasoning": {
          const blocks: ContentBlock[] = messageBlocks(p.summary ?? [], path).map(b => b.type === "text" ? { type: "reasoning", text: b.text } : b);
          if (Array.isArray(p.content)) blocks.push(...messageBlocks(p.content, path).map(b => b.type === "text" ? { type: "reasoning" as const, text: b.text } : b));
          // A readable summary cannot stand in for unrecoverable reasoning.
          if (p.encrypted_content) blocks.push({ type: "opaque", source: "codex:encrypted-reasoning", value: { encrypted: true } });
          add("assistant", blocks, p, line, kind); break;
        }
        case "compaction":
          add("system", [{ type: "opaque", source: "codex:compaction", value: p, requiredForContinuation: true }], p, line, kind);
          break;
        case "additional_tools":
          add("system", [{ type: "text", text: `Historical tool definitions:\n${stringifyWireJson(p.tools, null, 2)}` }], p, line, kind);
          ledger.downgraded.push({ code: "TOOL_DEFINITIONS_AS_HISTORY", path, reason: "Source tool definitions are historical data, not executable target tools" }); break;
        default: add("assistant", [{ type: "opaque", source: "codex:response_item", value: p }], p, line, kind);
      }
    };
    for (const { value: r, line, artifact: sourceArtifact } of records) {
      artifact = sourceArtifact;
      if (!isRecord(r.payload)) throw new SessionError("INVALID_INPUT", `${file.path}:${line}`, "Expected record payload");
      const p = r.payload;
      recordedAt = typeof r.timestamp === "string" && Number.isFinite(Date.parse(r.timestamp)) ? r.timestamp : undefined;
      if (r.type === "turn_context" && typeof p.model === "string") model = p.model;
      if (r.type === "event_msg" && p.type === "token_count" && lastAssistant) Object.assign(lastAssistant,tokenMetadata(p.info));
      if (r.type === "event_msg" && p.type === "task_complete" && lastAssistant && typeof p.duration_ms === "number" && p.duration_ms >= 0) lastAssistant.durationMs = p.duration_ms;
      if (typeof p.turn_id === "string" && (r.type === "turn_context" || (r.type === "event_msg" && p.type === "task_started"))) {
        activeTurn = p.turn_id;
        if (!turnGroups.has(activeTurn)) turnGroups.set(activeTurn,[]);
      }
      switch (r.type) {
        case "session_meta": throw new SessionError("AMBIGUOUS_INPUT", `${file.path}:${line}`, "Multiple sessions in one rollout");
        case "response_item": item(p, line); break;
        case "turn_context":
          if (typeof p.model === "string") session.meta.model = p.model;
          add("system", [{ type: "text", text: `Historical turn settings:\n${stringifyWireJson(p, null, 2)}` }], p, line); break;
        case "compacted": {
          if (typeof p.message !== "string" && !Array.isArray(p.replacement_history)) throw new SessionError("INVALID_INPUT", `${file.path}:${line}`, "Empty compaction record");
          add("system", [{ type: "text", text: typeof p.message === "string" ? p.message : "Source compaction boundary" }], p, line, "compaction");
          const boundary = session.turns.at(-1)!;
          const retainedIds = session.turns.filter(t => t.origin?.record === 1 && t.role === "system").map(t => t.id);
          const replacement: Turn[] = [];
          if (Array.isArray(p.replacement_history)) {
            destination = replacement;
            const opaqueCount = p.replacement_history.filter(entry => isRecord(entry) && entry.type === "compaction").length;
            for (const native of p.replacement_history) {
              if (!isRecord(native)) throw new SessionError("INVALID_INPUT", `${file.path}:${line}`, "Invalid replacement history item");
              if (native.type === "compaction" && opaqueCount === 1 && typeof p.message === "string" && p.message.trim()) {
                add("system", [{ type: "text", text: p.message }], native, line, "compaction");
                ledger.approximated.push({ code: "COMPACTION_AS_SOURCE_SUMMARY", path: `${file.path}:${line}`,
                  reason: "A readable source summary represents the opaque compaction item in the target context" });
              } else {
                item(native, line, "compaction");
              }
            }
            destination = session.turns;
          } else {
            retainedIds.push(boundary.id);
            ledger.approximated.push({ code: "SUMMARY_ONLY_WINDOW", path: `${file.path}:${line}`, reason: "Only the readable compaction summary was available; additional retained items could not be verified" });
          }
          session.continuation = { boundaryId: boundary.id, retainedIds, replacement };
          break;
        }
        case "event_msg":
          if (p.type === "user_message" || p.type === "agent_message") {
            const role = p.type === "user_message" ? "user" : "assistant";
            if (typeof p.message !== "string") throw new SessionError("INVALID_INPUT", `${file.path}:${line}`, "Malformed message event");
            const key = `${role}\0${p.message}`, remaining = mirrors.get(key) ?? 0;
            if (remaining) mirrors.set(key, remaining - 1);
            else add(role, [{ type: "text", text: p.message }], p, line);
            const media: ContentBlock[] = [];
            for (const entry of [p.images,p.local_images].flatMap(v => Array.isArray(v) ? v : [])) {
              if (typeof entry === "string" && entry.length) media.push({type:"media",asset:imageAsset(entry)});
              else media.push({type:"opaque",source:"codex:event-attachments",value:entry});
            }
            if (Array.isArray(p.attachments) && p.attachments.length) media.push({type:"opaque",source:"codex:event-attachments",value:p.attachments});
            if (media.length) {
              const message = destination.slice().reverse().find(t => t.role === role && t.content.some(b => b.type === "text" && b.text === p.message));
              if (message) {
                const images = new Set(message.content.flatMap(b => b.type === "image" ? [b.url] : []));
                message.content.push(...media.filter(b => b.type !== "media" || !images.has(b.asset.value)));
              } else add(role, media, p, line);
            }
          } else if (p.type === "agent_reasoning" || p.type === "agent_reasoning_raw_content") {
            // These records are not assumed to be duplicates of a reasoning summary.
            const text = p.text;
            if (typeof text !== "string") throw new SessionError("INVALID_INPUT", `${file.path}:${line}`, "Malformed reasoning event");
            add("assistant", [{ type: "reasoning", text }], p, line);
          } else if (typeof p.type === "string" && /^(?:mcp_tool_call|exec_command|patch_apply)_(?:begin|end|output_delta)$/.test(p.type)) {
            add("system", [{ type: "text", text: `Historical tool event:\n${stringifyWireJson(p)}` }], p, line);
            if (p.type === "patch_apply_end" && p.success === true && isRecord(p.changes)) {
              destination.at(-1)!.changedFiles = patchEventFiles(p.changes, session.meta.cwd);
            }
            ledger.downgraded.push({ code: "TOOL_EVENT_AS_HISTORY", path: `${file.path}:${line}`, reason: "Native tool telemetry is quoted as recorded, without inferring a new executable call" });
          } else if (p.type === "thread_rolled_back") {
            if (typeof p.num_turns === "number" && Number.isSafeInteger(p.num_turns) && p.num_turns >= 0) {
              for (const key of [...turnGroups.keys()].reverse().slice(0,p.num_turns)) {
                for (const turn of turnGroups.get(key)!) if (turn.origin) turn.origin.reverted = true;
                turnGroups.delete(key);
              }
            }
            activeTurn = undefined;
            const anchor = session.turns.slice().reverse().find(t => !t.origin?.reverted && (t.role === "assistant" || t.role === "user"));
            add("system", [{type:"text",text:"Historical rollback:\n" + stringifyWireJson(p)}],p,line,"reverted");
            const turn = destination.at(-1)!;
            turn.event = {id:turn.id,kind:"rollback",text:stringifyWireJson(p,null,2),...(anchor ? {anchorId:anchor.id} : {})};
          }
          else if ((p.type === "error" && typeof p.message === "string") || p.type === "task_aborted" || p.type === "turn_aborted") {
            const text = typeof p.message === "string" ? p.message : stringifyWireJson(p,null,2);
            add("system",[{type:"text",text:"Historical error or interruption:\n" + text}],p,line);
            const turn = destination.at(-1)!;
            turn.event = {id:turn.id,kind:"error",text};
          } else if (!operationalEvents.has(String(p.type))) add("system", [{ type: "opaque", source: "codex:event", value: p }], p, line);
          break;
        case "world_state": case "retained_context":
          add("system", [{ type: "text", text: `Historical ${String(r.type)}:\n${stringifyWireJson(p, null, 2)}` }], p, line);
          ledger.downgraded.push({ code: "NATIVE_STATE_AS_HISTORY", path: `${file.path}:${line}`, reason: "Native context is preserved as labeled data, not applied to the target runtime" }); break;
        case "token_usage_record": break;
        default: add("system", [{ type: "opaque", source: "codex:record", value: r }], r, line);
      }
    }
    for (const turn of session.turns) for (const block of turn.content) {
      if (block.type === "tool_call") {
        const plan = readToolPlan(block.name,block.arguments);
        if (plan) turn.plan = plan;
      }
    }
    validateToolLinks(session.turns);
    return { session, ledger };
  },
  export: (session, context) => buildInjectionBundle(session, "codex", context),
};
export default adapter;
