import { open, rename, unlink, stat, realpath, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { emptyLedger } from "@coverse/core";
import { convertRequest, convertResponse, convertStream, createProtocolRegistry, ProtocolError, type ConversionOptions, type ConversionReport } from "@coverse/protocols";

export interface CliIO {
  stdin: AsyncIterable<Uint8Array>;
  stdout(chunk: Uint8Array): Promise<void>;
  stderr(text: string): void;
  signal?: AbortSignal;
}
export const defaultIO: CliIO = {
  stdin: process.stdin,
  stdout: chunk => new Promise((resolve, reject) => { process.stdout.write(chunk, error => error ? reject(error) : resolve()); }),
  stderr: text => { process.stderr.write(text + "\n"); },
};
const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(JSON.stringify(value, null, 2) + "\n");
interface Arguments { from: string; to: string; kind: "request" | "response" | "stream"; input: string; output: string; report?: string; options: ConversionOptions }
function parse(args: readonly string[]): Arguments {
  const flags = new Set(["--allow-role-merge", "--reasoning-as-text"]);
  const values = new Set(["--from", "--to", "--kind", "--input", "--output", "--report", "--policy", "--target-model", "--max-output-tokens", "--candidate-index", "--omit"]);
  const found = new Map<string, string>(); const omit: string[] = [];
  const fail = (message: string): never => { throw new ProtocolError("CLI_ARGUMENT", "/arguments", message); };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!flags.has(arg) && !values.has(arg)) fail(`Unknown option: ${arg}`);
    if (found.has(arg) && arg !== "--omit") fail(`Duplicate option: ${arg}`);
    if (flags.has(arg)) found.set(arg, "true");
    else {
      const value = args[++i] ?? fail(`Missing value: ${arg}`); if (value.startsWith("--") || !value) fail(`Missing value: ${arg}`);
      if (arg === "--omit") { if (!value.startsWith("/")) fail("--omit requires an exact JSON pointer"); omit.push(value); }
      else found.set(arg, value);
    }
  }
  const from = found.get("--from") ?? fail("--from is required"); const to = found.get("--to") ?? fail("--to is required");
  const registry = createProtocolRegistry(); registry.get(from); registry.get(to);
  const kind = found.get("--kind"); if (kind !== "request" && kind !== "response" && kind !== "stream") fail("--kind must be request, response, or stream");
  const policy = found.get("--policy") ?? "strict"; if (policy !== "strict" && policy !== "allow-loss") fail("Invalid --policy");
  const report = found.get("--report"); if (report === "-") fail("--report must be a file so stdout remains protocol-only");
  if (policy === "allow-loss" && !report) fail("--policy allow-loss requires --report");
  if (policy === "strict" && (omit.length || found.has("--allow-role-merge") || found.has("--reasoning-as-text") || found.has("--candidate-index"))) fail("Explicit degradation options require --policy allow-loss");
  const numeric = (key: string, minimum: number): number | undefined => {
    const value = found.get(key); if (value === undefined) return;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) fail(`Invalid integer for ${key}`); return Number(value);
  };
  const maxOutputTokens = numeric("--max-output-tokens", 1); const candidateIndex = numeric("--candidate-index", 0);
  if (kind !== "request" && (maxOutputTokens !== undefined || found.has("--allow-role-merge"))) fail("Output budget and role merge apply only to requests");
  if (kind === "request" && candidateIndex !== undefined) fail("Candidate selection applies only to responses and streams");
  return { from, to, kind: kind as Arguments["kind"], input: found.get("--input") ?? "-", output: found.get("--output") ?? "-", ...(report ? { report } : {}), options: {
    policy: policy as "strict" | "allow-loss", ...(found.has("--target-model") ? { targetModel: found.get("--target-model")! } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}), ...(candidateIndex !== undefined ? { candidateIndex } : {}),
    ...(found.has("--allow-role-merge") ? { allowRoleMerge: true } : {}), ...(found.has("--reasoning-as-text") ? { reasoningAsText: true } : {}), ...(omit.length ? { omit } : {}),
  } };
}
async function distinctPaths(args: Arguments): Promise<void> {
  const files = [args.input, args.output, args.report].filter((p): p is string => p !== undefined && p !== "-");
  const identities: { name: string; real: string; dev?: number; ino?: number }[] = [];
  for (const file of files) {
    const absolute = path.resolve(file); const name = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    let identity: (typeof identities)[number] = { name, real: name };
    try { const info = await stat(absolute); identity = { name, real: await realpath(absolute), dev: info.dev, ino: info.ino }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (identities.some(v => v.name === identity.name || v.real === identity.real || identity.ino !== undefined && identity.ino !== 0 && v.dev === identity.dev && v.ino === identity.ino)) throw new ProtocolError("CLI_ARGUMENT", "/paths", "Input, output, and report must be different files");
    identities.push(identity);
  }
}
/** Same-directory staging: a failed conversion never replaces an existing output. */
class AtomicFile {
  private constructor(readonly destination: string, readonly temporary: string, private handle: FileHandle | undefined) {}
  static async create(destination: string): Promise<AtomicFile> {
    const absolute = path.resolve(destination); const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.tmp`);
    return new AtomicFile(absolute, temporary, await open(temporary, "wx", 0o600));
  }
  async write(data: Uint8Array): Promise<void> { await this.handle!.writeFile(data); }
  async publish(): Promise<void> { await this.handle!.sync(); await this.handle!.close(); this.handle = undefined; await rename(this.temporary, this.destination); }
  async discard(): Promise<void> { await this.handle?.close(); this.handle = undefined; await unlink(this.temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}
async function writeReport(filename: string, value: unknown): Promise<void> {
  const file = await AtomicFile.create(filename);
  try { await file.write(json(value)); await file.publish(); } finally { await file.discard(); }
}
export async function runProtocolCli(args: readonly string[], io: CliIO = defaultIO): Promise<number> {
  let parsed: Arguments | undefined; let safeReport = false; let output: AtomicFile | undefined; let inputHandle: FileHandle | undefined;
  let report: ConversionReport = { ledger: emptyLedger(), preserved: [] };
  try {
    parsed = parse(args); await distinctPaths(parsed); safeReport = true;
    const input = parsed.input === "-" ? io.stdin : (inputHandle = await open(parsed.input, "r")).createReadStream({ autoClose: false });
    const options = { ...parsed.options, ...(io.signal ? { signal: io.signal } : {}) };
    const write = async (bytes: Uint8Array) => { if (output) await output.write(bytes); else await io.stdout(bytes); };
    if (parsed.kind === "stream") {
      async function* read(): AsyncGenerator<Uint8Array> {
        try { yield* input; } catch (error) { throw new ProtocolError("IO_ERROR", "/input", error instanceof Error ? error.message : "Input read failed"); }
      }
      const conversion = convertStream({ from: parsed.from, to: parsed.to, input: read(), options }); report = conversion.report;
      if (parsed.output !== "-") output = await AtomicFile.create(parsed.output);
      for await (const bytes of conversion.data) await write(bytes);
      const completed = await conversion.completion; if (completed.status !== "completed") throw completed.error ?? new ProtocolError("CANCELLED", "/stream", "Conversion cancelled", report);
    } else {
      const decoder = new TextDecoder("utf-8", { fatal: true }); let text = "";
      try { for await (const bytes of input) text += decoder.decode(bytes, { stream: true }); text += decoder.decode(); }
      catch (error) { if (error instanceof TypeError) throw new ProtocolError("INVALID_INPUT", "/input", "Invalid UTF-8 input"); throw error; }
      let value: unknown; try { value = JSON.parse(text); } catch { throw new ProtocolError("INVALID_INPUT", "/input", "Input must be valid JSON"); }
      const conversion = (parsed.kind === "request" ? convertRequest : convertResponse)({ from: parsed.from, to: parsed.to, input: value, options });
      report = { ledger: conversion.ledger, preserved: conversion.preserved };
      if (parsed.output !== "-") output = await AtomicFile.create(parsed.output);
      await write(json(conversion.data));
    }
    if (parsed.report) await writeReport(parsed.report, { status: "completed", from: parsed.from, to: parsed.to, kind: parsed.kind, ...report });
    await output?.publish(); return 0;
  } catch (error) {
    const protocol = error instanceof ProtocolError ? error : undefined;
    if (protocol && (protocol.report.preserved.length || Object.values(protocol.report.ledger).some(v => v.length))) report = protocol.report;
    const detail = { code: protocol?.code ?? "IO_ERROR", path: protocol?.path ?? "/", message: error instanceof Error ? error.message : "Conversion failed" };
    io.stderr(JSON.stringify(detail));
    if (safeReport && parsed?.report) {
      try { await writeReport(parsed.report, { status: "failed", from: parsed.from, to: parsed.to, kind: parsed.kind, error: detail, ...report }); }
      catch (reportError) { io.stderr(JSON.stringify({ code: "IO_ERROR", message: `Cannot write report: ${String(reportError)}` })); return 1; }
    }
    if (!protocol || protocol.code === "IO_ERROR") return 1;
    if (["CLI_ARGUMENT", "UNKNOWN_PROTOCOL"].includes(protocol.code) || parsed?.kind !== "stream" && ["INVALID_INPUT", "INVALID_ARGUMENTS", "INVALID_TOOL_LINK"].includes(protocol.code)) return 2;
    return 3;
  } finally {
    await inputHandle?.close().catch(() => {});
    await output?.discard();
  }
}
