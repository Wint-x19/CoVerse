import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = new Map([
  ["claude-code", "codex/rollout-2026-11-17/sample.jsonl"],
  ["antigravity", "claude-code/transcript-sdk-0_3_326/sample.jsonl"],
  ["codex", "antigravity/sqlite-2_32_1-step0/sample.db"],
]);
const agent = process.argv[2];
if (!fixtures.has(agent) || process.argv.length !== 3) {
  console.error("Usage: node tools/m3-demo.mjs <codex|claude-code|antigravity>");
  process.exit(2);
}
const parent = path.join(root, ".tmp");
await mkdir(parent, { recursive: true });
const evidence = await mkdtemp(path.join(parent, "m3-" + agent + "-"));
console.log("Demo evidence: " + evidence);

async function cli(label, args) {
  const child = spawn(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), ...args], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await writeFile(path.join(evidence, label + ".jsonl"), stdout);
  if (stderr) await writeFile(path.join(evidence, label + ".stderr"), stderr);
  if (status !== 0) throw Error(label + " failed (" + status + ")\n" + stderr);
  return stdout;
}

async function run() {
  const versions = JSON.parse(await cli("drivers", ["drivers", "--json"]));
  const version = versions.find(d => d.id === agent)?.version;
  const cwd = path.join(evidence, "workspace"), bundle = path.join(evidence, "bundle");
  await mkdir(cwd);
  const converted = JSON.parse(await cli("conversion", ["convert-session", "--from", "auto", "--to", agent,
    "--input", path.join(root, "fixtures", fixtures.get(agent)), "--output", bundle]));
  async function turn(label, args) {
    const output = await cli(label, ["run", "--agent", agent, "--cwd", cwd, "--json", ...args]);
    const events = output.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.at(-1)?.type, "done");
    const id = events.find(e => e.type === "session")?.id;
    assert.ok(id);
    return { id, answer: events.filter(e => e.type === "text").map(e => e.text).join("") };
  }
  const marker = randomBytes(8).toString("hex");
  const first = await turn("first", ["--bundle", bundle, "--prompt",
    "From the supplied history, quote the exact file contents returned by the read tool. On the next line append the marker " + marker + ". Answer without tools."]);
  assert.ok(first.answer.includes("Hello from the sample.") && first.answer.includes(marker), "Missing historical fact or marker");
  const second = await turn("second", ["--session", first.id, "--prompt",
    "What marker did you put on the last line of your previous answer? Reply with only that marker, without tools."]);
  assert.equal(second.id, first.id);
  assert.equal(second.answer.trim(), marker);
  const result = { source: converted.from, agent, version, first, second, losses: converted.losses, report: path.join(bundle, "report.json") };
  await writeFile(path.join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
try { await run(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
