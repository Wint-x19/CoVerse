import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { isRecord, SessionError, type JsonValue } from "@coverse/core";

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
  | { type: "usage"; usage: Record<string, JsonValue> }
  | { type: "done" };

export type WireRecord = Record<string, JsonValue>;
export interface DriverPlugin {
  id: string;
  command: string;
  verifiedVersions: readonly string[];
  invocation(options: RunOptions): { args: string[]; input: string };
  decoder(): (record: WireRecord) => DriverEvent[];
}
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
  return value == null ? [] : [{ type: "usage", usage: object(value) }];
}
export function targetFailure(message: string): SessionError {
  if (/context.{0,20}(length|window|limit)|prompt.{0,20}too long|too many (input )?tokens/i.test(message)) {
    return driverError(message, "CONTEXT_LIMIT");
  }
  return driverError(message);
}

export class AgentDriver {
  constructor(readonly plugin: DriverPlugin, readonly executable: Executable = { command: plugin.command }) {}
  get id() { return this.plugin.id; }

  async probe() {
    let version: string | null = null;
    try {
      const result = await promisify(execFile)(this.executable.command, [...this.executable.prefix ?? [], "--version"], {
        timeout: 10000, windowsHide: true, maxBuffer: 64 * 1024,
      });
      version = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/)[0] || null;
    } catch { /* Discovery is local. Authentication is checked by the actual run. */ }
    return { id: this.id, available: version !== null, version, verifiedVersions: this.plugin.verifiedVersions,
      verifiedCapabilities: version && this.plugin.verifiedVersions.includes(version) ? ["run", "inject", "resume"] : [] };
  }

  async *run(options: RunOptions): AsyncGenerator<DriverEvent> {
    const cancelled = () => driverError("Agent run cancelled", "CANCELLED");
    if (options.signal?.aborted) throw cancelled();
    if (options.session && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(options.session)) {
      throw driverError("Expected an explicit target session UUID", "CLI_ARGUMENT");
    }
    const { args, input } = this.plugin.invocation(options);
    const child = spawn(this.executable.command, [...this.executable.prefix ?? [], ...args], {
      cwd: options.cwd, stdio: "pipe", windowsHide: true, shell: false,
    });
    // Resolve on close so buffered stdout is consumed and late nonzero exits invalidate success.
    let launchError: Error | undefined;
    child.on("error", error => { launchError = error; });
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        child.kill();
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000).unref();
      }
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
            if (!event.id || (session && event.id !== session) || (options.session && event.id !== options.session)) {
              throw driverError("Target returned an unexpected session ID: " + event.id, "SESSION_MISMATCH");
            }
            if (session) continue;
            session = event.id;
          }
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
