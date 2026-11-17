import { AdapterUnavailableError, type SessionAdapter } from "@coverse/core";

// No format versions are claimed until verified, sanitized fixtures exist.
const adapter: SessionAdapter = {
  id: "antigravity",
  displayName: "Antigravity",
  status: "scaffold",
  supportedVersions: [],
  capabilities: { import: false, export: false, nativeResume: false },
  detect: () => ({ confidence: 0 }),
  import: () => { throw new AdapterUnavailableError("antigravity", "import"); },
  export: () => { throw new AdapterUnavailableError("antigravity", "export"); },
};

export default adapter;
