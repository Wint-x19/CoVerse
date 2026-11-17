import { AdapterRegistry } from "@coverse/core";
import codex from "@coverse/adapter-codex";
import claudeCode from "@coverse/adapter-claude-code";
import antigravity from "@coverse/adapter-antigravity";
import { createProtocolRegistry } from "@coverse/protocols";
import { defaultIO, runProtocolCli, type CliIO } from "./protocol-cli.js";
export type { CliIO } from "./protocol-cli.js";

/** The composition root selects plugins; core has no vendor dependencies. */
export function createRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(codex).register(claudeCode).register(antigravity);
}

export async function runCli(args: readonly string[], output: (text: string) => void, io: CliIO = defaultIO): Promise<number> {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) {
    output("CoVerse M1\nUsage: coverse adapters [--json]\n       coverse protocols [--json]\n       coverse doctor\n       coverse convert-protocol --from <protocol> --to <protocol> --kind request|response|stream [--input <file|->] [--output <file|->] [--report <file>]\nOptions: --policy strict|allow-loss --target-model <name> --max-output-tokens <n>\nExplicit loss policies: --allow-role-merge --reasoning-as-text --candidate-index <n> --omit <JSON-pointer> (repeatable)\nallow-loss requires --report. Defaults: stdin, stdout, strict.\nNative session conversion is not implemented.");
    return 0;
  }
  const registry = createRegistry();
  if (args[0] === "convert-protocol") return runProtocolCli(args.slice(1), io);
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
    output(`CoVerse M1: 3 protocol codecs available (requests, responses, SSE; verified subsets).\n${registry.list().length} session adapter scaffolds registered. Native import/export/resume: not implemented.\nRun pnpm check to validate the workspace.`);
    return 0;
  }
  output("Unknown command or option. Run coverse --help.");
  return 2;
}
