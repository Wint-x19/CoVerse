import { isRecord, SessionError, sha256Bytes } from "./session.js";
import { validateFileSet } from "./index.js";
import type { FileSet, JsonValue } from "./types.js";

function invalid(path: string, message: string): never {
  throw new SessionError("INVALID_BUNDLE", path, message);
}

/** Validate the same bytes that will be injected. Source files may contain arbitrary binary data. */
export function verifyInjectionBundle(files: FileSet, target: string) {
  try { validateFileSet(files); } catch { invalid("/manifest", "Invalid artifact paths"); }
  const contents = new Map(files.map(file => [file.path, file.bytes]));
  function readText(name: string): string {
    const bytes = contents.get(name) ?? invalid(name, "Required bundle file is missing");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return invalid(name, "Expected UTF-8 text"); }
  }
  function readObject(name: string) {
    const text = readText(name);
    let value: unknown;
    try { value = JSON.parse(text); } catch { invalid(name, "Expected JSON"); }
    if (!isRecord(value)) invalid(name, "Expected a JSON object");
    return value;
  }

  const manifest = readObject("manifest.json");
  if (manifest.kind !== "coverse-injection-bundle" || manifest.schemaVersion !== "1.0" ||
      manifest.nativeResume !== false || manifest.target !== target || !Array.isArray(manifest.files)) {
    invalid("manifest.json", "Unsupported bundle version, kind or target agent");
  }
  const names = new Set<string>();
  for (const entry of manifest.files) {
    if (!isRecord(entry) || typeof entry.path !== "string" || entry.path === "manifest.json" || names.has(entry.path)) {
      invalid("manifest.json", "Invalid or duplicate manifest entry");
    }
    names.add(entry.path);
    const bytes = contents.get(entry.path);
    if (!bytes || bytes.byteLength !== entry.bytes || sha256Bytes(bytes) !== entry.sha256) {
      invalid(entry.path, "Bundle checksum or size mismatch");
    }
  }
  if (names.size !== contents.size - 1) invalid("manifest.json", "Incomplete bundle inventory");
  const context = readText("context.md");
  const session = readObject("session.json"), report = readObject("report.json");
  if (session.schemaVersion !== "1.0" || !isRecord(session.meta) || !Array.isArray(session.turns) ||
      session.meta.agent !== manifest.source || session.meta.agentFormatVersion !== manifest.sourceFormat) {
    invalid("session.json", "Unsupported or inconsistent source session");
  }
  if (!Array.isArray(session.sourceArtifacts)) invalid("session.json", "Missing source artifact inventory");
  const archived = new Set<string>();
  for (const item of session.sourceArtifacts) {
    if (!isRecord(item) || typeof item.path !== "string" || !item.path.startsWith("source/") || archived.has(item.path)) {
      invalid("session.json", "Invalid source artifact reference");
    }
    const bytes = contents.get(item.path);
    if (!bytes || item.bytes !== bytes.byteLength || item.sha256 !== sha256Bytes(bytes)) {
      invalid(item.path, "Source artifact differs from the archived session reference");
    }
    archived.add(item.path);
  }
  for (const name of names) if (name.startsWith("source/") && !archived.has(name)) invalid(name, "Unreferenced source artifact");
  const attachments = new Set<string>();
  const replacement = session.continuation;
  if (replacement !== undefined && (!isRecord(replacement) || !Array.isArray(replacement.replacement))) invalid("session.json", "Invalid continuation window");
  const snapshotTurns = isRecord(replacement) && Array.isArray(replacement.replacement) ? replacement.replacement : [];
  for (const turn of [...session.turns, ...snapshotTurns]) {
    if (!isRecord(turn) || !Array.isArray(turn.content)) invalid("session.json", "Invalid turn content");
    for (const block of turn.content) {
      if (isRecord(block) && block.type === "attachment") {
        if (typeof block.path !== "string" || !names.has("source/" + block.path)) invalid("session.json", "Missing required attachment");
        attachments.add("source/" + block.path);
      }
    }
  }
  if (report.schemaVersion !== "1.0" || report.target !== target || report.outputKind !== "injection-bundle" ||
      report.nativeResume !== false || !isRecord(report.ledger)) invalid("report.json", "Unsupported or inconsistent conversion report");
  function count(items: JsonValue | undefined) {
    if (!Array.isArray(items) || items.some(i => !isRecord(i) || typeof i.code !== "string" || typeof i.path !== "string" || typeof i.reason !== "string")) {
      invalid("report.json", "Invalid loss ledger");
    }
    return items.length;
  }
  const losses = { dropped: count(report.ledger.dropped), downgraded: count(report.ledger.downgraded), approximated: count(report.ledger.approximated) };
  return { context, cwd: typeof session.meta.cwd === "string" ? session.meta.cwd : undefined, attachments: [...attachments], losses };
}
