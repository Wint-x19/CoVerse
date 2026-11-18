import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionError, verifyInjectionBundle } from "@coverse/core";
import type { DriverRegistry } from "@coverse/drivers";
import type { CliIO } from "./protocol-cli.js";
import { loadInputs } from "./session-cli.js";

function argument(message: string): never { throw new SessionError("CLI_ARGUMENT", "/arguments", message); }
function parse(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (values.has(key)) argument("Duplicate option: " + key);
    if (key === "--json") { values.set(key, "true"); continue; }
    if (!["--agent", "--prompt", "--bundle", "--cwd", "--model", "--session"].includes(key)) argument("Unknown option: " + key);
    const value = args[++index];
    if (!value || value.startsWith("--") || value.includes("\0")) argument("Expected a value for " + key);
    values.set(key, value);
  }
  if (values.has("--bundle") && values.has("--session")) argument("Choose either --bundle or --session");
  return {
    agent: values.get("--agent") ?? argument("--agent is required"), prompt: values.get("--prompt") ?? argument("--prompt is required"),
    model: values.get("--model"), session: values.get("--session"), bundle: values.get("--bundle"), cwd: values.get("--cwd"), json: values.has("--json"),
  };
}
async function directory(name: string, message: string) {
  try { if ((await fs.stat(name)).isDirectory()) return await fs.realpath(name); } catch { /* use actionable diagnostic */ }
  return argument(message);
}
function sourceWorkspace(raw: string | undefined): string {
  let value = raw;
  if (value?.startsWith("file:")) {
    try {
      const url = new URL(value);
      if (process.platform !== "win32" && /^\/[a-z]:\//i.test(url.pathname)) throw Error();
      value = fileURLToPath(url);
    } catch { argument("Source workspace URI belongs to another platform or is invalid. Specify --cwd"); }
  }
  if (!value || !nativeAbsolute(value)) argument("Source workspace is missing or belongs to another platform. Specify --cwd");
  return value;
}
function nativeAbsolute(value: string): boolean {
  return process.platform === "win32" ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value) : path.isAbsolute(value);
}

export async function runAgentCli(args: readonly string[], drivers: DriverRegistry, io: CliIO): Promise<number> {
  let sessionId: string | undefined;
  const write = (text: string) => io.stdout(new TextEncoder().encode(text));
  try {
    const options = parse(args);
    const driver = drivers.get(options.agent);
    let prompt = options.prompt, workspace = options.cwd, attachmentDirectory: string | undefined;
    if (options.bundle) {
      const root = path.resolve(options.bundle);
      if (!(await fs.lstat(root)).isDirectory()) argument("--bundle must name a bundle directory");
      const files = await loadInputs([root], undefined, fs, io);
      const bundle = verifyInjectionBundle(files, driver.id);
      workspace ??= sourceWorkspace(bundle.cwd);
      let location = "";
      if (bundle.attachments.length) {
        attachmentDirectory = path.join(root, "source");
        location = "\nAttachment paths are relative to the bundle directory " + JSON.stringify(root) + ".\n";
      }
      prompt = bundle.context + location + "\n## Current user request\n\n" + options.prompt;
      const notice = { type: "bundle", report: path.join(root, "report.json"), losses: bundle.losses };
      if (options.json) await write(JSON.stringify(notice) + "\n");
      else io.stderr(JSON.stringify(notice));
    }
    const cwd = await directory(workspace ?? process.cwd(), "Workspace is unavailable. Specify --cwd with an existing directory");
    let endsWithNewline = true;
    for await (const event of driver.run({ prompt, cwd, ...(options.model && { model: options.model }),
      ...(options.session && { session: options.session }), ...(attachmentDirectory && { attachmentDirectory }), ...(io.signal && { signal: io.signal }) })) {
      if (event.type === "session") sessionId = event.id;
      if (options.json) await write(JSON.stringify(event) + "\n");
      else if (event.type === "text" && event.text) { await write(event.text); endsWithNewline = event.text.endsWith("\n"); }
      else if (event.type === "session") io.stderr(JSON.stringify(event));
    }
    if (!endsWithNewline) await write("\n");
    return 0;
  } catch (error) {
    const diagnostic = error instanceof SessionError ? error.diagnostic : { code: "IO_ERROR", path: "/run", severity: "error", message: error instanceof Error ? error.message : "Run failed" };
    io.stderr(JSON.stringify({ ...diagnostic, ...(sessionId && { sessionId }) }));
    return diagnostic.code === "IO_ERROR" ? 1 : ["CLI_ARGUMENT", "INVALID_INPUT"].includes(diagnostic.code) ? 2 : 3;
  }
}
