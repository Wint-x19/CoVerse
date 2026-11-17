import assert from "node:assert/strict";
import { convertSession, emptyLedger, type FileSet, type SessionAdapter } from "@coverse/core";

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
console.log("M0 smoke passed: empty and binary FileSet -> CSR -> FileSet; no native format claims.");
