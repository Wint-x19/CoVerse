import { stringifyWireJson } from "@coverse/core";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { buildInjectionBundle, emptyLedger, isRecord, requireString, SessionError, type CSR, type FileSet, type JsonValue, type SessionAdapter, type SessionDiagnostic } from "@coverse/core";
import { decodeWire } from "./wire.js";
import {readSteps, type StepRow as Row} from "./steps.js";
import {localArtifactPath,nativeCompanions} from "./companions.js";
import { committedSnapshot } from "./wal.js";
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
function rows(db: Database, sql: string): Row[] {
  const result = db.exec(sql)[0];
  return result ? result.values.map(row => Object.fromEntries(result.columns.map((c, i) => [c, row[i]!]))) : [];
}
function jsonRow(row: Row): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? { encoding: "base64", data: Buffer.from(v).toString("base64") } : v]));
}
async function open(files: FileSet) {
  if (files.some(f => f.path.endsWith("-journal") && f.bytes.length)) throw new SessionError("UNSTABLE_INPUT", "/input", "Nonempty SQLite rollback journal requires a checkpointed snapshot");
  const inputs = files.filter(f => f.path.endsWith(".db"));
  if (inputs.length !== 1) throw new SessionError("AMBIGUOUS_INPUT", "/input", "Supply one stable Antigravity SQLite conversation snapshot");
  const file = inputs[0]!;
  if (new TextDecoder().decode(file.bytes.subarray(0, 16)) !== "SQLite format 3\0") throw new SessionError("UNSUPPORTED_FORMAT", file.path, "Expected SQLite conversation database");
  let db: Database | undefined;
  try {
    const logs = files.filter(f => f.path.endsWith("-wal") && f.bytes.length);
    if (logs.some(f => f.path !== file.path + "-wal")) throw new SessionError("UNSTABLE_INPUT", "/input", "Unmatched SQLite WAL");
    const bytes = logs[0] ? committedSnapshot(file.bytes, logs[0], files.find(f => f.path === file.path + "-shm")) : file.bytes;
    db = new (await engine()).Database(bytes);
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

async function importHistory(files:FileSet, forDisplay = false) {
  const { file, db } = await open(files);
  try {
    const meta = rows(db, "SELECT * FROM trajectory_meta");
    if (meta.length !== 1) throw new SessionError("AMBIGUOUS_INPUT", file.path, "Expected exactly one trajectory");
    const ledger = emptyLedger();
    const diagnostics:SessionDiagnostic[] = [];
    const session: CSR = { schemaVersion: "1.0", meta: { id: requireString(meta[0]!.trajectory_id, file.path), agent: "antigravity", agentFormatVersion: formatVersion }, turns: [], xExtensions: { "x-antigravity-trajectory": jsonRow(meta[0]!) }, sourceArtifacts: files, raw: {} };
    for (const table of Object.keys(columns)) (session.raw as Record<string, JsonValue>)[table] = rows(db, `SELECT * FROM ${table}${table === "steps" ? " ORDER BY idx" : ""}`).map(jsonRow);
    const parents: CSR["turns"] = [];
    for (const row of rows(db,"SELECT * FROM parent_references ORDER BY idx")) {
      if (!forDisplay) throw new SessionError("MISSING_RELATED_RECORD",file.path,"Referenced parent trajectory requires its original history");
      const ref = row.data instanceof Uint8Array ? decodeWire("TrajectoryReference",row.data,file.path).value : {};
      const at = file.path + "/parent_references/" + row.idx;
      const message = "Parent trajectory " + String(ref.conversation_id ?? ref.trajectory_id ?? row.idx) + " · step " + String(ref.step_index ?? "?");
      diagnostics.push({code:"MISSING_RELATED_RECORD",path:at,message,severity:"warning"});
      const id = ref.conversation_id ?? ref.trajectory_id;
      parents.push({id:at,role:"system",content:[{type:"text",text:message}],event:{id:at,kind:"context",text:message},
        ...(typeof id === "string" ? {relatedSessions:[{id,kind:"parent",...(typeof ref.step_index === "number" ? {step:ref.step_index} : {}),
          ...(typeof ref.trajectory_id === "string" ? {trajectoryId:ref.trajectory_id} : {})}]} : {})});
    }
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
    readSteps(session, rows(db, "SELECT * FROM steps ORDER BY idx"),{file,files,ledger,...(forDisplay ? {missing:diagnostics} : {})});
    session.turns = [...parents,...session.turns];
    ledger.downgraded.push({ code: "ARCHIVED_NATIVE_STATE", path: "/raw", reason: "Database generation, executor, rendering, configuration and permission state is archived; it is not restored in the target Agent" });
    if (diagnostics.length) session.incomplete = diagnostics;
    return { session, ledger,diagnostics };
  } finally { db.close(); }
}

const adapter: SessionAdapter = {
  localArtifactPath,
  async prepareLocalImport(files,_resolve,sourcePath) {
    if (!sourcePath) return files;
    const folder = path.dirname(sourcePath);
    if (!["antigravity","antigravity-cli"].some(name => path.relative(path.join(os.homedir(),".gemini",name,"conversations"),folder) === "")) return files;
    const {db,file} = await open(files);
    try {
      const id = rows(db,"SELECT cascade_id FROM trajectory_meta")[0]?.cascade_id;
      if (typeof id !== "string") return files;
      const steps = rows(db,"SELECT step_payload FROM steps ORDER BY idx").flatMap(row =>
        row.step_payload instanceof Uint8Array ? [decodeWire("Step",row.step_payload,file.path).value] : []);
      return await nativeCompanions(files,sourcePath,id,steps);
    } finally {db.close();}
  },
  id: "antigravity", displayName: "Antigravity", status: "ready", supportedVersions: [formatVersion],
  publishDesktopSession: async input => publishWhenDesktopClosed(input, await engine()),
  localResumeId(session, sourcePath) {
    const meta = session.xExtensions["x-antigravity-trajectory"];
    const id = isRecord(meta) && meta.cascade_id;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const nativePath = path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations", id + ".db");
    return path.relative(nativePath, path.resolve(sourcePath)) === "" ? id : undefined;
  },
  capabilities: { import: true, export: true, nativeResume: false, importFormats: ["sqlite-conversation-step0"], exportFormats: ["injection-bundle"] },
  readProjectDirectory: async files => {
    const { file, db } = await open(files);
    try { return workspaceDirectory(trajectoryMetadata(db, file.path)); }
    finally { db.close(); }
  },
  detect: async files => { try { const { db } = await open(files); db.close(); return { confidence: 1, formatVersion }; } catch (e) { return { confidence: 0, ...(e instanceof SessionError ? { diagnostics: [e.diagnostic] } : {}) }; } },
  import: files => importHistory(files),
  readForDisplay: files => importHistory(files,true),
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
