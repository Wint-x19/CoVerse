import { decompress } from "fzstd";
import { isRecord, parseJsonLines, SessionError, type Artifact, type FileSet } from "@coverse/core";

const rolloutName = /\.jsonl(?:\.zst)?$/;
export const verifiedWriters = new Set(["0.167.0-alpha.4.1", "0.169.0-alpha.11.1", "0.169.1", "0.171.0-alpha.13"]);
export function primaryLog(files: FileSet) {
  const logs = files.filter(f => rolloutName.test(f.path) && !f.path.startsWith("ancestors/"));
  if (logs.length !== 1) throw new SessionError("AMBIGUOUS_INPUT", "/input", "Supply one selected Codex rollout");
  return logs[0]!;
}
function bytesOf(file: Artifact): Uint8Array {
  return file.path.endsWith(".zst") ? decompress(file.bytes) : file.bytes;
}
function header(file: Artifact) {
  const bytes = bytesOf(file);
  const end = bytes.indexOf(10);
  const row = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end < 0 ? bytes.length : end)));
  if (row.type !== "session_meta" || !isRecord(row.payload)) throw new SessionError("INVALID_INPUT", file.path, "Missing Codex session header");
  if (!verifiedWriters.has(String(row.payload.cli_version))) throw new SessionError("UNSUPPORTED_VERSION", file.path, "Unverified Codex ancestor writer: " + row.payload.cli_version);
  return row.payload;
}
function boundary(file: Artifact) {
  const meta = header(file);
  const base = meta.history_base;
  if (base == null) return;
  if (!isRecord(base) || typeof base.thread_id !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(base.thread_id) ||
      base.thread_id !== meta.forked_from_id || !Number.isSafeInteger(base.end_byte_offset) || !Number.isSafeInteger(base.end_ordinal_exclusive) ||
      (meta.forked_from_ordinal_exclusive !== undefined && base.end_ordinal_exclusive !== meta.forked_from_ordinal_exclusive) ||
      Number(base.end_byte_offset) <= 0 || Number(base.end_ordinal_exclusive) < 1) {
    throw new SessionError("INVALID_INPUT", file.path, "Invalid Codex fork history boundary");
  }
  return { id: base.thread_id, offset: Number(base.end_byte_offset), ordinal: Number(base.end_ordinal_exclusive) };
}
export async function prepareLineage(files: FileSet, resolve: (id: string) => Promise<FileSet>): Promise<FileSet> {
  let file = primaryLog(files);
  const prepared = [...files];
  const visited = new Set([header(file).id]);
  for (let base = boundary(file); base; base = boundary(file)) {
    if (visited.has(base.id)) throw new SessionError("INVALID_INPUT", file.path, "Cyclic Codex fork ancestry");
    visited.add(base.id);
    const name = "ancestors/" + base.id + ".jsonl";
    const existing = prepared.find(f => f.path === name);
    const parent = existing ?? primaryLog(await resolve(base.id));
    const bytes = bytesOf(parent);
    if (header(parent).id !== base.id || base.offset > bytes.length ||
        (base.offset < bytes.length && bytes[base.offset - 1] !== 10)) {
      throw new SessionError("INVALID_INPUT", name, "Codex parent identity or fork byte boundary changed");
    }
    file = { path: name, bytes: bytes.slice(0, base.offset) };
    if (parseJsonLines(file.bytes, name).length !== base.ordinal || (existing && bytes.length !== base.offset)) {
      throw new SessionError("INVALID_INPUT", name, "Codex fork ordinal does not match its byte boundary");
    }
    if (!existing) prepared.push(file);
  }
  return prepared;
}
export function ancestralRecords(files: FileSet) {
  const segments = [];
  let file = primaryLog(files);
  const visited = new Set<string>();
  while (true) {
    segments.unshift(parseJsonLines(bytesOf(file), file.path).slice(1).map(r => ({ ...r, artifact: file.path })));
    const base = boundary(file);
    if (!base) break;
    const parent = files.find(f => f.path === "ancestors/" + base.id + ".jsonl");
    if (!parent) throw new SessionError("MISSING_RELATED_RECORD", file.path, "Import this fork from the local Codex catalog or supply its recorded parent prefix.");
    if (visited.has(base.id) || header(parent).id !== base.id || parent.bytes.length !== base.offset ||
        parseJsonLines(parent.bytes, parent.path).length !== base.ordinal) throw new SessionError("INVALID_INPUT", parent.path, "Invalid Codex parent prefix");
    visited.add(base.id);
    file = parent;
  }
  return segments.flat();
}
