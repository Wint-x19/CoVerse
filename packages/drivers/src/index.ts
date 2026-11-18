import path from "node:path";
import { accessSync, constants } from "node:fs";
import { AgentDriver, driverError, type Executable } from "./driver.js";
import { codex } from "./codex.js";
import { claude } from "./claude.js";
import { antigravity } from "./antigravity.js";

export * from "./driver.js";

// Resolve before changing cwd. A source session can name a workspace containing its own executables.
function locate(command: string): Executable | null {
  const windows = process.platform === "win32";
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(dir => path.isAbsolute(dir));
  if (windows && command === "agy" && process.env.LOCALAPPDATA) directories.push(path.join(process.env.LOCALAPPDATA, "agy", "bin"));
  const name = windows ? command + ".exe" : command;
  for (const directory of directories) {
    const filename = path.join(directory, name);
    try { accessSync(filename, constants.X_OK); return { command: filename }; } catch { continue; }
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
    registry.register(new AgentDriver(plugin, overrides[plugin.id] ?? locate(plugin.command)));
  }
  return registry;
}
