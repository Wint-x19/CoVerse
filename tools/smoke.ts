import assert from "node:assert/strict";
import { convertSession, emptyLedger, type FileSet, type SessionAdapter } from "@coverse/core";
import { convertRequest, convertResponse } from "@coverse/protocols";

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
console.log("M1 smoke passed: protocol request/response conversion and empty/binary session transport; no native session format claims.");
