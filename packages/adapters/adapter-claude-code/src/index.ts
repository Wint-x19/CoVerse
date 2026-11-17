import { AdapterUnavailableError, type SessionAdapter } from "@coverse/core";

// No format versions are claimed until verified, sanitized fixtures exist.
const adapter: SessionAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  status: "scaffold",
  supportedVersions: [],
  capabilities: { import: false, export: false, nativeResume: false },
  detect: () => ({ confidence: 0 }),
  import: () => { throw new AdapterUnavailableError("claude-code", "import"); },
  export: () => { throw new AdapterUnavailableError("claude-code", "export"); },
};

export default adapter;
