import path from "node:path";
import os from "node:os";
import { accessSync, constants, readdirSync } from "node:fs";
import { AgentDriver, driverError, type Executable } from "./driver.js";
import { codex } from "./codex.js";
import { claude } from "./claude.js";
import { antigravity } from "./antigravity.js";

export * from "./driver.js";

function isExecutableFile(filename: string): boolean {
  try {
    accessSync(filename, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function scanSubdirMatches(parent: string, prefix: string, relativeTail: readonly string[]): string[] {
  try {
    const entries = readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .reverse();
    return entries.map((entry) => path.join(parent, entry, ...relativeTail));
  } catch {
    return [];
  }
}

function extraCandidates(command: string): string[] {
  const windows = process.platform === "win32";
  const home = os.homedir();
  const results: string[] = [];

  if (windows) {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";

    if (command === "codex") {
      // Official Windows Store / Desktop Codex app resources
      results.push(...scanSubdirMatches(path.join(programFiles, "WindowsApps"), "OpenAI.Codex_", ["app", "resources", "codex.exe"]));
      // Official OpenAI VS Code extension bundled codex binary
      results.push(...scanSubdirMatches(path.join(home, ".vscode", "extensions"), "openai.chatgpt-", ["bin", "windows-x86_64", "codex.exe"]));
      // Codex local plugin / sandbox binaries
      results.push(path.join(home, ".codex", "plugins", ".plugin-appserver", "codex.exe"));
      results.push(path.join(home, ".codex", ".sandbox-bin", "codex.exe"));
    } else if (command === "agy") {
      if (localAppData) results.push(path.join(localAppData, "agy", "bin", "agy.exe"));
    } else if (command === "claude") {
      if (localAppData) {
        results.push(...scanSubdirMatches(path.join(localAppData, "Microsoft", "WinGet", "Packages"), "Anthropic.ClaudeCode_", ["claude.exe"]));
      }
      results.push(path.join(home, ".local", "bin", "claude.exe"));
    }
  } else {
    results.push(path.join(home, ".local", "bin", command));
    results.push(path.join("/opt/homebrew/bin", command));
    results.push(path.join("/usr/local/bin", command));
    if (command === "codex") {
      const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
      const platform = process.platform === "darwin" ? `macos-${arch}` : `linux-${arch}`;
      results.push(...scanSubdirMatches(path.join(home, ".vscode", "extensions"), "openai.chatgpt-", ["bin", platform, "codex"]));
    }
  }
  return results;
}

// Resolve before changing cwd. A source session can name a workspace containing its own executables.
export function locateExecutable(command: string): Executable | null {
  const windows = process.platform === "win32";
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  const nativeName = windows ? command + ".exe" : command;

  for (const directory of directories) {
    const filename = path.join(directory, nativeName);
    if (isExecutableFile(filename)) return { command: filename };
  }

  for (const candidate of extraCandidates(command)) {
    if (isExecutableFile(candidate)) return { command: candidate };
  }

  if (windows) {
    for (const directory of directories) {
      const cmdFile = path.join(directory, command + ".cmd");
      if (isExecutableFile(cmdFile)) {
        return { command: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", cmdFile] };
      }
    }
  }
  return null;
}

export class DriverRegistry {
  private readonly drivers = new Map<string, AgentDriver>();
  register(driver: AgentDriver): this {
    if (this.drivers.has(driver.id)) throw Error("Duplicate driver: " + driver.id);
    this.drivers.set(driver.id, driver);
    return this;
  }
  get(id: string): AgentDriver {
    const driver = this.drivers.get(id);
    if (!driver) throw driverError("Unknown agent: " + id, "CLI_ARGUMENT");
    return driver;
  }
  list() { return [...this.drivers.values()]; }
}

export function createDriverRegistry(overrides: Readonly<Record<string, Executable>> = {}) {
  const registry = new DriverRegistry();
  for (const plugin of [codex, claude, antigravity]) {
    registry.register(new AgentDriver(plugin, overrides[plugin.id] ?? locateExecutable(plugin.command)));
  }
  return registry;
}
