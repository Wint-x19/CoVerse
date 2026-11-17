import { describe, expect, it } from "vitest";
import { AdapterUnavailableError, type CSR } from "@coverse/core";
import { createRegistry, runCli } from "../src/index.js";

describe("initial adapter scope", () => {
  it("registers only Codex, Claude Code and Antigravity", () => {
    expect(createRegistry().list().map(({ id }) => id)).toEqual(["codex", "claude-code", "antigravity"]);
  });

  it("declares verified import and injection capabilities separately from native resume", async () => {
    const session: CSR = {
      schemaVersion: "1.0", meta: { id: "test", agent: "test", agentFormatVersion: "test" },
      turns: [], xExtensions: {},
    };
    for (const adapter of createRegistry().list()) {
      if (adapter.status === "ready") {
        expect(adapter.supportedVersions.length).toBeGreaterThan(0);
        expect(adapter.capabilities.nativeResume).toBe(false);
        expect(adapter.capabilities.exportFormats).toContain("injection-bundle");
        expect(adapter.capabilities.importFormats?.length).toBeGreaterThan(0);
        continue;
      }
      expect(adapter.status).toBe("scaffold");
      expect(adapter.supportedVersions).toEqual([]);
      expect(adapter.capabilities).toEqual({ import: false, export: false, nativeResume: false });
      expect(await adapter.detect([])).toEqual({ confidence: 0 });
      expect(() => adapter.import([])).toThrow(AdapterUnavailableError);
      expect(() => adapter.export(session)).toThrow(AdapterUnavailableError);
    }
  });
});

describe("CLI", () => {
  it("returns a machine-readable capability inventory", async () => {
    const output: string[] = [];
    expect(await runCli(["adapters", "--json"], (line) => output.push(line))).toBe(0);
    expect(JSON.parse(output[0]!)).toHaveLength(3);
    expect(JSON.parse(output[0]!)[2].id).toBe("antigravity");
  });
  it.each([[], ["--help"], ["adapters"], ["doctor"]])("supports %j", async (...args) => {
    const output: string[] = [];
    expect(await runCli(args, (line) => output.push(line))).toBe(0);
    expect(output.length).toBe(1);
  });
  it.each([["adapters", "--typo"], ["doctor", "extra"]])("rejects unsupported command %j", async (...args) => {
    expect(await runCli(args, () => {})).toBe(2);
  });
});
