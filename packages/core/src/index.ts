import type { FileSet, LossLedger, SessionAdapter } from "./types.js";
export type * from "./types.js";
export type * from "./protocol.js";
export * from "./session.js";

export function emptyLedger(): LossLedger {
  return { dropped: [], downgraded: [], approximated: [] };
}

export function mergeLedgers(...ledgers: readonly LossLedger[]): LossLedger {
  return {
    dropped: ledgers.flatMap((ledger) => ledger.dropped.map((item) => ({ ...item }))),
    downgraded: ledgers.flatMap((ledger) => ledger.downgraded.map((item) => ({ ...item }))),
    approximated: ledgers.flatMap((ledger) => ledger.approximated.map((item) => ({ ...item }))),
  };
}

export class AdapterUnavailableError extends Error {
  readonly code = "ADAPTER_UNAVAILABLE";
  constructor(id: string, operation: "import" | "export") {
    super(`Adapter ${id} does not support ${operation}; this capability is not implemented.`);
    this.name = "AdapterUnavailableError";
  }
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, SessionAdapter>();

  register(adapter: SessionAdapter): this {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(adapter.id)) {
      throw new Error("Invalid adapter ID");
    }
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate adapter: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string): SessionAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown adapter: ${id}`);
    return adapter;
  }

  list(): readonly SessionAdapter[] { return [...this.adapters.values()]; }
}

export function validateFileSet(files: FileSet): void {
  const paths = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
        /[\\:*?"<>|\u0000-\u001f]/.test(file.path)) {
      throw new Error("Artifact paths must be portable relative paths");
    }
    if (paths.has(file.path.toLowerCase())) throw new Error("Duplicate artifact path");
    paths.add(file.path.toLowerCase());
  }
  for (const value of paths) {
    const parts = value.split("/");
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join("/"))) throw new Error("Artifact file/directory path conflict");
  }
}

/** No filesystem writes, native-agent dependencies, or implicit loss filtering. */
export async function convertSession(input: {
  source: SessionAdapter;
  target: SessionAdapter;
  artifacts: FileSet;
}) {
  const { source, target, artifacts } = input;
  if (!source.capabilities.import) throw new AdapterUnavailableError(source.id, "import");
  if (!target.capabilities.export) throw new AdapterUnavailableError(target.id, "export");
  validateFileSet(artifacts);
  const imported = await source.import(artifacts);
  const exported = await target.export(imported.session, { ledger: imported.ledger, diagnostics: imported.diagnostics ?? [] });
  validateFileSet(exported.artifacts);
  return {
    session: imported.session,
    artifacts: exported.artifacts,
    ledger: mergeLedgers(imported.ledger, exported.ledger),
    diagnostics: [...(imported.diagnostics ?? []), ...(exported.diagnostics ?? [])],
  };
}
