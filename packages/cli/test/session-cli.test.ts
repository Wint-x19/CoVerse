import * as fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AdapterRegistry, sha256Bytes } from "@coverse/core";
import { runCli, createRegistry, type CliIO } from "../src/index.js";
import { runSessionCli } from "../src/session-cli.js";
import { createSandbox, removeSandbox, repositoryRoot } from "../../../tools/test-helpers.js";
let sandbox: string;
beforeEach(async () => { sandbox = await createSandbox(); });
afterEach(async () => { await removeSandbox(sandbox); });
const fixtures: Record<string, string> = {
  codex: "codex/rollout-2026-11-17/sample.jsonl",
  "claude-code": "claude-code/transcript-sdk-0_3_326/sample.jsonl",
  antigravity: "antigravity/sqlite-2_32_1-step0/sample.db",
};
const inputFor = (agent: string) => path.join(repositoryRoot, "fixtures", fixtures[agent]!);
function transport(signal?: AbortSignal) {
  const output: Uint8Array[] = [], errors: string[] = [];
  const io: CliIO = { stdin: (async function* () {})(), stdout: async bytes => { output.push(bytes); }, stderr: s => errors.push(s), ...(signal ? { signal } : {}) };
  return { io, errors, json: () => JSON.parse(Buffer.concat(output).toString("utf8")) };
}
const args = (source = "codex", target = "claude-code", input = inputFor(source), output = path.join(sandbox, "bundle")) => ["--from", source, "--to", target, "--input", input, "--output", output];
it.each(Object.keys(fixtures).flatMap(from => Object.keys(fixtures).map(to => [from, to])))("converts %s to %s through CSR with complete bundle verification", async (from, to) => {
  const t = transport(); expect(await runCli(["convert-session", ...args(from, to)], () => {}, t.io)).toBe(0);
  expect(t.errors).toEqual([]); expect(t.json()).toMatchObject({ from, to, nativeResume: false, statistics: { truncated: false } });
  const output = path.join(sandbox, "bundle");
  const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
  for (const file of manifest.files) expect(sha256Bytes(await fs.readFile(path.join(output, file.path)))).toBe(file.sha256);
  expect(await fs.readFile(path.join(output, "source", path.basename(inputFor(from))))).toEqual(await fs.readFile(inputFor(from)));
  const active = await fs.readFile(path.join(output, "context.md"), "utf8");
  expect(active).toContain(from === "antigravity" ? "The file was inspected" : "greeting");
  expect(await fs.readFile(path.join(output, "session.json"), "utf8")).toContain("greeting");
  expect((await fs.readdir(sandbox)).filter(n => n.startsWith(".coverse"))).toEqual([]);
});
it("auto detects native formats, including compressed Codex", async () => {
  const t = transport(); const input = inputFor("codex") + ".zst";
  expect(await runSessionCli(args("auto", "antigravity", input), createRegistry(), t.io)).toBe(0);
  expect(t.json().from).toBe("codex");
});
it("loads an explicit directory without flattening its relative artifact paths", async () => {
  const directory = path.join(sandbox, "input"); await fs.mkdir(path.join(directory, "nested"), { recursive: true });
  await fs.copyFile(inputFor("claude-code"), path.join(directory, "nested/session.jsonl"));
  expect(await runSessionCli(args("auto", "codex", directory), createRegistry(), transport().io)).toBe(0);
  expect(await fs.readFile(path.join(sandbox, "bundle/source/nested/session.jsonl"))).toEqual(await fs.readFile(inputFor("claude-code")));
});
it("refuses overwrite, output/input containment and ambiguous detection", async () => {
  const output = path.join(sandbox, "bundle"); await fs.mkdir(output); await fs.writeFile(path.join(output, "keep"), "original");
  expect(await runSessionCli(args(), createRegistry(), transport().io)).toBe(2);
  expect(await fs.readFile(path.join(output, "keep"), "utf8")).toBe("original");
  expect(await runSessionCli(args("codex", "claude-code", sandbox, path.join(sandbox, "new")), createRegistry(), transport().io)).toBe(2);
  const one = createRegistry().get("codex"); const registry = new AdapterRegistry().register(one).register({ ...one, id: "community-example" });
  expect(await runSessionCli(args("auto", "codex", inputFor("codex"), path.join(sandbox, "other")), registry, transport().io)).toBe(2);
});
it("reads SQLite WAL companions even when only the database is explicitly supplied", async () => {
  const input = path.join(sandbox, "sample.db"); await fs.copyFile(inputFor("antigravity"), input); await fs.writeFile(input + "-wal", "pending");
  expect(await runSessionCli(args("antigravity", "codex", input), createRegistry(), transport().io)).toBe(3);
  expect(await fs.readdir(sandbox)).not.toContain("bundle");
});
it("rejects input changes during reading without publishing anything", async () => {
  const input = path.join(sandbox, "changing.jsonl"); await fs.copyFile(inputFor("codex"), input);
  const open: typeof fs.open = async (filename, flags, mode) => {
    const handle = await fs.open(filename, flags, mode);
    return new Proxy(handle, { get(target, key) {
      if (key === "readFile") return async () => { const bytes = await target.readFile(); await fs.appendFile(input, "\n"); return bytes; };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  const t = transport(); expect(await runSessionCli(args("codex", "claude-code", input), createRegistry(), t.io, { open })).toBe(3);
  expect(t.errors.join()).toContain("UNSTABLE_INPUT"); expect(await fs.readdir(sandbox)).toEqual(["changing.jsonl"]);
});
it("cleans staging and partial publication after write or publish failures", async () => {
  for (const operation of ["writeFile", "rename"] as const) {
    const t = transport();
    const overrides = operation === "writeFile" ? { writeFile: async () => { throw new Error("simulated disk failure"); } } : { rename: async () => { throw new Error("simulated publish failure"); } };
    expect(await runSessionCli(args(), createRegistry(), t.io, overrides)).toBe(1);
    expect(await fs.readdir(sandbox)).toEqual([]);
  }
});
it("does not overwrite a directory created between conversion and publication", async () => {
  const output = path.join(sandbox, "bundle"); const target = createRegistry().get("claude-code");
  const registry = new AdapterRegistry().register(createRegistry().get("codex")).register({ ...target, export: async (session, context) => { await fs.mkdir(output); await fs.writeFile(path.join(output, "keep"), "racing writer"); return target.export(session, context); } });
  expect(await runSessionCli(args(), registry, transport().io)).toBe(1);
  expect(await fs.readFile(path.join(output, "keep"), "utf8")).toBe("racing writer");
});
it("reports cleanup errors as I/O failures rather than rejecting the CLI promise", async () => {
  const t = transport();
  expect(await runSessionCli(args(), createRegistry(), t.io, { writeFile: async () => { throw new Error("write failed"); }, rm: async () => { throw new Error("cleanup failed"); } })).toBe(1);
  expect(t.errors.join()).toContain("/cleanup");
  expect(await fs.readdir(sandbox)).not.toContain("bundle");
});
it("distinguishes bad arguments, missing files, unsupported input and cancellation", async () => {
  expect(await runSessionCli([], createRegistry(), transport().io)).toBe(2);
  expect(await runSessionCli(args("codex", "claude-code", path.join(sandbox, "absent")), createRegistry(), transport().io)).toBe(1);
  const input = path.join(sandbox, "unverified.jsonl"); await fs.writeFile(input, '{"type":"other"}\n');
  expect(await runSessionCli(args("codex", "claude-code", input), createRegistry(), transport().io)).toBe(3);
  const controller = new AbortController(); controller.abort();
  expect(await runSessionCli(args(), createRegistry(), transport(controller.signal).io)).toBe(3);
});
