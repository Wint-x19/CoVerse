import adapter0 from "@coverse/adapter-codex/package.json" with { type: "json" };
import adapter1 from "@coverse/adapter-claude-code/package.json" with { type: "json" };
import adapter2 from "@coverse/adapter-antigravity/package.json" with { type: "json" };

export const builtinVersions = new Map([
  ["codex", adapter0.version],
  ["claude-code", adapter1.version],
  ["antigravity", adapter2.version],
]);
