import { isRecord, SessionError, type JsonValue, type TranscriptMessage } from "@coverse/core";

type Row = Record<string, JsonValue>;
type Changes = { lines: boolean[]; removed: number };
// Track inserted lines across successive patches so later edits to those lines count only once.
function updateFile(file: Changes, change: Row) {
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
function textParts(content: JsonValue | undefined) {
  if (!Array.isArray(content)) return "";
  return content.map(p => {
    if (!isRecord(p)) return "";
    if (typeof p.text === "string") return p.text;
    if (p.type === "image" || p.type === "localImage" || p.type === "local_image") return "[image: " + (p.url ?? p.path ?? "") + "]";
    return typeof p.name === "string" ? p.name : "";
  }).join("");
}

export function nativeTranscript(records: { value: Row }[], cwd?: string): TranscriptMessage[] | undefined {
  // Only use the structured surface when actual native chat items are present.
  if (!records.some(({value}) => value.type === "event_msg" && isRecord(value.payload) &&
      value.payload.type === "item_completed" && isRecord(value.payload.item) && value.payload.item.type === "UserMessage")) return;
  const groups = new Map<string, Map<string, { item: Row; at?: string }>>();
  const durations = new Map<string, number>();
  for (const { value } of records) {
    const p = value.payload;
    if (value.type !== "event_msg" || !isRecord(p)) continue;
    if (p.type === "task_complete" && typeof p.turn_id === "string" && typeof p.duration_ms === "number" && Number.isSafeInteger(p.duration_ms) && p.duration_ms >= 0) durations.set(p.turn_id, p.duration_ms);
    if (p.type === "thread_rolled_back") {
      const n = p.num_turns;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new SessionError("INVALID_INPUT", "/transcript", "Invalid native rollback count");
      for (const key of Array.from(groups.keys()).reverse().slice(0,n)) groups.delete(key);
    }
    if (p.type !== "item_completed" || !isRecord(p.item) || typeof p.turn_id !== "string" || typeof p.item.id !== "string") continue;
    let group = groups.get(p.turn_id);
    if (!group) { group = new Map(); groups.set(p.turn_id, group); }
    const at = typeof value.timestamp === "string" ? value.timestamp : undefined;
    group.set(p.item.id, { item: p.item, ...(at ? { at } : {}) });
  }
  const transcript: TranscriptMessage[] = [];
  for (const [turnId, items] of groups) {
    const activity: string[] = [];
    const files = new Map<string, Changes>();
    let lastAnswer: TranscriptMessage | undefined;
    for (const [id, { item, at }] of items) {
      if (item.type === "FileChange" && item.status === "completed" && isRecord(item.changes)) {
        for (const [path, change] of Object.entries(item.changes)) {
          if (!isRecord(change)) continue;
          const file = files.get(path) ?? { lines: [], removed: 0 };
          updateFile(file, change);
          files.set(path, file);
        }
      }
      if (item.type === "Reasoning" && Array.isArray(item.summary_text)) activity.push(...item.summary_text.filter((s): s is string => typeof s === "string"));
      if (item.type === "CommandExecution" && Array.isArray(item.command)) activity.push(item.command.join(" ") +
        (typeof item.aggregated_output === "string" ? "\n" + item.aggregated_output : ""));
      if (item.type === "Extension" && typeof item.query === "string") activity.push(item.query);
      if (!["UserMessage", "AgentMessage", "Plan"].includes(String(item.type))) continue;
      const text = item.type === "Plan" && typeof item.text === "string" ? item.text : textParts(item.content);
      if (item.type === "AgentMessage" && item.phase === "commentary") { activity.push(text); continue; }
      if (!text) continue;
      const role = item.type === "UserMessage" ? "user" : "assistant";
      const msg: TranscriptMessage = { id, role, text, ...(at ? {createdAt: at} : {}) };
      if (role === "assistant") {
        if (activity.length) msg.activity = activity.splice(0).join("\n\n");
        lastAnswer = msg;
      }
      transcript.push(msg);
    }
    if (activity.length || files.size) {
      if (!lastAnswer) {
        lastAnswer = { id: turnId + ":activity", role: "assistant", text: "" };
        transcript.push(lastAnswer);
      }
      if (activity.length) lastAnswer.activity = [lastAnswer.activity, ...activity].filter(Boolean).join("\n\n");
      if (files.size) lastAnswer.changedFiles = [...files].map(([file, changes]) => ({
        path: cwd && file.startsWith(cwd + (cwd.includes("\\") ? "\\" : "/")) ? file.slice(cwd.length + 1).replaceAll("\\","/") : file,
        added: changes.lines.filter(Boolean).length, removed: changes.removed,
      }));
    }
    const duration = durations.get(turnId);
    if (lastAnswer && duration !== undefined) lastAnswer.durationMs = duration;
  }
  return transcript;
}
