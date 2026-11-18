import assert from "node:assert/strict";
import { convertSession, emptyLedger, type FileSet, type SessionAdapter } from "@coverse/core";
import { convertRequest, convertResponse } from "@coverse/protocols";
import { readFile } from "node:fs/promises";
import { createRegistry } from "../packages/cli/src/index.js";

// Test-only transport, deliberately not a registered/native session adapter.
const transport: SessionAdapter = {
  id: "smoke-transport",
  displayName: "Synthetic smoke transport",
  status: "ready",
  supportedVersions: ["synthetic-v1"],
  capabilities: { import: true, export: true, nativeResume: false },
  detect: () => ({ confidence: 1, formatVersion: "synthetic-v1" }),
  import: (artifacts) => ({
    session: {
      schemaVersion: "1.0",
      meta: { id: "smoke", agent: "synthetic", agentFormatVersion: "synthetic-v1" },
      turns: [], xExtensions: {}, sourceArtifacts: artifacts,
    },
    ledger: emptyLedger(),
  }),
  export: (session) => ({ artifacts: session.sourceArtifacts ?? [], ledger: emptyLedger() }),
};

for (const artifacts of [[], [{ path: "sample.bin", bytes: new Uint8Array([0, 255, 10, 128]) }]] satisfies FileSet[]) {
  const result = await convertSession({ source: transport, target: transport, artifacts });
  assert.deepEqual(result.artifacts, artifacts);
  assert.deepEqual(result.ledger, emptyLedger());
}
const converted = convertRequest({ from: "responses", to: "anthropic-messages", input: { model: "synthetic", input: "hello", max_output_tokens: 32 } });
assert.equal((converted.data as { max_tokens: number }).max_tokens, 32);
assert.deepEqual(converted.ledger, emptyLedger());
const response = convertResponse({ from: "anthropic-messages", to: "chat-completions", input: { id: "synthetic", model: "synthetic", type: "message", role: "assistant", content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
assert.ok(JSON.stringify(response.data).includes("hello"));
const sessionFixtures = {
  codex: "codex/rollout-2026-11-17/sample.jsonl",
  "claude-code": "claude-code/transcript-sdk-0_3_326/sample.jsonl",
  antigravity: "antigravity/sqlite-2_32_1-step0/sample.db",
};
const registry = createRegistry();
for (const [id, fixture] of Object.entries(sessionFixtures)) {
  const source = registry.get(id), bytes = await readFile(new URL(`../fixtures/${fixture}`, import.meta.url));
  for (const target of registry.list()) {
    const result = await convertSession({ source, target, artifacts: [{ path: fixture.split("/").at(-1)!, bytes }] });
    assert.ok(result.session.turns.length > 0);
    assert.ok(result.artifacts.some(f => f.path === "manifest.json"));
    const report = JSON.parse(new TextDecoder().decode(result.artifacts.find(f => f.path === "report.json")!.bytes));
    assert.deepEqual(report.ledger, result.ledger);
    assert.equal(report.statistics.truncated, false);
  }
}
console.log("M2 smoke passed: M1 protocols, binary transport and all nine verified session-to-injection routes; cross-agent native session synthesis is reserved for M5.");
