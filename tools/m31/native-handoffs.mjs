import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createDriverRegistry } from "../../packages/drivers/dist/index.js";
import { createAdapterRegistry, UiService, UiStore } from "../../packages/ui/dist/main/core.js";
import { hash, root } from "./cases.mjs";

// Opt-in: each run creates dedicated native conversations using the installed clients.
if (process.argv[2] !== "--live") throw Error("Pass --live to run the native handoff matrix.");
const routes = [
  ["codex", "claude-code"], ["claude-code", "codex"], ["claude-code", "antigravity"],
  ["antigravity", "claude-code"], ["antigravity", "codex"],
];
const selected = routes.filter(route => !process.argv[3] || route.join(":") === process.argv[3]);
assert.ok(selected.length, "Unknown route");
await fs.mkdir(path.join(root, ".tmp"), { recursive: true });
const base = await fs.mkdtemp(path.join(root, ".tmp", "native-handoffs-"));
const drivers = createDriverRegistry();
const store = new UiStore(path.join(base, "data"));
const service = new UiService(createAdapterRegistry(), drivers, store, base);
const models = { codex: process.env.COVERSE_TEST_CODEX_MODEL, "claude-code": process.env.COVERSE_TEST_CLAUDE_MODEL,
  antigravity: process.env.COVERSE_TEST_AGY_MODEL };
const sources = new Map();
const results = [];
console.log("Evidence directory:", base);

async function nativeTurn(agent, cwd, prompt, session) {
  let id, answer = "", done = false;
  for await (const event of drivers.get(agent).run({ cwd, prompt, session, model: models[agent], signal: AbortSignal.timeout(180000) })) {
    if (event.type === "session") id = event.id;
    if (event.type === "text") answer += event.text;
    assert.notEqual(event.type, "tool", "Receipt test requested no tools");
    if (event.type === "done") done = true;
  }
  assert.ok(done && id, "Missing successful native terminal event");
  if (session) assert.equal(id, session);
  return { id, answer: answer.trim() };
}

async function source(agent) {
  if (sources.has(agent)) return sources.get(agent);
  const cwd = path.join(base, "projects", agent);
  await fs.mkdir(cwd, { recursive: true });
  const receipt = randomBytes(12).toString("hex");
  const label = randomBytes(6).toString("hex");
  const prompt = "My test receipt is " + receipt + ". Remember it for this chat. Reply with only STORED. No tools.";
  const { id, answer } = await nativeTurn(agent, cwd, prompt);
  assert.equal(answer, "STORED");
  const follow = "Associate that receipt with shipment label " + label + ". Reply with only LINKED. No tools.";
  assert.equal((await nativeTurn(agent, cwd, follow, id)).answer, "LINKED");
  const matches = (await service.listLocalSessions(agent)).filter(entry => entry.id === id);
  assert.equal(matches.length, 1, "Source must appear in the import catalog");
  const file = matches[0].path;
  const expectedMessages = [["user", prompt], ["assistant", "STORED"], ["user", follow], ["assistant", "LINKED"]];
  const result = { file, cwd, receipt, label, expectedMessages, id, sha256: hash(await fs.readFile(file)) };
  sources.set(agent, result);
  return result;
}

for (const [from, to] of selected) {
  const result = { from, to, passed: false };
  results.push(result);
  try {
    const s = await source(from);
    const request = { from, paths: [s.file], useSourceProject: true };
    const options = { to, model: models[to], title: "CoVerse QA " + from + " to " + to, omitOpaque: true };
    let target;
    if (to === "codex") {
      const referenced = await service.convertSource({ ...request, to: from });
      assert.equal(referenced.targetSessionId, s.id);
      target = await service.handoffSession(referenced.id, options);
    } else {
      target = await service.convertSource({ ...request, ...options });
    }
    assert.equal(target.handoff?.materializationError, undefined);
    assert.ok(target.targetSessionId && !target.bundlePending, "Target CLI registration is pending");
    assert.equal(path.relative(target.cwd, s.cwd), "");
    // Some native clients store readable reasoning in its own assistant item before the reply.
    const dialogue = target.messages.filter(m => !(m.role === "assistant" && !m.content && m.reasoning &&
      !m.tools?.length && !m.assets?.length && !m.error));
    assert.deepEqual(dialogue.map(m => [m.role, m.content]), s.expectedMessages);
    assert.equal(hash(await fs.readFile(s.file)), s.sha256, "Source changed during conversion");
    if (to === "antigravity" && process.platform === "win32") {
      assert.equal(target.handoff.desktopError, undefined);
      assert.ok(target.handoff.desktopSessionId, "Missing desktop project registration");
    }
    const bundle = await service.getBundleDetail(target.handoff.bundleId);
    assert.ok(bundle.context.includes(s.receipt) && bundle.context.includes(s.label));
    const native = await nativeTurn(to, s.cwd,
      "From our conversation, return the test receipt and its shipment label as receipt/label. Output only the two values separated by a slash. No tools.", target.targetSessionId);
    assert.equal(native.answer, s.receipt + "/" + s.label);
    Object.assign(result, { passed: true, sourceSha256: s.sha256, losses: target.handoff.losses,
      sourceId: s.id, targetId: native.id, desktopId: target.handoff.desktopSessionId });
  } catch (error) {
    result.error = error.message;
    process.exitCode = 1;
  }
  console.log(from, "->", to, result.passed ? "PASS" : "FAIL: " + result.error);
  await fs.writeFile(path.join(base, "results.json"), JSON.stringify(results, null, 2));
}
