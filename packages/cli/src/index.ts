import { createDriverRegistry, type DriverRegistry } from "@coverse/drivers";
import { runAgentCli } from "./run-cli.js";
import { AdapterRegistry } from "@coverse/core";
import codex from "@coverse/adapter-codex";
import claudeCode from "@coverse/adapter-claude-code";
import antigravity from "@coverse/adapter-antigravity";
import { createProtocolRegistry } from "@coverse/protocols";
import { defaultIO, runProtocolCli, type CliIO } from "./protocol-cli.js";
import { runSessionCli } from "./session-cli.js";
export type { CliIO } from "./protocol-cli.js";

/** The composition root selects plugins; core has no vendor dependencies. */
export function createRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(codex).register(claudeCode).register(antigravity);
}

export async function runCli(args: readonly string[], output: (text: string) => void, io: CliIO = defaultIO, drivers?: DriverRegistry): Promise<number> {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) {
    output("CoVerse M3\nUsage: coverse drivers [--json]\n       coverse run --agent <agent> --prompt <text> [--model <name>] [--cwd <dir>] [--bundle <dir> | --session <id>] [--json]\n       coverse adapters [--json]\n       coverse protocols [--json]\n       coverse doctor\n       coverse convert-session --from <agent|auto> --to <agent> --input <file-or-directory> --output <new-directory>\nSession input is repeatable. Output is a complete injection bundle with CSR, original artifacts and loss report; no summarization or truncation.\n       coverse convert-protocol --from <protocol> --to <protocol> --kind request|response|stream [--input <file|->] [--output <file|->] [--report <file>]\nProtocol options: --policy strict|allow-loss --target-model <name> --max-output-tokens <n>\nExplicit protocol loss policies: --allow-role-merge --reasoning-as-text --candidate-index <n> --omit <JSON-pointer> (repeatable)\nProtocol allow-loss requires --report. Defaults: stdin, stdout, strict.\nNative session synthesis/resume is not implemented.");
    return 0;
  }
  if (args[0] === "run") return runAgentCli(args.slice(1), drivers ?? createDriverRegistry(), io);
  if (args[0] === "drivers" && (args.length === 1 || args.length === 2 && args[1] === "--json")) {
    const inventory = await Promise.all((drivers ?? createDriverRegistry()).list().map(driver => driver.probe()));
    output(args[1] === "--json" ? JSON.stringify(inventory, null, 2) :
      inventory.map(d => d.id + "\t" + (d.version ?? "unavailable") + "\t" + d.verifiedCapabilities.join(",")).join("\n"));
    return 0;
  }
  const registry = createRegistry();
  if (args[0] === "convert-protocol") return runProtocolCli(args.slice(1), io);
  if (args[0] === "convert-session") return runSessionCli(args.slice(1), registry, io);
  if (args[0] === "protocols" && (args.length === 1 || args.length === 2 && args[1] === "--json")) {
    const protocols = createProtocolRegistry().list().map(({ id, baseline, capabilities }) => ({ id, baseline, capabilities }));
    output(args[1] === "--json" ? JSON.stringify(protocols, null, 2) : protocols.map(p => `${p.id}\t${p.baseline}\t${p.capabilities.join(",")}`).join("\n")); return 0;
  }
  if (args[0] === "adapters" && (args.length === 1 || (args.length === 2 && args[1] === "--json"))) {
    const adapters = registry.list().map(({ id, displayName, status, supportedVersions, capabilities }) =>
      ({ id, displayName, status, supportedVersions, capabilities }));
    output(args[1] === "--json" ? JSON.stringify(adapters, null, 2) :
      adapters.map((adapter) => `${adapter.id}\t${adapter.status}\t${adapter.displayName}`).join("\n"));
    return 0;
  }
  if (args.length === 1 && args[0] === "doctor") {
    output(`CoVerse M3: 3 protocol codecs available (requests, responses, SSE; verified subsets).\n${registry.list().filter(a => a.capabilities.import).length} session import adapters; ${registry.list().filter(a => a.capabilities.export).length} injection-bundle exporters. Verified format subsets only; inspect adapters --json and plugin READMEs.\nNative session synthesis/resume: not implemented.\nRun coverse drivers --json to inspect the installed agent CLIs. Run pnpm check to validate the workspace.`);
    return 0;
  }
  output("Unknown command or option. Run coverse --help.");
  return 2;
}
