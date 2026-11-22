import { parseWireJson, stringifyWireJson } from "@coverse/core";
import { createRequire } from "node:module";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { buildInjectionBundle, emptyLedger, isRecord, requireString, SessionError, validateToolLinks, type ContentBlock, type CSR, type FileSet, type JsonValue, type SessionAdapter, type Turn } from "@coverse/core";
import { decodeWire } from "./wire.js";
import { publishWhenDesktopClosed } from "./desktop.js";

export const formatVersion = "sqlite-2_32_1-step0";
const require = createRequire(import.meta.url);
let sqlite: Promise<SqlJsStatic> | undefined;
const engine = () => sqlite ??= initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") });
const columns: Record<string, readonly string[]> = {
  trajectory_meta: ["trajectory_id", "cascade_id", "trajectory_type", "source"],
  steps: ["idx", "step_type", "status", "has_subtrajectory", "metadata", "error_details", "permissions", "task_details", "render_info", "step_payload", "step_format"],
  gen_metadata: ["idx", "data", "size"], executor_metadata: ["idx", "data"], parent_references: ["idx", "data"], trajectory_metadata_blob: ["id", "data"], battle_mode_infos: ["idx", "data"],
};
type Row = Record<string, string | number | Uint8Array | null>;
function rows(db: Database, sql: string): Row[] {
  const result = db.exec(sql)[0];
  return result ? result.values.map(row => Object.fromEntries(result.columns.map((c, i) => [c, row[i]!]))) : [];
}
function jsonRow(row: Row): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? { encoding: "base64", data: Buffer.from(v).toString("base64") } : v]));
}
async function open(files: FileSet) {
  if (files.some(f => /-(wal|journal)$/.test(f.path) && f.bytes.length)) throw new SessionError("UNSTABLE_INPUT", "/input", "Nonempty SQLite journal/WAL requires a consistent checkpointed snapshot");
  const inputs = files.filter(f => f.path.endsWith(".db"));
  if (inputs.length !== 1) throw new SessionError("AMBIGUOUS_INPUT", "/input", "Supply one stable Antigravity SQLite conversation snapshot");
  const file = inputs[0]!;
  if (new TextDecoder().decode(file.bytes.subarray(0, 16)) !== "SQLite format 3\0") throw new SessionError("UNSUPPORTED_FORMAT", file.path, "Expected SQLite conversation database");
  let db: Database | undefined;
  try {
    db = new (await engine()).Database(file.bytes);
    const tables = rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map(r => String(r.name));
    if (tables.length !== Object.keys(columns).length || tables.some(t => !Object.hasOwn(columns, t))) throw new SessionError("UNSUPPORTED_VERSION", file.path, "Unverified Antigravity database schema");
    for (const [table, expected] of Object.entries(columns)) {
      const actual = rows(db, `PRAGMA table_info('${table}')`).map(r => String(r.name));
      if (stringifyWireJson(actual) !== stringifyWireJson(expected)) throw new SessionError("UNSUPPORTED_VERSION", `${file.path}/${table}`, "Unverified database column layout");
    }
    if (rows(db, "PRAGMA quick_check")[0]?.quick_check !== "ok") throw new SessionError("INVALID_INPUT", file.path, "SQLite integrity check failed");
    return { file, db };
  } catch (e) {
    db?.close();
    if (e instanceof SessionError) throw e;
    throw new SessionError("INVALID_INPUT", file.path, "Cannot read SQLite conversation");
  }
}
function object(value: JsonValue | undefined, at: string): Record<string, JsonValue> {
  if (!isRecord(value)) throw new SessionError("INVALID_INPUT", at, "Required protobuf message is missing");
  return value;
}
const populated = (v: JsonValue | undefined) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && !v.length);
function opaqueFields(content: ContentBlock[], value: Record<string, JsonValue>, fields: readonly string[]) {
  for (const field of fields) if (populated(value[field])) content.push({ type: "opaque", source: `antigravity:${field}`, value: value[field]! });
}
function callBlock(value: JsonValue, at: string): Extract<ContentBlock, { type: "tool_call" }> {
  const call = object(value, at);
  if (populated(call.invalid_json_str) || populated(call.invalid_json_err)) throw new SessionError("INVALID_INPUT", at, "Native tool arguments are marked invalid");
  const text = requireString(call.arguments_json, at);
  let args: JsonValue;
  try { args = parseWireJson(text) as JsonValue; } catch { throw new SessionError("INVALID_INPUT", at, "Invalid tool argument JSON"); }
  return { type: "tool_call", id: requireString(call.id, at), name: requireString(call.name, at), arguments: args, argumentsText: text };
}
function trajectoryMetadata(db: Database, filePath: string) {
  const data = rows(db, "SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")[0]?.data;
  if (!(data instanceof Uint8Array)) return undefined;
  const decoded = decodeWire("TrajectoryMetadata", data, filePath + "/trajectory_metadata_blob");
  if (decoded.unknown.length) throw new SessionError("UNSUPPORTED_VERSION", decoded.unknown[0]!, "Unknown trajectory metadata field");
  return decoded.value;
}

function workspaceDirectory(metadata: Record<string, JsonValue> | undefined) {
  const workspaces = metadata?.workspaces;
  const first = Array.isArray(workspaces) ? workspaces[0] : undefined;
  return isRecord(first) && typeof first.workspace_folder_absolute_uri === "string" ? first.workspace_folder_absolute_uri : undefined;
}

const adapter: SessionAdapter = {
  id: "antigravity", displayName: "Antigravity", status: "ready", supportedVersions: [formatVersion],
  publishDesktopSession: async input => publishWhenDesktopClosed(input, await engine()),
  capabilities: { import: true, export: true, nativeResume: false, importFormats: ["sqlite-conversation-step0"], exportFormats: ["injection-bundle"] },
  readProjectDirectory: async files => {
    const { file, db } = await open(files);
    try { return workspaceDirectory(trajectoryMetadata(db, file.path)); }
    finally { db.close(); }
  },
  detect: async files => { try { const { db } = await open(files); db.close(); return { confidence: 1, formatVersion }; } catch (e) { return { confidence: 0, ...(e instanceof SessionError ? { diagnostics: [e.diagnostic] } : {}) }; } },
  import: async files => {
    const { file, db } = await open(files);
    try {
      const meta = rows(db, "SELECT * FROM trajectory_meta");
      if (meta.length !== 1) throw new SessionError("AMBIGUOUS_INPUT", file.path, "Expected exactly one trajectory");
      const ledger = emptyLedger();
      const session: CSR = { schemaVersion: "1.0", meta: { id: requireString(meta[0]!.trajectory_id, file.path), agent: "antigravity", agentFormatVersion: formatVersion }, turns: [], xExtensions: { "x-antigravity-trajectory": jsonRow(meta[0]!) }, sourceArtifacts: files, raw: {} };
      for (const table of Object.keys(columns)) (session.raw as Record<string, JsonValue>)[table] = rows(db, `SELECT * FROM ${table}${table === "steps" ? " ORDER BY idx" : ""}`).map(jsonRow);
      if (rows(db, "SELECT * FROM parent_references").length) throw new SessionError("MISSING_RELATED_RECORD", file.path, "Referenced parent trajectory requires a verified multi-trajectory importer");
      const metadata = trajectoryMetadata(db, file.path);
      if (metadata) {
        session.xExtensions["x-antigravity-metadata"] = metadata;
        const cwd = workspaceDirectory(metadata);
        if (cwd) session.meta.cwd = cwd;
        if (isRecord(metadata.created_at) && typeof metadata.created_at.seconds === "string") {
          const ms = Number(metadata.created_at.seconds) * 1000;
          if (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15) session.meta.createdAt = new Date(ms).toISOString();
        }
      }
      const calls = new Map<string, ContentBlock>();
      const steps = rows(db, "SELECT * FROM steps ORDER BY idx");
      for (const row of steps) {
        const at = `${file.path}/steps/${row.idx}`;
        if (row.step_format !== 0) throw new SessionError("UNSUPPORTED_VERSION", at, "Only verified step_format=0 is supported");
        if (row.has_subtrajectory) throw new SessionError("MISSING_RELATED_RECORD", at, "Subtrajectory cannot be silently omitted");
        if (!(row.step_payload instanceof Uint8Array)) throw new SessionError("INVALID_INPUT", at, "Missing step protobuf");
        const decoded = decodeWire("Step", row.step_payload, at), step = decoded.value;
        if (decoded.unknown.length) throw new SessionError("UNINTERPRETED_CONTENT", decoded.unknown[0]!, "Unknown protobuf field may contain conversation context");
        if (step.type !== row.step_type || step.status !== row.status) throw new SessionError("INVALID_INPUT", at, "SQLite and protobuf step type/status disagree");
        const contentFields: Record<number, string> = { 14: "user_input", 15: "planner_response", 17: "error_message", 23: "checkpoint", 101: "system_message", 132: "generic" };
        if (Object.values(contentFields).filter(key => step[key] !== undefined).join() !== contentFields[Number(step.type)]) throw new SessionError("INVALID_INPUT", at, "Step discriminator and payload variant disagree");
        if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12].includes(Number(step.status))) throw new SessionError("UNSUPPORTED_VERSION", at, "Unknown step status");
        const content: ContentBlock[] = [];
        let role: Turn["role"] = "system", kind: NonNullable<Turn["origin"]>["kind"] = "message";
        const recordCall = (value: JsonValue, inPlanner: boolean) => {
          const block = callBlock(value, at), old = calls.get(block.id);
          if (old && (inPlanner || stringifyWireJson(old) !== stringifyWireJson(block))) throw new SessionError("INVALID_INPUT", at, "Conflicting or duplicate native tool call");
          if (!old) { calls.set(block.id, block); content.push(block); }
          if (isRecord(value)) opaqueFields(content, value, ["function_call_parts"]);
          return block.id;
        };
        switch (step.type) {
          case 14: {
            role = "user"; const user = object(step.user_input, at);
            // query is legacy; user_response and TextOrScopeItem carry distinct native user inputs.
            for (const key of ["query", "user_response"]) if (typeof user[key] === "string" && user[key]) content.push({ type: "text", text: user[key] });
            if (Array.isArray(user.items)) for (const item of user.items) {
              const entry = object(item, at); if (typeof entry.text === "string") content.push({ type: "text", text: entry.text });
              opaqueFields(content, entry, ["item"]);
            }
            opaqueFields(content, user, ["active_user_state", "images", "artifact_comments", "media", "file_diff_comments", "file_comments", "side_channels"]);
            break;
          }
          case 15: {
            role = "assistant"; const planner = object(step.planner_response, at);
            for (const key of ["thinking", "raw_thinking"]) if (typeof planner[key] === "string") content.push({ type: "reasoning", text: planner[key] });
            if (typeof planner.response === "string") content.push({ type: "text", text: planner.response });
            if (typeof planner.modified_response === "string" && planner.modified_response !== planner.response) content.push({ type: "text", text: `Modified historical response:\n${planner.modified_response}` });
            if (Array.isArray(planner.tool_calls)) for (const call of planner.tool_calls) recordCall(call, true);
            opaqueFields(content, planner, ["thinking_redacted", "knowledge_base_items", "side_channels", "passback_context", "grounding_metadata", "media"]);
            break;
          }
          case 132: {
            role = "tool"; const generic = object(step.generic, at), metadata = object(step.metadata, at);
            const callId = recordCall(metadata.modified_tool_call ?? metadata.tool_call ?? null, false);
            if (isRecord(generic.result)) {
              const result = generic.result;
              content.push({ type: "tool_result", callId, content: typeof result.result === "string" ? result.result : "", isError: step.status === 7 });
              if (Array.isArray(result.metadata) || Array.isArray(result.data)) content.push({ type: "text", text: `Native tool result metadata:\n${stringifyWireJson({ metadata: result.metadata, data: result.data }, null, 2)}` });
              if (typeof result.full_output_uri === "string" && result.full_output_uri) {
                const name = decodeURIComponent(result.full_output_uri.split(/[\\/]/).at(-1)!);
                const candidates = files.filter(f => f.path === result.full_output_uri || f.path.split("/").at(-1) === name);
                if (candidates.length !== 1) throw new SessionError("MISSING_ATTACHMENT", at, "Supply the uniquely named full tool output referenced by full_output_uri");
                content.push({ type: "attachment", path: candidates[0]!.path, mediaType: "text/plain" });
              }
              opaqueFields(content, result, ["payload", "media", "data", "tool_call_step", "tool_result_step", "result_struct", "result_value"]);
            } else if (step.status === 3) throw new SessionError("INVALID_INPUT", at, "Completed tool step has no result");
            else content.push({ type: "text", text: `Historical tool step has no result; native status=${String(step.status)}` });
            break;
          }
          case 101: {
            const system = object(step.system_message, at);
            if (typeof system.message === "string") content.push({ type: "text", text: system.message });
            if (system.metadata) content.push({ type: "text", text: `Historical system metadata:\n${stringifyWireJson(system.metadata)}` });
            opaqueFields(content, system, ["agent_message", "media"]); break;
          }
          case 17: content.push({ type: "text", text: `Historical error:\n${stringifyWireJson(object(step.error_message, at), null, 2)}` }); break;
          case 23: {
            kind = "compaction"; const checkpoint = object(step.checkpoint, at);
            const opaqueKeys = ["edited_file_map", "artifact_snapshots", "trajectory_file_diffs", "subagent_snapshots", "running_task_snapshots", "accumulated_sections", "captured_user_requests", "captured_parent_messages"];
            const readable = Object.fromEntries(Object.entries(checkpoint).filter(([key]) => !opaqueKeys.includes(key)));
            content.push({ type: "text", text: `Historical checkpoint:\n${stringifyWireJson(readable, null, 2)}` });
            if (step.status === 3) {
              const covered = new Set(Array.isArray(checkpoint.included_step_indices) ? checkpoint.included_step_indices : []);
              const start = checkpoint.included_step_index_start, end = checkpoint.included_step_index_end;
              const range = covered.size === 0 && typeof start === "number" && typeof end === "number" && start <= end && end < Number(row.idx);
              const knownCoverage = range || covered.size > 0;
              const previous = session.continuation;
              const priorBoundary = previous ? session.turns.findIndex(t => t.id === previous.boundaryId) : -1;
              const priorIds = new Set(previous?.retainedIds);
              const retainedIds = session.turns.filter((t, i) => {
                const index = t.origin!.record;
                return knownCoverage && (i > priorBoundary || priorIds.has(t.id)) && !covered.has(index) &&
                  !(range && index >= start && index <= end);
              }).map(t => t.id);
              const boundaryId = `${session.meta.id}:${row.idx}`;
              session.continuation = { boundaryId, retainedIds: [...retainedIds, boundaryId], replacement: [] };
              if (!knownCoverage) ledger.approximated.push({ code: "UNVERIFIED_CHECKPOINT_COVERAGE", path: at,
                reason: "Only the checkpoint and later steps are forwarded; earlier retained steps could not be verified" });
            }
            opaqueFields(content, checkpoint, opaqueKeys); break;
          }
          default: throw new SessionError("UNSUPPORTED_VERSION", at, "Unverified Antigravity step type");
        }
        if (step.error) content.push({ type: "text", text: `Historical step error:\n${stringifyWireJson(step.error)}` });
        session.turns.push({ id: `${session.meta.id}:${row.idx}`, role, content, raw: step, origin: { artifact: file.path, record: Number(row.idx), branchId: session.meta.id, kind: step.status === 5 ? "reverted" : kind } });
      }
      validateToolLinks(session.turns);
      ledger.downgraded.push({ code: "ARCHIVED_NATIVE_STATE", path: "/raw", reason: "Database generation, executor, rendering, configuration and permission state is archived; it is not restored in the target Agent" });
      return { session, ledger };
    } finally { db.close(); }
  },
  export: (session, context) => {
    const diagnostics = [...(context?.diagnostics ?? [])];
    if (session.transcript?.some(m => m.changedFiles?.length)) {
      diagnostics.push({code:"DESKTOP_FILE_CHANGES_AS_TEXT",path:"/transcript",severity:"warning",
        message:"The desktop copy shows recorded paths and net line counts as text. Original patches remain in the source archive."});
    }
    if (session.transcript && session.continuation) {
      diagnostics.push({code:"DESKTOP_CONTEXT_REBUILT",path:"/continuation",severity:"warning",
        message:"Desktop history displays the original conversation. Antigravity builds its own model window; the CLI bundle retains the source checkpoint."});
    }
    return buildInjectionBundle(session, "antigravity", {...context, diagnostics});
  },
};
export default adapter;
