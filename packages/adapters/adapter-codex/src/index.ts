import { AdapterUnavailableError, type SessionAdapter } from "@coverse/core";

// No format versions are claimed until verified, sanitized fixtures exist.
const adapter: SessionAdapter = {
  id: "codex",
  displayName: "Codex",
  status: "scaffold",
  supportedVersions: [],
  capabilities: { import: false, export: false, nativeResume: false },
  detect: () => ({ confidence: 0 }),
  import: () => { throw new AdapterUnavailableError("codex", "import"); },
  export: () => { throw new AdapterUnavailableError("codex", "export"); },
};

export default adapter;
