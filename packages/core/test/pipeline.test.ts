import { describe, expect, it, vi } from "vitest";
import {
  AdapterRegistry, AdapterUnavailableError, convertSession, emptyLedger, mergeLedgers, validateFileSet,
  type CSR, type SessionAdapter,
} from "../src/index.js";

function adapter(overrides: Partial<SessionAdapter> = {}): SessionAdapter {
  return {
    id: "synthetic", displayName: "Synthetic", status: "ready", supportedVersions: ["test-v1"],
    capabilities: { import: true, export: true, nativeResume: false },
    detect: () => ({ confidence: 1 }),
    import: (artifacts) => ({
      session: {
        schemaVersion: "1.0", meta: { id: "test", agent: "synthetic", agentFormatVersion: "test-v1" },
        turns: [], xExtensions: { "x-unknown": { future: [1, "opaque"] } },
        raw: { unknownEvent: true }, sourceArtifacts: artifacts,
      }, ledger: emptyLedger(),
    }),
    export: (session) => ({ artifacts: session.sourceArtifacts ?? [], ledger: emptyLedger() }),
    ...overrides,
  };
}

describe("conversion pipeline", () => {
  it("passes binary multi-file artifacts and opaque extensions through the CSR hub", async () => {
    const files = [
      { path: "session/data.bin", bytes: new Uint8Array([0, 255, 128]) },
      { path: "index.json", bytes: new TextEncoder().encode('{"id":"test"}') },
    ];
    const target = adapter();
    const originalExport = target.export;
    target.export = vi.fn(originalExport);
    const result = await convertSession({ source: adapter(), target, artifacts: files });
    expect(result.artifacts).toEqual(files);
    expect(result.session.raw).toEqual({ unknownEvent: true });
    expect(result.session.xExtensions["x-unknown"]).toEqual({ future: [1, "opaque"] });
    expect(target.export).toHaveBeenCalledWith(result.session);
    expect(result.ledger).toEqual(emptyLedger());
  });

  it("merges every loss category across async import and export", async () => {
    const imported = await adapter().import([]);
    imported.ledger.dropped.push({ code: "DROP", path: "/a", reason: "unknown attachment" });
    imported.ledger.approximated.push({ code: "APPROX", path: "/b", reason: "estimated timestamp" });
    const outputLedger = emptyLedger();
    outputLedger.downgraded.push({ code: "DOWNGRADE", path: "/c", reason: "tool rendered as text" });
    const result = await convertSession({
      source: adapter({ import: async () => imported }),
      target: adapter({ export: async () => ({ artifacts: [], ledger: outputLedger }) }), artifacts: [],
    });
    expect(result.ledger).toEqual({
      dropped: imported.ledger.dropped,
      approximated: imported.ledger.approximated,
      downgraded: outputLedger.downgraded,
    });
    result.ledger.dropped[0]!.reason = "changed";
    expect(imported.ledger.dropped[0]!.reason).toBe("unknown attachment");
  });

  it("rejects unavailable capabilities before reading input", async () => {
    const source = adapter({ import: vi.fn() });
    const target = adapter({ capabilities: { import: false, export: false, nativeResume: false } });
    await expect(convertSession({ source, target, artifacts: [] })).rejects.toBeInstanceOf(AdapterUnavailableError);
    expect(source.import).not.toHaveBeenCalled();
    await expect(convertSession({ source: target, target: source, artifacts: [] })).rejects.toBeInstanceOf(AdapterUnavailableError);
  });

  it("propagates parse failures without calling export", async () => {
    const failure = new Error("Unknown format version");
    const target = adapter({ export: vi.fn() });
    await expect(convertSession({
      source: adapter({ import: () => { throw failure; } }), target, artifacts: [],
    })).rejects.toBe(failure);
    expect(target.export).not.toHaveBeenCalled();
  });

  it("rejects unsafe exported paths", async () => {
    await expect(convertSession({
      source: adapter(), artifacts: [], target: adapter({
        export: (_session: CSR) => ({ artifacts: [{ path: "../escape", bytes: new Uint8Array() }], ledger: emptyLedger() }),
      }),
    })).rejects.toThrow("relative paths");
  });
});

describe("registry and artifacts", () => {
  it("accepts third-party plugins without hardcoded agent IDs", () => {
    const plugin = adapter({ id: "community-example" });
    const registry = new AdapterRegistry().register(plugin);
    expect(registry.get("community-example")).toBe(plugin);
    expect(registry.list()).toEqual([plugin]);
    expect(() => registry.register(plugin)).toThrow("Duplicate");
    expect(() => registry.get("missing")).toThrow("Unknown");
    expect(() => registry.register(adapter({ id: "../invalid" }))).toThrow("Invalid");
  });

  it.each(["", "../escape", "/absolute", "C:/file", "a\\file", "a//file", "./file", "a/../file", "a\u0000b"])(
    "rejects unsafe portable artifact path %j", (path) => {
      expect(() => validateFileSet([{ path, bytes: new Uint8Array() }])).toThrow();
    },
  );

  it("rejects duplicate paths", () => {
    const file = { path: "same", bytes: new Uint8Array() };
    expect(() => validateFileSet([file, file])).toThrow("Duplicate");
  });

  it("does not share empty ledger arrays", () => {
    const first = emptyLedger();
    first.dropped.push({ code: "TEST", path: "/", reason: "test" });
    expect(emptyLedger().dropped).toEqual([]);
    expect(mergeLedgers()).toEqual(emptyLedger());
  });
});
