import { stringifyWireJson } from "@coverse/core";
import { buildInjectionBundle, emptyLedger, isRecord, parseJsonLines, requireString, SessionError, type ContentBlock, type CSR, type FileSet, type JsonValue, type SessionAdapter, type Turn } from "@coverse/core";

export const formatVersion = "transcript-sdk-0_3_326";
type Entry = { value: Record<string, JsonValue>; line: number; artifact: string };
function load(files: FileSet): Entry[] {
  const logs = files.filter(f => f.path.endsWith(".jsonl"));
  if (!logs.length) throw new SessionError("UNSUPPORTED_FORMAT", "/input", "Expected Claude Code transcript JSONL");
  const entries = logs.flatMap(f => parseJsonLines(f.bytes, f.path).map(r => ({ ...r, artifact: f.path })));
  const messages = entries.filter(e => e.value.type === "user" || e.value.type === "assistant");
  if (!messages.length) throw new SessionError("UNSUPPORTED_FORMAT", "/input", "No Claude transcript messages found");
  const sessions = new Set<string>();
  for (const { value: r, line, artifact } of messages) {
    const at = `${artifact}:${line}`;
    sessions.add(requireString(r.sessionId, at)); requireString(r.uuid, at);
    if (r.parentUuid !== null && typeof r.parentUuid !== "string") throw new SessionError("INVALID_INPUT", at, "Expected explicit parentUuid string or null");
    if (!isRecord(r.message)) throw new SessionError("INVALID_INPUT", at, "Expected native transcript message object");
    if (r.version !== undefined && r.version !== "2.1.121") throw new SessionError("UNSUPPORTED_VERSION", at, "Writer label is outside the reconstructed and SDK-validated baseline");
  }
  if (sessions.size !== 1) throw new SessionError("AMBIGUOUS_INPUT", "/input", "Input contains unrelated Claude sessions");
  return entries;
}
function blocks(content: JsonValue | undefined, at: string): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw new SessionError("INVALID_INPUT", at, "Expected string or content blocks");
  return content.map(b => {
    if (!isRecord(b)) throw new SessionError("INVALID_INPUT", at, "Invalid content block");
    switch (b.type) {
      case "text": if (typeof b.text === "string") return { type: "text", text: b.text }; break;
      case "thinking": if (typeof b.thinking === "string") return { type: "reasoning", text: b.thinking }; break;
      case "tool_use":
        if (b.input === undefined) throw new SessionError("INVALID_INPUT", at, "Tool input is missing");
        return { type: "tool_call", id: requireString(b.id, at), name: requireString(b.name, at), arguments: b.input };
      case "tool_result":
        if (b.content === undefined) throw new SessionError("INVALID_INPUT", at, "Tool result content is missing");
        return { type: "tool_result", callId: requireString(b.tool_use_id, at), content: b.content, ...(typeof b.is_error === "boolean" ? { isError: b.is_error } : {}) };
      case "image":
        if (isRecord(b.source)) {
          if (b.source.type === "url" && typeof b.source.url === "string") return { type: "image", url: b.source.url };
          if (b.source.type === "base64" && typeof b.source.media_type === "string" && typeof b.source.data === "string") return { type: "image", url: `data:${b.source.media_type};base64,${b.source.data}` };
        }
        break;
      case "document":
        if (isRecord(b.source) && b.source.type === "text" && typeof b.source.data === "string") return { type: "text", text: `Historical document:\n${b.source.data}` };
        break;
    }
    return { type: "opaque", source: "claude-code", value: b };
  });
}
const adapter: SessionAdapter = {
  id: "claude-code", displayName: "Claude Code", status: "ready", supportedVersions: [formatVersion],
  capabilities: { import: true, export: true, nativeResume: false, importFormats: ["transcript-jsonl"], exportFormats: ["injection-bundle"] },
  detect: files => { try { load(files); return { confidence: 1, formatVersion }; } catch (e) { return { confidence: 0, ...(e instanceof SessionError ? { diagnostics: [e.diagnostic] } : {}) }; } },
  import: files => {
    const entries = load(files), ledger = emptyLedger();
    const first = entries.find(e => e.value.type === "user" || e.value.type === "assistant")!.value;
    const session: CSR = { schemaVersion: "1.0", meta: { id: first.sessionId as string, agent: "claude-code", agentFormatVersion: formatVersion }, turns: [], xExtensions: {}, sourceArtifacts: files, raw: entries.map(e => ({ artifact: e.artifact, line: e.line, value: e.value })) };
    if (typeof first.cwd === "string") session.meta.cwd = first.cwd;
    if (typeof first.timestamp === "string") session.meta.createdAt = first.timestamp;
    const nodes = new Map<string, Entry>();
    const children = new Map<string, string[]>();
    for (const e of entries) {
      const id = e.value.uuid;
      if (typeof id !== "string") continue;
      const old = nodes.get(id);
      if (old && stringifyWireJson(old.value) !== stringifyWireJson(e.value)) throw new SessionError("INVALID_INPUT", `${e.artifact}:${e.line}`, "Conflicting duplicate transcript UUID");
      if (old) continue;
      nodes.set(id, e);
      if (typeof e.value.parentUuid === "string") children.set(e.value.parentUuid, [...(children.get(e.value.parentUuid) ?? []), id]);
    }
    const ancestors = (id: string): string[] => {
      const result: string[] = [], seen = new Set([id]); let current = nodes.get(id)?.value.parentUuid;
      while (typeof current === "string") {
        if (seen.has(current)) throw new SessionError("INVALID_INPUT", id, "Cycle in transcript parent chain");
        seen.add(current); result.push(current);
        const parent = nodes.get(current);
        if (!parent) throw new SessionError("MISSING_RELATED_RECORD", id, `Missing parent transcript record: ${current}`);
        current = parent.value.parentUuid;
      }
      return result;
    };
    const rendered = new Set<string>(); const byId = new Map<string, Turn>();
    for (const e of entries) {
      const r = e.value, at = `${e.artifact}:${e.line}`, id = typeof r.uuid === "string" ? r.uuid : `${e.artifact}:${e.line}`;
      if (rendered.has(id)) continue; rendered.add(id);
      const chain = ancestors(id);
      const origin: NonNullable<Turn["origin"]> = { artifact: e.artifact, record: e.line, ...(typeof r.parentUuid === "string" ? { parentId: r.parentUuid } : {}) };
      const fork = [id, ...chain].find(candidate => { const p = nodes.get(candidate)?.value.parentUuid; return typeof p === "string" && (children.get(p)?.length ?? 0) > 1; });
      origin.branchId = r.isSidechain === true ? `subsession:${String(r.agentId ?? e.artifact)}` : fork ? `fork:${fork}` : "main";
      if (r.isSidechain === true) origin.kind = "subsession";
      let turn: Turn | undefined;
      if (r.type === "user" || r.type === "assistant") {
        const message = r.message as Record<string, JsonValue>;
        if (message.role !== r.type) throw new SessionError("INVALID_INPUT", at, "Message role contradicts record type");
        if (typeof message.model === "string") session.meta.model = message.model;
        if (r.isCompactSummary === true) origin.kind = "compaction";
        turn = { id, role: r.type, content: blocks(message.content, at), raw: r, origin };
      } else if (["system", "attachment", "progress", "summary"].includes(String(r.type)) ||
          (r.type === "ai-title" && r.sessionId === session.meta.id && typeof r.aiTitle === "string" &&
            Object.keys(r).every(key => ["type", "sessionId", "aiTitle"].includes(key)))) {
        if (r.subtype === "compact_boundary" || r.type === "summary") origin.kind = "compaction";
        turn = { id, role: "system", content: [{ type: "text", text: `Historical ${String(r.type)} record:\n${stringifyWireJson(r, null, 2)}` }], raw: r, origin };
        ledger.downgraded.push({ code: "NATIVE_CONTEXT_AS_HISTORY", path: at, reason: "Native context, progress and compaction data are labeled history, not target runtime state" });
      } else if (!["file-history-snapshot", "queue-operation", "last-prompt", "custom-title", "tag", "agent-name", "agent-color", "agent-setting", "pr-link"].includes(String(r.type))) {
        turn = { id, role: "system", content: [{ type: "opaque", source: "claude-code:record", value: r }], raw: r, origin };
      }
      if (turn) {
        session.turns.push(turn); byId.set(id, turn);
        if (r.isCompactSummary === true && origin.branchId === "main") {
          const boundary = chain.map(parent => nodes.get(parent)?.value).find(row => row?.subtype === "compact_boundary");
          const segment = boundary && isRecord(boundary.compactMetadata) ? boundary.compactMetadata.preservedSegment : undefined;
          if (segment != null) throw new SessionError("UNINTERPRETED_CONTENT", at, "Partial compaction includes a preserved segment whose order has not been verified");
          session.continuation = { boundaryId: id, retainedIds: [id], replacement: [] };
        }
      }
    }
    // A tool result may refer to a shared ancestor of a fork, but not to a sibling branch.
    for (const turn of session.turns) {
      const localCalls = new Set<string>();
      for (const block of turn.content) {
        if (block.type === "tool_call") {
          if (localCalls.has(block.id) || ancestors(turn.id).some(id => byId.get(id)?.content.some(b => b.type === "tool_call" && b.id === block.id))) {
            throw new SessionError("INVALID_INPUT", turn.id, "Duplicate tool call ID on the same ancestry");
          }
          localCalls.add(block.id);
        }
        if (block.type === "tool_result" && !ancestors(turn.id).some(id => byId.get(id)?.content.some(b => b.type === "tool_call" && b.id === block.callId))) {
          throw new SessionError("BROKEN_TOOL_REFERENCE", turn.id, "Tool result has no call in its parent chain");
        }
      }
    }
    session.xExtensions["x-claude-record-graph"] = [...nodes].map(([id, e]) => ({ id, parent: e.value.parentUuid ?? null, artifact: e.artifact }));
    return { session, ledger };
  },
  export: (session, context) => buildInjectionBundle(session, "claude-code", context),
};
export default adapter;
