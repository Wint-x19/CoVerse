import path from "node:path";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDriverRegistry } from "@coverse/drivers";
import { runCli } from "../src/index.js";
import { createSandbox, removeSandbox, repositoryRoot } from "../../../tools/test-helpers.js";

const fixtures = { codex: "codex/rollout-2026-11-17/sample.jsonl", "claude-code": "claude-code/transcript-sdk-0_3_326/sample.jsonl", antigravity: "antigravity/sqlite-2_32_1-step0/sample.db" };
const drivers = createDriverRegistry(Object.fromEntries(Object.keys(fixtures).map(agent => [agent, { command: process.execPath,
  prefix: [path.join(repositoryRoot, "packages/cli/test/fake-agent.mjs"), agent] }])));
let cwd: string;
beforeEach(async () => { cwd = await createSandbox(); });
afterEach(async () => { await removeSandbox(cwd); });
async function cli(args: string[]) {
  let out = "";
  const err: string[] = [];
  const status = await runCli(args, s => { out += s; }, { stdin: (async function* () {})(), stderr: s => err.push(s),
    stdout: async b => { out += Buffer.from(b).toString(); } }, drivers);
  return { out, err, status };
}
async function convert(source: string, target: string) {
  const bundle = path.join(cwd, "bundle");
  const result = await cli(["convert-session", "--from", "auto", "--to", target, "--input", path.join(repositoryRoot, "fixtures", source), "--output", bundle]);
  expect(result.status).toBe(0);
  return bundle;
}
const received = async () => JSON.parse(await readFile(path.join(cwd, "received.json"), "utf8"));
for (const [source, fixture] of Object.entries(fixtures)) {
  for (const target of Object.keys(fixtures)) {
    it(source + " -> " + target + " injects the complete bundle and follows up by ID", async () => {
      const bundle = await convert(fixture, target);
      const command = ["run", "--agent", target, "--cwd", cwd, "--model", "chosen-model"];
      const first = await cli([...command, "--json", "--prompt", "first question", "--bundle", bundle]);
      expect(first.status, JSON.stringify(first.err)).toBe(0);
      const events = first.out.trim().split("\n").map(s => JSON.parse(s));
      expect(events.map(e => e.type)).toEqual(["bundle", "session", "text", "usage", "done"]);
      const report = JSON.parse(await readFile(events[0].report, "utf8"));
      expect(events[0].losses).toEqual(Object.fromEntries(Object.entries(report.ledger).map(([k, items]) => [k, (items as unknown[]).length])));
      const firstInput = await received();
      const unwrap = (input: string): string => target === "antigravity" ? JSON.parse(input).message.content : input;
      expect(unwrap(firstInput.input)).toContain(await readFile(path.join(bundle, "context.md"), "utf8"));
      expect(unwrap(firstInput.input)).toMatch(/Current user request\n\nfirst question$/);
      expect(firstInput.args).toContain("chosen-model");
      expect(firstInput.cwd).toBe(cwd);
      const second = await cli([...command, "--session", events[1].id, "--prompt", "second question"]);
      expect(second.status).toBe(0);
      expect(second.out).toBe("测试成功\n");
      expect(JSON.parse(second.err[0]!)).toEqual(events[1]);
      const followup = await received();
      expect(unwrap(followup.input)).toBe("second question");
      expect(followup.args).toContain(events[1].id);
    });
  }
}
it("rejects corrupt bundles, incompatible cwd, and target mismatch before spawning", async () => {
  const bundle = await convert(fixtures.codex, "claude-code");
  const args = ["run", "--agent", "claude-code", "--bundle", bundle, "--prompt", "hello"];
  expect((await cli(args)).err.join("")).toContain("--cwd");
  expect((await cli(args.map(a => a === "claude-code" ? "codex" : a))).status).toBe(3);
  await writeFile(path.join(bundle, "context.md"), "damaged");
  expect((await cli([...args, "--cwd", cwd])).err.join("")).toContain("checksum");
  await expect(received()).rejects.toThrow();
});
it("supports direct chat and local discovery", async () => {
  expect(JSON.parse((await cli(["drivers", "--json"])).out).map((d: { version: string }) => d.version)).toEqual(Array(3).fill("fixture-1"));
  expect((await cli(["run", "--agent", "codex", "--prompt", "direct", "--cwd", cwd])).status).toBe(0);
  expect((await received()).input).toBe("direct");
  await unlink(path.join(cwd, "received.json"));
  expect((await cli(["run", "--agent", "codex", "--prompt", "x", "--bundle", cwd, "--session", "id"])).status).toBe(2);
  await expect(received()).rejects.toThrow();
});
