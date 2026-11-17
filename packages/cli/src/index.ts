import { AdapterRegistry } from "@coverse/core";
import codex from "@coverse/adapter-codex";
import claudeCode from "@coverse/adapter-claude-code";
import antigravity from "@coverse/adapter-antigravity";

/** The composition root selects plugins; core has no vendor dependencies. */
export function createRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(codex).register(claudeCode).register(antigravity);
}

export function runCli(args: readonly string[], output: (text: string) => void): number {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) {
    output("CoVerse M0\nUsage: coverse adapters [--json]\n       coverse doctor\nNative session conversion is not implemented in M0.");
    return 0;
  }
  const registry = createRegistry();
  if (args[0] === "adapters" && (args.length === 1 || (args.length === 2 && args[1] === "--json"))) {
    const adapters = registry.list().map(({ id, displayName, status, supportedVersions, capabilities }) =>
      ({ id, displayName, status, supportedVersions, capabilities }));
    output(args[1] === "--json" ? JSON.stringify(adapters, null, 2) :
      adapters.map((adapter) => `${adapter.id}\t${adapter.status}\t${adapter.displayName}`).join("\n"));
    return 0;
  }
  if (args.length === 1 && args[0] === "doctor") {
    output(`CoVerse M0: workspace loaded; ${registry.list().length} adapter scaffolds registered.\nNative import/export/resume: not implemented. Run pnpm check to validate the scaffold.`);
    return 0;
  }
  output("Unknown command or option. Run coverse --help.");
  return 1;
}
