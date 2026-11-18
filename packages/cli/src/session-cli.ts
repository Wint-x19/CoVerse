import * as fs from "node:fs/promises";
import path from "node:path";
import { AdapterRegistry, AdapterUnavailableError, convertSession, verifyInjectionBundle, SessionError, validateFileSet, type FileSet, type SessionAdapter } from "@coverse/core";
import type { CliIO } from "./protocol-cli.js";

type FileIO = Pick<typeof fs, "lstat" | "realpath" | "readdir" | "open" | "mkdir" | "mkdtemp" | "writeFile" | "rename" | "rm">;
const fail = (message: string): never => { throw new SessionError("CLI_ARGUMENT", "/arguments", message); };
function parse(args: readonly string[], registry: AdapterRegistry) {
  const values = new Map<string, string>(); const inputs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!["--from", "--to", "--input", "--output"].includes(key)) fail(`Unknown option: ${key}`);
    if (values.has(key)) fail(`Duplicate option: ${key}`);
    const value = args[++i]; if (!value || value.startsWith("--") || value === "-") fail(`Expected a value for ${key}; session conversion uses files and directories`);
    if (key === "--input") inputs.push(value!); else values.set(key, value!);
  }
  const from = values.get("--from") ?? fail("--from is required"), to = values.get("--to") ?? fail("--to is required");
  const output = values.get("--output") ?? fail("--output is required");
  if (!inputs.length) fail("At least one --input is required");
  const get = (id: string) => { try { return registry.get(id); } catch { return fail(`Unknown adapter: ${id}`); } };
  return { inputs, output: path.resolve(output), source: from === "auto" ? undefined : get(from), target: get(to) };
}
const codeIs = (error: unknown, code: string) => error !== null && typeof error === "object" && "code" in error && error.code === code;
async function exists(fileIO: FileIO, filename: string) {
  try { return await fileIO.lstat(filename); } catch (error) { if (codeIs(error, "ENOENT")) return undefined; throw error; }
}
function unchanged(a: Awaited<ReturnType<typeof fs.lstat>>, b: Awaited<ReturnType<typeof fs.lstat>>) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function cancelled(io: CliIO) { if (io.signal?.aborted) throw new SessionError("CANCELLED", "/conversion", "Conversion cancelled"); }

export async function loadInputs(inputs: readonly string[], output: string | undefined, fileIO: FileIO, io: CliIO): Promise<FileSet> {
  async function inventory() {
    const found: { absolute: string; relative: string }[] = [];
    const seen = new Set<string>();
    async function add(absolute: string, relative: string): Promise<void> {
      const info = await fileIO.lstat(absolute);
      if (info.isSymbolicLink()) throw new SessionError("INVALID_INPUT", relative, "Symlink inputs are not stable snapshots");
      if (info.isDirectory()) {
        const relation = output === undefined ? undefined : path.relative(absolute, output);
        if (relation !== undefined && (!relation || !relation.startsWith("..") && !path.isAbsolute(relation))) fail("Output must not be inside an input directory");
        for (const entry of (await fileIO.readdir(absolute)).sort()) await add(path.join(absolute, entry), relative ? `${relative}/${entry}` : entry);
      } else if (info.isFile()) {
        const real = await fileIO.realpath(absolute), key = process.platform === "win32" ? real.toLowerCase() : real;
        if (seen.has(key)) fail("An input file was supplied more than once");
        seen.add(key); found.push({ absolute, relative });
      } else throw new SessionError("INVALID_INPUT", relative, "Input must contain only regular files");
    }
    for (const input of inputs) {
      const absolute = path.resolve(input), info = await fileIO.lstat(absolute);
      await add(absolute, info.isDirectory() ? "" : path.basename(absolute));
      // SQLite journals are required snapshot companions, not independent sessions.
      if (info.isFile() && absolute.endsWith(".db")) for (const suffix of ["-wal", "-shm", "-journal"]) {
        const companion = absolute + suffix;
        if (await exists(fileIO, companion)) {
          const real = await fileIO.realpath(companion), key = process.platform === "win32" ? real.toLowerCase() : real;
          if (!seen.has(key)) await add(companion, path.basename(companion));
        }
      }
    }
    return found;
  }
  const inventoryBefore = await inventory();
  if (!inventoryBefore.length) throw new SessionError("INVALID_INPUT", "/input", "No input files");
  const before = await Promise.all(inventoryBefore.map(f => fileIO.lstat(f.absolute)));
  const files: { path: string; bytes: Uint8Array }[] = [];
  for (const [i, file] of inventoryBefore.entries()) {
    cancelled(io);
    const handle = await fileIO.open(file.absolute, "r");
    try {
      if (!unchanged(before[i]!, await handle.stat())) throw new SessionError("UNSTABLE_INPUT", file.relative, "Input changed before reading");
      files.push({ path: file.relative, bytes: await handle.readFile() });
      if (!unchanged(before[i]!, await handle.stat())) throw new SessionError("UNSTABLE_INPUT", file.relative, "Input changed while reading");
    } finally { await handle.close(); }
  }
  const inventoryAfter = await inventory();
  if (JSON.stringify(inventoryBefore) !== JSON.stringify(inventoryAfter)) throw new SessionError("UNSTABLE_INPUT", "/input", "Input file set changed while reading");
  for (const [i, file] of inventoryBefore.entries()) if (!unchanged(before[i]!, await fileIO.lstat(file.absolute))) throw new SessionError("UNSTABLE_INPUT", file.relative, "Input changed while capturing the file set");
  try { validateFileSet(files); } catch { throw new SessionError("INVALID_INPUT", "/input", "Input paths collide or are not portable; supply a directory to preserve relative paths"); }
  return files;
}
async function detect(registry: AdapterRegistry, files: FileSet): Promise<SessionAdapter> {
  const candidates = await Promise.all(registry.list().filter(a => a.capabilities.import).map(async adapter => ({ adapter, result: await adapter.detect(files) })));
  if (candidates.some(c => !Number.isFinite(c.result.confidence) || c.result.confidence < 0 || c.result.confidence > 1)) throw new SessionError("INVALID_BUNDLE", "/detection", "Plugin returned an invalid detection confidence");
  candidates.sort((a, b) => b.result.confidence - a.result.confidence);
  const first = candidates[0];
  if (!first || first.result.confidence < 0.9) throw new SessionError("UNSUPPORTED_FORMAT", "/input", "No verified source format detected; specify --from to obtain format-specific diagnostics");
  if (candidates[1]?.result.confidence === first.result.confidence) throw new SessionError("AMBIGUOUS_INPUT", "/input", "Multiple adapters match; specify --from explicitly");
  return first.adapter;
}

/** Filesystem injection is also useful to embedders; default implementation performs no native-agent writes. */
export async function runSessionCli(args: readonly string[], registry: AdapterRegistry, io: CliIO, overrides: Partial<FileIO> = {}): Promise<number> {
  const fileIO: FileIO = { ...fs, ...overrides };
  let staging: string | undefined, destination: string | undefined, owned: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  let committed = false;
  try {
    const parsed = parse(args, registry); destination = parsed.output; cancelled(io);
    if (await exists(fileIO, destination)) fail("Output directory already exists; choose a new directory");
    const parent = await fileIO.realpath(path.dirname(destination));
    destination = path.join(parent, path.basename(destination));
    const files = await loadInputs(parsed.inputs, destination, fileIO, io);
    const source = parsed.source ?? await detect(registry, files);
    const result = await convertSession({ source, target: parsed.target, artifacts: files });
    verifyInjectionBundle(result.artifacts, parsed.target.id); cancelled(io);
    staging = await fileIO.mkdtemp(path.join(parent, ".coverse-session-"));
    for (const artifact of result.artifacts) {
      cancelled(io);
      const output = path.join(staging, ...artifact.path.split("/"));
      await fileIO.mkdir(path.dirname(output), { recursive: true });
      await fileIO.writeFile(output, artifact.bytes, { flag: "wx", mode: 0o600 });
    }
    // Exclusive reservation prevents overwriting even an empty directory created by another writer.
    await fileIO.mkdir(destination); owned = await fileIO.lstat(destination);
    const entries = (await fileIO.readdir(staging)).filter(n => n !== "manifest.json");
    for (const entry of [...entries, "manifest.json"]) {
      cancelled(io); await fileIO.rename(path.join(staging, entry), path.join(destination, entry));
    }
    committed = true;
    const report = JSON.parse(new TextDecoder().decode(result.artifacts.find(f => f.path === "report.json")!.bytes));
    await io.stdout(new TextEncoder().encode(JSON.stringify({ status: "completed", from: source.id, to: parsed.target.id, output: destination, nativeResume: false, statistics: report.statistics, losses: Object.fromEntries(Object.entries(result.ledger).map(([key, items]) => [key, items.length])) }) + "\n"));
    return 0;
  } catch (error) {
    const diagnostic = error instanceof SessionError ? error.diagnostic : { code: error instanceof AdapterUnavailableError ? error.code : "IO_ERROR", path: "/conversion", severity: "error", message: error instanceof Error ? error.message : "Conversion failed" };
    io.stderr(JSON.stringify(diagnostic));
    if (error instanceof AdapterUnavailableError) return 3;
    if (error instanceof SessionError) return ["CLI_ARGUMENT", "INVALID_INPUT", "AMBIGUOUS_INPUT"].includes(error.code) ? 2 : 3;
    return 1;
  } finally {
    const failures: string[] = [];
    try {
      if (!committed && destination && owned) {
        const current = await exists(fileIO, destination);
        if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await fileIO.rm(destination, { recursive: true, force: true });
      }
    } catch { failures.push("Could not remove the incomplete output directory"); }
    try { if (staging) await fileIO.rm(staging, { recursive: true, force: true }); }
    catch { failures.push("Could not remove the staging directory"); }
    if (failures.length) {
      io.stderr(JSON.stringify({ code: "IO_ERROR", path: "/cleanup", severity: "error", message: failures.join("; ") }));
      return 1;
    }
  }
}
