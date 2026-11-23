import { imageAsset, isRecord, parseWireJson, SessionError, stringifyWireJson, webSource, type HistoryEvent, type JsonValue, type RecordedAsset, type RecordedSource, type RecordedTool, type TranscriptMessage } from "@coverse/core";
import {tokenMetadata} from "./metadata.js";
import {readToolPlan} from "./plan.js";

type Row = Record<string, JsonValue>;
type Changes = { lines: boolean[]; removed: number; patches: string[] };
function recordPatch(file: Changes, change: Row) {
  if (typeof change.unified_diff === "string") {
    file.patches.push(change.unified_diff);
  } else if ((change.type === "add" || change.type === "delete") && typeof change.content === "string") {
    const add = change.type === "add";
    const lines = change.content.split("\n");
    const terminalNewline = lines.at(-1) === "";
    if (terminalNewline) lines.pop();
    const header = add ? "@@ -0,0 +1," + lines.length + " @@" : "@@ -1," + lines.length + " +0,0 @@";
    file.patches.push([header, ...lines.map(line => (add ? "+" : "-") + line),
      ...(!terminalNewline ? ["\\ No newline at end of file"] : [])].join("\n"));
  }
  if (typeof change.move_path === "string") file.patches.push("rename to " + change.move_path);
}
// Track inserted lines across successive patches so later edits to those lines count only once.
function updateFile(file: Changes, change: Row) {
  recordPatch(file, change);
  const contentLines = typeof change.content === "string" ? change.content.split("\n").length - Number(change.content.endsWith("\n") || !change.content) : 0;
  if (change.type === "add") { file.lines = Array<boolean>(contentLines).fill(true); return; }
  if (change.type === "delete") {
    file.removed += contentLines - file.lines.filter(Boolean).length;
    file.lines = [];
    return;
  }
  if (typeof change.unified_diff !== "string") return;
  let cursor = -1;
  for (const line of change.unified_diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) { cursor = Math.max(0, Number(hunk[1]) - (hunk[2] === "0" ? 0 : 1)); continue; }
    if (cursor < 0) continue;
    if (line.startsWith(" ")) cursor++;
    if (line.startsWith("-") || line.startsWith("+")) {
      // A diff may start far into an existing file. Undefined slots represent untouched lines.
      if (cursor > file.lines.length) file.lines.length = cursor;
      if (line.startsWith("-")) { if (!file.lines.splice(cursor, 1)[0]) file.removed++; }
      else { file.lines.splice(cursor++, 0, true); }
    }
  }
}

function collectChanges(files: Map<string, Changes>, changes: Row) {
  for (const [path, change] of Object.entries(changes)) {
    if (!isRecord(change)) continue;
    const file = files.get(path) ?? {lines: [], removed: 0, patches: []};
    updateFile(file, change);
    files.set(path, file);
  }
}

function fileRows(files: Map<string, Changes>, cwd?: string): NonNullable<TranscriptMessage["changedFiles"]> {
  return [...files].map(([file, changes]) => ({
    path: cwd && file.startsWith(cwd + (cwd.includes("\\") ? "\\" : "/")) ? file.slice(cwd.length + 1).replaceAll("\\","/") : file,
    added: changes.lines.filter(Boolean).length, removed: changes.removed,
    ...(changes.patches.length ? {patches: changes.patches} : {}),
  }));
}

export function patchEventFiles(changes: Row, cwd?: string) {
  const files = new Map<string, Changes>();
  collectChanges(files, changes);
  return fileRows(files, cwd);
}
function textParts(content: JsonValue | undefined, assets: RecordedAsset[]) {
  if (!Array.isArray(content)) return "";
  return content.map(p => {
    if (!isRecord(p)) return "";
    if (typeof p.text === "string") return p.text;
    if (["image","localimage","local_image","input_image","output_image"].includes(String(p.type).toLowerCase())) {
      const source = p.url ?? p.path ?? p.image_url;
      if (typeof source === "string") {
        assets.push(imageAsset(source));
        return "";
      }
    }
    return typeof p.name === "string" ? p.name : "";
  }).join("");
}

function nativeTool(item: Row): RecordedTool | undefined {
  if (!["CommandExecution","McpToolCall","DynamicToolCall","CollabAgentToolCall","WebSearch","Extension"].includes(String(item.type))) return;
  const name = typeof item.tool === "string" ? item.tool : String(item.type);
  const args = item.arguments ?? item.command ?? item.query;
  const output = item.error ?? item.result ?? item.aggregated_output;
  const failed = item.error != null || (typeof item.exit_code === "number" && item.exit_code !== 0) || item.status === "failed";
  const details = Object.fromEntries(Object.entries(item).filter(([key]) => ![
    "id","type","tool","status","arguments","command","query","error","result","aggregated_output",
  ].includes(key)));
  const listed = isRecord(item.action) ? item.action.sources : item.sources;
  const sources = Array.isArray(listed) ? listed.flatMap(s => isRecord(s) ? webSource(s.url,s.title) : []) : [];
  return {name, id:String(item.id), state:typeof item.status === "string" ? item.status : failed ? "failed" : "completed",
    ...(sources.length ? {sources} : {}),
    ...(args !== undefined ? {argumentsText:typeof args === "string" ? args : stringifyWireJson(args,null,2)} : {}),
    ...(output !== undefined ? {results:[{text:typeof output === "string" ? output : stringifyWireJson(output,null,2), ...(failed ? {failed:true} : {})}]} : {}),
    ...(Object.keys(details).length ? {details:stringifyWireJson(details,null,2)} : {})};
}

export function nativeTranscript(records: { value: Row; artifact?:string }[], cwd?: string): TranscriptMessage[] | undefined {
  // Only use the structured surface when actual native chat items are present.
  if (!records.some(({value}) => value.type === "event_msg" && isRecord(value.payload) &&
      value.payload.type === "item_completed" && isRecord(value.payload.item) && value.payload.item.type === "UserMessage")) return;
  const groups = new Map<string, Map<string, { item: Row; position:number; at?: string }>>();
  const durations = new Map<string, number>();
  const models = new Map<string,string>();
  const usages = new Map<string,ReturnType<typeof tokenMetadata>>();
  const rawTools = new Map<string,Map<string,RecordedTool>>();
  const calls = new Map<string,RecordedTool>();
  const summaries = new Map<string,Set<string>>();
  const sources = new Map<string,RecordedSource[]>();
  const events: {position:number; turn?:string; event:HistoryEvent}[] = [];
  const removed = new Set<string>();
  let activeTurn: string | undefined;
  for (const [position,{ value }] of records.entries()) {
    const p = value.payload;
    if (!isRecord(p)) continue;
    if (typeof p.turn_id === "string") activeTurn = p.turn_id;
    if (value.type === "response_item" && typeof p.call_id === "string") {
      if (activeTurn && (p.type === "function_call" || p.type === "custom_tool_call") && typeof p.name === "string") {
        const input = p.type === "function_call" ? p.arguments : p.input;
        const tool:RecordedTool = {id:p.call_id,name:p.name,state:"called"};
        if (typeof input === "string") {
          tool.argumentsText = input;
          if (p.type === "function_call" && ["update_plan","functions.update_plan","todo_list"].includes(p.name)) {
            try {
              const plan = readToolPlan(p.name,parseWireJson(input) as JsonValue);
              if (plan) tool.plan = plan;
            }
            catch { throw new SessionError("INVALID_INPUT","/transcript","Function arguments are not valid JSON"); }
          }
        }
        const group = rawTools.get(activeTurn) ?? new Map<string,RecordedTool>();
        group.set(p.call_id,tool);
        rawTools.set(activeTurn,group);
        calls.set(p.call_id,tool);
      } else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && p.output !== undefined) {
        const tool = calls.get(p.call_id);
        if (tool) {
          tool.state = "completed";
          (tool.results ??= []).push({text:typeof p.output === "string" ? p.output : stringifyWireJson(p.output,null,2)});
        }
      }
    }
    if (activeTurn && value.type === "response_item") {
      if (p.type === "reasoning") {
        const texts = summaries.get(activeTurn) ?? new Set<string>();
        for (const parts of [p.summary,p.content]) if (Array.isArray(parts)) for (const part of parts) {
          if (isRecord(part) && typeof part.text === "string") texts.add(part.text);
        }
        summaries.set(activeTurn,texts);
      }
      const listed = p.type === "web_search_call" && isRecord(p.action) && Array.isArray(p.action.sources) ? p.action.sources : [];
      const annotations = p.type === "message" && Array.isArray(p.content) ? p.content.flatMap(b =>
        isRecord(b) && Array.isArray(b.annotations) ? b.annotations : []) : [];
      const links = [...listed,...annotations].flatMap(s => isRecord(s) ? webSource(s.url,s.title) : []);
      if (links.length) sources.set(activeTurn,[...sources.get(activeTurn) ?? [],...links]);
    }
    if (activeTurn && value.type === "turn_context" && typeof p.model === "string") models.set(activeTurn,p.model);
    if (activeTurn && value.type === "event_msg" && p.type === "token_count") {
      const meta = tokenMetadata(p.info);
      if (meta.usage) usages.set(activeTurn,meta);
    }
    const record = (kind:HistoryEvent["kind"], text:string) => events.push({position,
      ...(activeTurn && kind !== "rollback" ? {turn:activeTurn} : {}),event:{id:"codex-event-" + position,kind,text,
        ...(typeof value.timestamp === "string" ? {createdAt:value.timestamp} : {})}});
    if (value.type === "compacted") record("compaction",typeof p.message === "string" ? p.message : "Source replaced the context window.");
    if (value.type === "turn_context") record("context",stringifyWireJson(p,null,2));
    if (value.type === "response_item" && p.type === "message" && (p.role === "system" || p.role === "developer")) {
      const text = textParts(p.content,[]);
      if (text) record(p.role,text);
    }
    if (value.type === "response_item" && p.namespace === "agent" && p.call_id === undefined &&
      p.type === "function_call_output" && typeof p.output === "string") record("context",p.output);
    if (value.type !== "event_msg") continue;
    if (p.type === "error" || p.type === "turn_aborted" || p.type === "task_aborted") {
      record("error",typeof p.message === "string" ? p.message : stringifyWireJson(p,null,2));
    }
    if (p.type === "task_complete" && typeof p.turn_id === "string" && typeof p.duration_ms === "number" && Number.isSafeInteger(p.duration_ms) && p.duration_ms >= 0) durations.set(p.turn_id, p.duration_ms);
    if (p.type === "thread_rolled_back") {
      const n = p.num_turns;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new SessionError("INVALID_INPUT", "/transcript", "Invalid native rollback count");
      for (const key of Array.from(groups.keys()).reverse().slice(0,n)) {groups.delete(key); removed.add(key);}
      record("rollback",stringifyWireJson(p,null,2));
      activeTurn = Array.from(groups.keys()).at(-1);
    }
    if (p.type !== "item_completed" || !isRecord(p.item) || typeof p.turn_id !== "string" || typeof p.item.id !== "string") continue;
    let group = groups.get(p.turn_id);
    if (!group) { group = new Map(); groups.set(p.turn_id, group); }
    const at = typeof value.timestamp === "string" ? value.timestamp : undefined;
    group.set(p.item.id, { item: p.item, position, ...(at ? { at } : {}) });
  }
  const transcript: TranscriptMessage[] = [];
  const positions = new Map<string,number>();
  for (const [turnId, items] of groups) {
    const activity: string[] = [];
    const tools: RecordedTool[] = [];
    const remaining = rawTools.get(turnId) ?? new Map<string,RecordedTool>();
    const readable = summaries.get(turnId);
    const files = new Map<string, Changes>();
    let lastAnswer: TranscriptMessage | undefined;
    for (const [id, { item, at, position }] of items) {
      if (item.type === "FileChange" && item.status === "completed" && isRecord(item.changes)) {
        collectChanges(files, item.changes);
      }
      if (item.type === "Reasoning" && Array.isArray(item.summary_text)) for (const text of item.summary_text) {
        if (typeof text === "string") { activity.push(text); readable?.delete(text); }
      }
      const tool = nativeTool(item);
      if (tool) {
        const callId = typeof item.call_id === "string" ? item.call_id : id;
        const raw = remaining.get(callId);
        if (raw) {
          if (raw.argumentsText !== undefined) tool.argumentsText ??= raw.argumentsText;
          if (raw.results) tool.results ??= raw.results;
          if (raw.plan) tool.plan ??= raw.plan;
          remaining.delete(callId);
        }
        tools.push(tool);
      }
      if (!["UserMessage", "AgentMessage", "Plan"].includes(String(item.type))) continue;
      const assets: RecordedAsset[] = [];
      const text = item.type === "Plan" && typeof item.text === "string" ? item.text : textParts(item.content, assets);
      if (item.type === "AgentMessage" && item.phase === "commentary") { activity.push(text); continue; }
      if (!text && !assets.length) continue;
      const role = item.type === "UserMessage" ? "user" : "assistant";
      const msg: TranscriptMessage = { id, role, text, ...(at ? {createdAt: at} : {}), ...(assets.length ? {assets} : {}) };
      const links = (Array.isArray(item.content) ? item.content : []).flatMap(b => isRecord(b) && Array.isArray(b.annotations)
        ? b.annotations.flatMap(a => isRecord(a) ? webSource(a.url,a.title) : []) : []);
      if (links.length) msg.sources = links;
      if (item.type === "Plan") msg.plan = {text,steps:[]};
      if (role === "assistant") {
        const model = models.get(turnId);
        if (model) msg.model = model;
        if (activity.length) msg.activity = activity.splice(0).join("\n\n");
        if (tools.length) msg.tools = tools.splice(0);
        lastAnswer = msg;
      }
      transcript.push(msg);
      positions.set(id,position);
    }
    tools.push(...remaining.values());
    activity.push(...readable ?? []);
    if (activity.length || files.size || tools.length) {
      if (!lastAnswer) {
        lastAnswer = { id: turnId + ":activity", role: "assistant", text: "" };
        transcript.push(lastAnswer);
        positions.set(lastAnswer.id,Array.from(items.values()).at(-1)!.position);
      }
      if (activity.length) lastAnswer.activity = [lastAnswer.activity, ...activity].filter(Boolean).join("\n\n");
      if (tools.length) lastAnswer.tools = [...(lastAnswer.tools ?? []), ...tools];
      if (files.size) lastAnswer.changedFiles = fileRows(files, cwd);
    }
    const duration = durations.get(turnId);
    const refs = sources.get(turnId);
    if (lastAnswer && refs?.length) lastAnswer.sources = [...lastAnswer.sources ?? [],...refs];
    if (lastAnswer) Object.assign(lastAnswer,usages.get(turnId));
    if (lastAnswer) {
      const plan = lastAnswer.tools?.slice().reverse().find(t => t.plan)?.plan;
      if (plan) lastAnswer.plan = {...plan,...(lastAnswer.plan?.text ? {text:lastAnswer.plan.text} : {})};
    }
    if (lastAnswer && duration !== undefined) lastAnswer.durationMs = duration;
  }
  let next = 0;
  let previousSource: string | undefined;
  for (const [i,message] of transcript.entries()) {
    const position = positions.get(message.id);
    const source = position !== undefined ? records[position]?.artifact : undefined;
    if (source && previousSource && source !== previousSource && i > 0) message.lineage = {parentId:transcript[i-1]!.id};
    if (source) previousSource = source;
  }
  for (const {position,turn,event} of events) {
    if (turn && removed.has(turn)) continue;
    while (next < transcript.length && (positions.get(transcript[next]!.id) ?? -1) < position) next++;
    const message = transcript[next];
    if (event.kind === "rollback" && next > 0) event.anchorId = transcript[next-1]!.id;
    if (message) (message.before ??= []).push(event);
    else if (transcript.length) (transcript.at(-1)!.after ??= []).push(event);
    else transcript.push({id:"history-events",role:"assistant",text:"",after:[event]});
  }
  return transcript;
}
