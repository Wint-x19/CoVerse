import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SqlJsStatic } from "sql.js";
import protobuf from "protobufjs";
import { parseWireJson, renderContinuationHistory, SessionError, verifyInjectionBundle, type CSR, type DesktopPublication, type TranscriptMessage } from "@coverse/core";
import { wireRoot } from "./wire.js";

function encode(name: string, value: object): Uint8Array {
  const type = wireRoot.lookupType(name);
  return type.encode(type.fromObject(value)).finish();
}

/** Keep the original wire encoding for target-owned runtime fields outside the transcript. */
function selectFields(bytes: Uint8Array, numbers: readonly number[]): Buffer {
  const reader = protobuf.Reader.create(bytes);
  const parts = [];
  while (reader.pos < reader.len) {
    const start = reader.pos, tag = reader.uint32();
    reader.skipType(tag & 7);
    if (numbers.includes(tag >>> 3)) parts.push(bytes.subarray(start, reader.pos));
  }
  return Buffer.concat(parts);
}

async function readSeed(base: string, id: string, sql: SqlJsStatic) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw Error("Invalid Antigravity CLI session ID");
  const file = path.join(base, "antigravity-cli", "conversations", id + ".db");
  async function snapshotStatus() {
    for (const suffix of ["-wal", "-journal"]) {
      const info = await fs.stat(file + suffix).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (info?.size) throw new SessionError("UNSTABLE_INPUT", "/desktop", "Finish the active Antigravity CLI session before syncing.");
    }
    return fs.stat(file, { bigint: true });
  }
  const before = await snapshotStatus();
  const bytes = await fs.readFile(file);
  const after = await snapshotStatus();
  if (after.ino !== before.ino || after.ctimeNs !== before.ctimeNs || after.size !== before.size) throw Error("Antigravity CLI session changed during export");
  const db = new sql.Database(bytes);
  try {
    const ids = db.exec("SELECT cascade_id FROM trajectory_meta")[0]?.values;
    if (db.exec("PRAGMA user_version")[0]?.values[0]?.[0] !== 1 || ids?.length !== 1 || ids[0]?.[0] !== id ||
      db.exec("SELECT idx FROM steps WHERE step_format <> 0 LIMIT 1").length) {
      throw new SessionError("UNSUPPORTED_VERSION", "/desktop", "Unverified Antigravity CLI trajectory");
    }
    const blob = (query: string) => {
      const value = db.exec(query)[0]?.values[0]?.[0];
      if (!(value instanceof Uint8Array)) throw Error("Missing native Antigravity execution state");
      return value;
    };
    const input = wireRoot.lookupType("Step").decode(blob("SELECT step_payload FROM steps WHERE step_type=14 ORDER BY idx LIMIT 1"));
    const user = wireRoot.lookupType("Step").toObject(input).user_input;
    const gen = db.exec("SELECT data,size FROM gen_metadata WHERE idx=0")[0]?.values[0];
    if (!(gen?.[0] instanceof Uint8Array) || typeof gen[1] !== "number") throw Error("Missing native generation metadata");
    const executor = blob("SELECT data FROM executor_metadata WHERE idx=0");
    // The target generated these settings for this handoff. Never import source-agent tool calls or permissions.
    return { userConfig: user?.user_config as Uint8Array | undefined,
      executor: selectFields(executor, [10, 11, 16, 17, 18]), genData: gen[0], genSize: gen[1],
      trajectory: selectFields(blob("SELECT data FROM trajectory_metadata_blob WHERE id='main'"), [3,15]) };
  } finally { db.close(); }
}

function stableId(kind: string, key: string): string {
  const bytes = createHash("sha256").update("CoVerse/" + kind + "/" + key).digest();
  bytes[6] = (bytes[6]! & 15) | 0x80;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join("-");
}

// Publish a complete new file without ever replacing an existing native conversation or project.
async function publishNew(filename: string, bytes: Uint8Array): Promise<void> {
  const temp = path.join(path.dirname(filename), ".coverse-" + randomUUID() + ".tmp");
  await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
  try {
    await fs.link(temp, filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function pathKey(p: string): string {
  const normalized = path.resolve(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function findDesktopProject(projects: string, cwd: string) {
  const folder = await fs.realpath(cwd);
  const key = pathKey(folder);
  const matches = [];
  for (const entry of await fs.readdir(projects, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const project = JSON.parse(await fs.readFile(path.join(projects, entry.name), "utf8"));
    if (project.id !== entry.name.slice(0, -5)) continue;
    for (const resource of project.projectResources?.resources ?? []) {
      const uri = resource.folderUri ?? resource.gitFolder?.folderUri;
      if (typeof uri === "string" && uri.startsWith("file:") && pathKey(fileURLToPath(uri)) === key) {
        matches.push({ id: String(project.id), uri });
        break;
      }
    }
  }
  if (matches.length > 1) throw new SessionError("AMBIGUOUS_PROJECT", "/cwd", "Multiple Antigravity projects contain this folder.");
  if (matches[0]) return matches[0];
  const id = stableId("project", key);
  const uri = pathToFileURL(folder).href;
  const project = { id, name: path.basename(folder) || folder, projectResources: { resources: [{ folderUri: uri }] }, settings: {} };
  const filename = path.join(projects, id + ".json");
  await publishNew(filename, Buffer.from(JSON.stringify(project)));
  const saved = JSON.parse(await fs.readFile(filename, "utf8"));
  if (saved.id !== id || saved.projectResources?.resources?.[0]?.folderUri !== uri) throw Error("Desktop project path collision");
  return { id, uri };
}

const schema = [
  "PRAGMA page_size=32768",
  "PRAGMA user_version=1",
  "CREATE TABLE trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer)",
  "CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0)",
  "CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0)",
  "CREATE TABLE executor_metadata (idx integer PRIMARY KEY, data blob)",
  "CREATE TABLE parent_references (idx integer PRIMARY KEY, data blob)",
  "CREATE TABLE trajectory_metadata_blob (id text PRIMARY KEY DEFAULT 'main', data blob)",
  "CREATE TABLE battle_mode_infos (idx integer PRIMARY KEY, data blob)",
  "CREATE INDEX idx_steps_status ON steps(status)",
  "CREATE INDEX idx_steps_step_type ON steps(step_type)",
];

export async function publishToStore(input: DesktopPublication, base: string, sql: SqlJsStatic, beforeRegistration?: () => Promise<void>) {
  const hub = path.join(base, "antigravity");
  const indexPath = path.join(hub, "agyhub_summaries_proto.pb");
  const indexType = wireRoot.lookupType("DesktopIndex");
  const readIndex = async () => indexType.toObject(indexType.decode(await fs.readFile(indexPath))) as {
    entries?: { key: string; value: { trajectory_id: string } }[];
  };
  const index = await readIndex();
  const id = stableId("desktop", input.transferId);
  const tid = stableId("trajectory", input.transferId);
  const filename = path.join(hub, "conversations", id + ".db");
  const savedEntry = index.entries?.find(e => e.key === id);
  if (savedEntry && savedEntry.value.trajectory_id !== tid) throw Error("Desktop conversation ID collision");
  if (savedEntry) {
    await fs.access(filename);
    return id;
  }

  const artifacts = await input.loadArtifacts();
  verifyInjectionBundle(artifacts, "antigravity");
  const csrFile = artifacts.find(f => f.path === "session.json")!;
  const csr = parseWireJson(new TextDecoder().decode(csrFile.bytes)) as unknown as CSR;
  csr.sourceArtifacts = artifacts.filter(f => f.path.startsWith("source/")).map(f => ({ path: f.path.slice(7), bytes: f.bytes }));
  const history: TranscriptMessage[] = csr.transcript ?? renderContinuationHistory(csr, { lossPolicy: { omitOpaque: true } }).map(({turn, blocks}) => {
    let text = blocks.join("\n\n");
    if (text && turn.role !== "user" && turn.role !== "assistant") text = "[Historical " + turn.role + "]\n" + text;
    if (turn.content.some(block => block.type === "attachment")) text += "\nBundle directory: " + input.bundleDirectory;
    return { id: turn.id, role: turn.role === "user" ? "user" as const : "assistant" as const, text };
  });
  const seed = input.cliSessionId ? await readSeed(base, input.cliSessionId, sql) : undefined;
  const project = await findDesktopProject(path.join(base, "config", "projects"), input.cwd);
  const now = Date.now();
  const timestamp = { seconds: Math.floor(now / 1000), nanos: (now % 1000) * 1000000 };
  const workspace = { workspace_folder_absolute_uri: project.uri };
  const meta = { workspaces: [workspace], workspace_uris: [project.uri], project_id: project.id,
    created_at: timestamp, root_conversation_id: id };
  const db = new sql.Database();
  const execution = randomUUID();
  let count = 0, lastUser = 0;
  try {
    for (const statement of schema) db.run(statement);
    db.run("INSERT INTO trajectory_meta VALUES (?,?,4,1)", [tid, id]);
    db.run("INSERT INTO trajectory_metadata_blob VALUES ('main',?)", [Buffer.concat([seed?.trajectory ?? Buffer.alloc(0), encode("TrajectoryMetadata", meta)])]);
    if (seed) db.run("INSERT INTO gen_metadata VALUES (0,?,?)", [seed.genData, seed.genSize]);
    for (const message of history) {
      const user = message.role === "user";
      let text = message.text;
      if (message.changedFiles?.length) {
        const files = message.changedFiles;
        const list = files.map(f => "- `" + f.path.replaceAll("`", "\\`") + "`　+" + f.added + " −" + f.removed);
        text += "\n\n**已编辑 " + files.length + " 个文件**　+" + files.reduce((s,f) => s+f.added,0) +
          " −" + files.reduce((s,f) => s+f.removed,0) + "\n\n" + list.join("\n");
      }
      if (!text && !message.activity) continue;
      const ms = message.createdAt ? Date.parse(message.createdAt) : NaN;
      const stepTime = Number.isFinite(ms) ? { seconds: Math.floor(ms/1000), nanos: (ms%1000)*1000000 } : timestamp;
      const type = user ? 14 : 15;
      const metadata = { source: user ? 4 : 2, execution_id: execution, created_at: stepTime, viewable_at: stepTime, completed_at: stepTime,
        model_api_content_id: randomUUID(), source_trajectory_step_info: encode("DesktopStepOrigin", {trajectory_id: tid, step_index: count, cascade_id: id}) };
      const body = user ? { user_input: { user_response: text, items: [{ text }], user_config: seed?.userConfig, client_message_id: randomUUID() } }
        : { planner_response: { response: text, modified_response: text, thinking: message.activity,
          message_id: randomUUID(), stop_reason: 2 } };
      db.run("INSERT INTO steps (idx,step_type,status,metadata,step_payload) VALUES (?,?,3,?,?)",
        [count, type, encode("Metadata", metadata), encode("Step", { type, status: 3, metadata, ...body })]);
      if (user) lastUser = count;
      count++;
    }
    if (!count) throw Error("No readable records in the source continuation window");
    db.run("INSERT INTO executor_metadata VALUES (0,?)", [Buffer.concat([seed?.executor ?? Buffer.alloc(0), encode("DesktopExecutor",
      { termination_reason: 4, last_step_idx: count - 1, execution_id: execution })])]);
    await publishNew(filename, db.export());
  } finally { db.close(); }

  // An earlier export may have stopped between file creation and registration. Never overwrite a resumed chat.
  const saved = new sql.Database(await fs.readFile(filename));
  try {
    const row = saved.exec("SELECT cascade_id,trajectory_id FROM trajectory_meta")[0]?.values[0];
    if (row?.[0] !== id || row[1] !== tid) throw Error("Desktop conversation path collision");
  } finally { saved.close(); }
  await fs.mkdir(path.join(hub, "annotations"), {recursive: true});
  await publishNew(path.join(hub, "annotations", id + ".pbtxt"), Buffer.from("title: " + JSON.stringify(input.title) + "\n"));
  // Generating a large history can take time. The user may have relaunched the client.
  await beforeRegistration?.();
  if (!(await readIndex()).entries?.some(e => e.key === id)) {
    const entry = { key: id, value: { summary: input.title, annotations: { title: input.title }, step_count: count, status: 1,
      last_modified_time: timestamp, created_time: timestamp, last_user_input_time: timestamp, last_user_input_step_index: lastUser,
      trajectory_id: tid, trajectory_type: 4, latest_executor_termination_reason: 4, workspaces: [workspace], trajectory_metadata: meta } };
    // The native index is a protobuf map. Append one complete entry, preserving other entries and unknown fields byte-for-byte.
    await fs.appendFile(indexPath, encode("DesktopIndex", { entries: [entry] }), { flag: "a" });
    if (!(await readIndex()).entries?.some(e => e.key === id && e.value.trajectory_id === tid)) throw Error("Desktop index registration failed");
  }
  return id;
}

async function requireClosedDesktop() {
  const { stdout } = await promisify(execFile)(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe"),
    ["/FI", "IMAGENAME eq Antigravity.exe", "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 10000 });
  if (/^"Antigravity\.exe",/im.test(stdout)) throw new SessionError("DESKTOP_OPEN", "/desktop", "Close Antigravity and sync again so it can reload its project index.");
}

export async function publishWhenDesktopClosed(input: DesktopPublication, sql: SqlJsStatic) {
  if (process.platform !== "win32") throw new SessionError("UNSUPPORTED_VERSION", "/desktop", "Desktop registration has been verified on Windows.");
  await requireClosedDesktop();
  return publishToStore(input, path.join(os.homedir(), ".gemini"), sql, requireClosedDesktop);
}
