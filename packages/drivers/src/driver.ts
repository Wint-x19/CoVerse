import { spawn, execFile } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { isRecord, SessionError, type JsonValue, type ProtocolUsage } from "@coverse/core";

export interface RunOptions {
  cwd: string;
  prompt: string;
  session?: string;
  model?: string;
  attachmentDirectory?: string;
  signal?: AbortSignal;
}
export type DriverEvent =
  | { type: "session"; id: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; state: string }
  | { type: "usage"; usage: ProtocolUsage; nativeUsage: WireRecord }
  | { type: "done" };

export interface ModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface LocalSessionRef {
  id: string;
  agent: string;
  title: string;
  path: string;
  cwd?: string;
  updatedAt: string;
  size: number;
  active?: boolean;
}

export type WireRecord = Record<string, JsonValue>;
export type LocalSessionCache = ReadonlyMap<string, LocalSessionRef>;

export function unchangedSession(cache: LocalSessionCache | undefined, file: string, size: number, updatedAt: string) {
  const previous = cache?.get(file);
  return previous?.size === size && previous.updatedAt === updatedAt ? previous : undefined;
}

/** A disappearing entry is a normal scan result. Other I/O failures must preserve the last catalog. */
export function ignoreMissingEntry(error: unknown): void {
  if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
}

export interface DriverPlugin {
  id: string;
  command: string;
  verifiedVersions: readonly string[];
  /** Interactive target CLI arguments for an already materialized native session. */
  resumeArgs?(id: string): string[];
  invocation(options: RunOptions): { args: string[]; input: string };
  decoder(): (record: WireRecord) => DriverEvent[];
  listModels?(executable: Executable | null): Promise<ModelOption[]>;
  localSessionsRoot?(): string;
  listLocalSessions?(limit?: number, cache?: LocalSessionCache): Promise<LocalSessionRef[]>;
}
const sessionUuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export interface Executable { command: string; prefix?: readonly string[] }

export function driverError(message: string, code = "DRIVER_FAILED"): SessionError {
  return new SessionError(code, "/driver", message);
}
export function object(value: JsonValue | undefined): WireRecord {
  if (!isRecord(value)) throw driverError("Expected an object in the driver stream");
  return value;
}
export function string(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw driverError("Expected a string in the driver stream");
  return value;
}
export function usage(value: JsonValue | undefined): DriverEvent[] {
  if (value == null) return [];
  const nativeUsage = object(value);
  const counts: ProtocolUsage = {};
  const fields = {
    input: nativeUsage.input_tokens, output: nativeUsage.output_tokens,
    cachedInput: nativeUsage.cached_input_tokens ?? nativeUsage.cache_read_input_tokens ?? nativeUsage.cache_read_tokens,
    cacheWrite: nativeUsage.cache_creation_input_tokens ?? nativeUsage.cache_write_input_tokens,
    reasoning: nativeUsage.reasoning_output_tokens ?? nativeUsage.thinking_tokens,
  };
  for (const key of Object.keys(fields) as (keyof ProtocolUsage)[]) {
    const count = fields[key];
    if (typeof count === "number") counts[key] = count;
  }
  return [{ type: "usage", usage: counts, nativeUsage }];
}
/** Terminal summaries can contain a trailing fragment or repeat the last response in a tool loop. */
export function finalText(emitted: string, snapshot: JsonValue | undefined): DriverEvent[] {
  if (snapshot == null || snapshot === "") return [];
  const text = string(snapshot);
  if (emitted.endsWith(text)) return [];
  if (!text.startsWith(emitted)) throw driverError("Final answer differs from streamed text");
  return [{ type: "text", text: text.slice(emitted.length) }];
}

export function targetFailure(message: string): SessionError {
  if (/context.{0,20}(length|window|limit)|prompt.{0,20}too long|too many (input )?tokens/i.test(message)) {
    return driverError(message, "CONTEXT_LIMIT");
  }
  if (/insufficient.{0,16}quota|credit balance|billing limit/i.test(message)) return driverError(message, "QUOTA_EXHAUSTED");
  if (/authentication required|not logged in|not authenticated|please (log|sign) in/i.test(message)) return driverError(message, "AUTH_REQUIRED");
  return driverError(message);
}

export class AgentDriver {
  constructor(readonly plugin: DriverPlugin, readonly executable: Executable | null = { command: plugin.command }) {}
  get id() { return this.plugin.id; }

  async probe() {
    let version: string | null = null;
    try {
      if (!this.executable) throw driverError("Agent executable was not found");
      const result = await promisify(execFile)(this.executable.command, [...this.executable.prefix ?? [], "--version"], {
        timeout: 10000, windowsHide: true, maxBuffer: 64 * 1024,
      });
      version = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/)[0] || null;
    } catch { /* Discovery is local. Authentication is checked by the actual run. */ }
    return {
      id: this.id,
      available: version !== null,
      version,
      executablePath: this.executable?.command ?? null,
      verifiedVersions: this.plugin.verifiedVersions,
      verifiedCapabilities: version && this.plugin.verifiedVersions.includes(version) ? ["run", "inject", "resume"] : [],
    };
  }

  async listModels(): Promise<ModelOption[]> {
    if (!this.plugin.listModels) return [];
    try {
      return await this.plugin.listModels(this.executable);
    } catch {
      return [];
    }
  }

  async listLocalSessions(limit = 60, cache?: LocalSessionCache): Promise<LocalSessionRef[]> {
    return this.plugin.listLocalSessions?.(limit, cache) ?? [];
  }

  async *run(options: RunOptions): AsyncGenerator<DriverEvent> {
    const cancelled = () => driverError("Agent run cancelled", "CANCELLED");
    if (options.signal?.aborted) throw cancelled();
    if (options.session && !sessionUuid.test(options.session)) {
      throw driverError("Expected an explicit target session UUID", "CLI_ARGUMENT");
    }
    if (!this.executable) throw driverError(this.plugin.command + " executable was not found", "DRIVER_UNAVAILABLE");
    const { args, input } = this.plugin.invocation(options);
    const child = spawn(this.executable.command, [...this.executable.prefix ?? [], ...args], {
      cwd: options.cwd, stdio: "pipe", windowsHide: true, shell: false, detached: process.platform !== "win32",
    });
    // Resolve on close so buffered stdout is consumed and late nonzero exits invalidate success.
    let launchError: Error | undefined;
    child.on("error", error => { launchError = error; });
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));
    let killTimer: NodeJS.Timeout | undefined;
    let stopping = false;
    const stop = () => {
      const pid = child.pid;
      if (!pid || child.exitCode !== null || child.signalCode !== null || stopping) return;
      stopping = true;
      if (process.platform === "win32") {
        // Killing only the launcher leaves agents and inherited pipe handles running.
        const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
        execFile(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, error => {
          if (error && child.exitCode === null && child.signalCode === null) child.kill();
        });
        return;
      }
      const signalGroup = (signal: NodeJS.Signals) => {
        try { process.kill(-pid, signal); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
        }
      };
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), 1000).unref();
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    let diagnostics = "";
    child.stderr.setEncoding("utf8").on("data", (part: string) => { diagnostics = (diagnostics + part).slice(-4096); });
    let inputError: Error | undefined;
    child.stdin.on("error", error => { inputError = error; });
    child.stdin.end(input, "utf8");
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const decode = this.plugin.decoder();
    let session: string | undefined;
    let complete = false;
    let hasOutput = false;
    try {
      for await (const line of lines) {
        if (options.signal?.aborted) throw cancelled();
        if (!line.trim()) continue;
        let record: unknown;
        try { record = JSON.parse(line); } catch { throw driverError("Invalid JSON line in agent stdout"); }
        if (!isRecord(record)) throw driverError("Invalid agent event");
        for (const event of decode(record)) {
          if (complete) throw driverError("Agent emitted events after completion");
          if (event.type === "session") {
            if (!sessionUuid.test(event.id) || (session && event.id !== session) || (options.session && event.id !== options.session)) {
              throw driverError("Target returned an unexpected session ID: " + event.id, "SESSION_MISMATCH");
            }
            if (session) continue;
            session = event.id;
          }
          if (event.type === "tool" || (event.type === "text" && event.text.trim())) hasOutput = true;
          if (event.type === "done") complete = true;
          else yield event;
        }
      }
      const exitCode = await closed;
      if (options.signal?.aborted) throw cancelled();
      if (launchError) throw driverError(launchError.message, "DRIVER_UNAVAILABLE");
      if (exitCode !== 0) throw targetFailure(diagnostics.trim() || "Agent exited with status " + exitCode);
      if (inputError) throw driverError("Could not deliver the full prompt: " + inputError.message);
      if (!session || !complete) throw driverError("Agent exited without session ID or successful terminal event");
      if (!hasOutput) throw driverError("Agent completed without a visible answer or tool activity", "EMPTY_RESPONSE");
      yield { type: "done" };
    } finally {
      options.signal?.removeEventListener("abort", stop);
      lines.close();
      stop();
      await closed;
      clearTimeout(killTimer);
    }
  }
}
