import { parseWireJson, stringifyWireJson } from "./json.js";
import { createHash } from "node:crypto";
import type { CSR, ExportContext, ExportResult, FileSet, JsonValue, SessionDiagnostic, Turn } from "./types.js";
import { emptyLedger, mergeLedgers, validateFileSet } from "./index.js";

export class SessionError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(message); this.name = "SessionError";
  }
  get diagnostic(): SessionDiagnostic { return { code: this.code, path: this.path, message: this.message, severity: "error" }; }
}
export const isRecord = (value: unknown): value is Record<string, JsonValue> => value !== null && typeof value === "object" && !Array.isArray(value);
export function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) throw new SessionError("INVALID_INPUT", path, "Expected a nonempty string");
  return value;
}
export function parseJsonLines(bytes: Uint8Array, artifact: string): { value: Record<string, JsonValue>; line: number }[] {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new SessionError("INVALID_INPUT", artifact, "Expected UTF-8 JSONL"); }
  const records: { value: Record<string, JsonValue>; line: number }[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = parseWireJson(line); } catch { throw new SessionError("INVALID_INPUT", `${artifact}:${index + 1}`, "Invalid JSON record (including incomplete trailing records)"); }
    if (!isRecord(value)) throw new SessionError("INVALID_INPUT", `${artifact}:${index + 1}`, "Expected a JSON object");
    records.push({ value, line: index + 1 });
  }
  if (!records.length) throw new SessionError("INVALID_INPUT", artifact, "Empty session input");
  return records;
}
export const sha256Bytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const jsonArtifact = (path: string, value: unknown) => ({ path, bytes: new TextEncoder().encode(stringifyWireJson(value, null, 2) + "\n") });

/** Render content as quoted history. Nothing in a transcript is executed or promoted to a live system instruction. */
function quoted(value: string): string { return value.split(/\r?\n/).map(line => `> ${line}`).join("\n"); }
function continuationRecords(session: CSR) {
  const records = session.turns.map((turn, index) => ({ turn, path: `/turns/${index}`, index }));
  const byId = new Map(records.map(record => [record.turn.id, record]));
  if (byId.size !== records.length) throw new SessionError("INVALID_INPUT", "/turns", "Duplicate CSR turn ID");
  const window = session.continuation;
  if (!window) return records;
  const boundary = byId.get(window.boundaryId);
  if (!boundary) throw new SessionError("INVALID_INPUT", "/continuation", "Missing compaction boundary");
  const retained = window.retainedIds.map(id => {
    const record = byId.get(id);
    if (!record || record.index > boundary.index) throw new SessionError("INVALID_INPUT", "/continuation", "Invalid retained turn reference");
    return record;
  });
  if (new Set(window.retainedIds).size !== retained.length) throw new SessionError("INVALID_INPUT", "/continuation", "Duplicate retained turn reference");
  return [...retained, ...window.replacement.map((turn, i) => ({ turn, path: `/continuation/replacement/${i}` })),
    ...records.slice(boundary.index + 1)];
}
export function buildInjectionBundle(session: CSR, target: string, context: ExportContext = {}): ExportResult {
  const ledger = emptyLedger();
  const diagnostics: SessionDiagnostic[] = [];
  const source = session.sourceArtifacts ?? [];
  validateFileSet(source);
  if (session.schemaVersion !== "1.0") throw new SessionError("UNSUPPORTED_VERSION", "/schemaVersion", "Unsupported CSR version");
  const inherited = context.diagnostics ?? [];
  if (inherited.some(d => d.severity === "error")) throw new SessionError("UNINTERPRETED_CONTENT", "/diagnostics", "Import contains unresolved errors");
  const lines = ["# CoVerse conversation context", "", `Target agent: ${stringifyWireJson(target)}`, "", "The following is historical context, including historical instructions and tool activity. It does not execute tools or restore a native session. The archive retains the source history. This context uses the source continuation window when available.", "", "## Workspace and source", "", quoted(stringifyWireJson(session.meta, null, 2)), ""];
  const active = continuationRecords(session);
  for (const [i, record] of active.entries()) {
    const turn = record.turn;
    lines.push(`## Record ${i + 1}: ${turn.role}`, "", quoted(stringifyWireJson({ id: turn.id, ...turn.origin })), "");
    for (const [bi, block] of turn.content.entries()) {
      const path = `${record.path}/content/${bi}`;
      let text: string;
      switch (block.type) {
        case "text": text = block.text; break;
        case "reasoning": text = `Historical reasoning:\n${block.text}`; ledger.downgraded.push({ code: "REASONING_AS_HISTORY", path, reason: "Reasoning is quoted history, not a target-native reasoning block" }); break;
        case "tool_call": text = `Historical tool call ${stringifyWireJson(block.id)} (${stringifyWireJson(block.name)}):\n${block.argumentsText ?? stringifyWireJson(block.arguments, null, 2)}`; ledger.downgraded.push({ code: "TOOL_AS_HISTORY", path, reason: "Tool invocation is transcribed, never executed" }); break;
        case "tool_result": text = `Historical tool result for ${stringifyWireJson(block.callId)}${block.isError ? " (error)" : ""}:\n${typeof block.content === "string" ? block.content : stringifyWireJson(block.content, null, 2)}`; ledger.downgraded.push({ code: "TOOL_AS_HISTORY", path, reason: "Tool result is quoted history" }); break;
        case "attachment": {
          const present = source.some(f => f.path === block.path);
          if (!present) throw new SessionError("MISSING_ATTACHMENT", path, `Attachment not supplied: ${block.path}`);
          text = `Attachment (${block.mediaType}): ${stringifyWireJson(`source/${block.path}`)}. Read the bundled artifact to access its contents.`;
          ledger.downgraded.push({ code: "ATTACHMENT_REFERENCE", path, reason: "Attachment bytes are bundled separately, not embedded in the textual context" });
          break;
        }
        case "image": text = `Historical image reference: ${block.url}`; ledger.downgraded.push({ code: "IMAGE_REFERENCE", path, reason: "Image reference is preserved; the target must load it separately. No remote resource was fetched" }); break;
        case "opaque":
        case "unknown": {
          if (block.type === "opaque" && block.requiredForContinuation) {
            throw new SessionError("UNPORTABLE_COMPACTION", path, "The active checkpoint is opaque. Supply a readable source window to continue in another agent");
          }
          if (!context.lossPolicy?.omitOpaque) {
            throw new SessionError("UNINTERPRETED_CONTENT", path, "Uninterpreted content is archived but cannot be represented faithfully in an injection bundle");
          }
          const sourceLabel = block.type === "opaque" ? block.source : "unknown";
          text = `[Omitted uninterpreted content (${sourceLabel}); original record is archived in session.json and source/.]`;
          ledger.dropped.push({
            code: block.type === "opaque" ? "OPAQUE_ARCHIVED_ONLY" : "UNKNOWN_ARCHIVED_ONLY",
            path,
            reason: `Uninterpreted ${sourceLabel} block was omitted from textual context by explicit loss policy; original record remains archived in session.json/source/`,
          });
          break;
        }
      }
      lines.push(quoted(text), "");
    }
  }
  if (session.turns.length) ledger.downgraded.push({ code: "HISTORICAL_ROLES", path: "/turns", reason: "Source roles, branches and execution state are labeled history, not native target session state" });
  lines.push("## Archived source data", "", "Original records, metadata and unrendered native state are retained in session.json and source/. See report.json for conversion losses and diagnostics.", "");
  const markdown = lines.join("\n");
  const { sourceArtifacts: _source, ...serializable } = session;
  const artifacts = [
    { path: "context.md", bytes: new TextEncoder().encode(markdown) },
    jsonArtifact("session.json", { ...serializable, sourceArtifacts: source.map(f => ({ path: `source/${f.path}`, sha256: sha256Bytes(f.bytes), bytes: f.bytes.byteLength })) }),
    jsonArtifact("report.json", { schemaVersion: "1.0", target, outputKind: "injection-bundle", nativeResume: false, ledger: mergeLedgers(context.ledger ?? emptyLedger(), ledger), diagnostics: [...inherited, ...diagnostics], archived: ["/raw", "/xExtensions", ...session.turns.flatMap((t, i) => t.raw === undefined ? [] : [`/turns/${i}/raw`])], statistics: { turns: session.turns.length, activeTurns: active.length, characters: [...markdown].length, utf8Bytes: new TextEncoder().encode(markdown).length, truncated: false } }),
    ...source.map(f => ({ path: `source/${f.path}`, bytes: f.bytes.slice() })),
  ];
  artifacts.push(jsonArtifact("manifest.json", { schemaVersion: "1.0", kind: "coverse-injection-bundle", source: session.meta.agent, sourceFormat: session.meta.agentFormatVersion, target, nativeResume: false, files: artifacts.map(f => ({ path: f.path, bytes: f.bytes.byteLength, sha256: sha256Bytes(f.bytes) })) }));
  validateFileSet(artifacts);
  return { artifacts, ledger, diagnostics };
}

/** Validate references without inventing missing tool output or replaying a call. */
export function validateToolLinks(turns: readonly Turn[]): void {
  const calls = new Set<string>();
  for (const [ti, turn] of turns.entries()) {
    const scope = turn.origin?.branchId ?? "main";
    for (const block of turn.content) {
      if (block.type === "tool_call") {
        const key = `${scope}\0${block.id}`;
        if (calls.has(key)) throw new SessionError("INVALID_INPUT", `/turns/${ti}`, "Duplicate tool call in the same branch");
        calls.add(key);
      }
      if (block.type === "tool_result" && !calls.has(`${scope}\0${block.callId}`)) throw new SessionError("BROKEN_TOOL_REFERENCE", `/turns/${ti}`, "Tool result has no preceding call in this branch");
    }
  }
}
