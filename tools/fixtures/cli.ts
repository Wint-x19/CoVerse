import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { collectFixtures } from "./collect.js";

try {
  const { values } = parseArgs({
    options: {
      agent: { type: "string" }, "format-version": { type: "string" },
      name: { type: "string" }, input: { type: "string", multiple: true },
      format: { type: "string" }, help: { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log("Usage: pnpm fixtures:collect --agent <codex|claude-code|antigravity> --format-version <label> --name <capture> --format <json|jsonl> --input <file> [--input <file>]\nOutputs shape-only redacted files to ignored .local/fixtures/. Human review is required before committing.");
  } else {
    if (!values.agent || !values["format-version"] || !values.name || !values.input ||
        (values.format !== "json" && values.format !== "jsonl")) {
      throw new Error("Missing or invalid options; use --help");
    }
    const result = await collectFixtures({
      repositoryRoot: fileURLToPath(new URL("../../", import.meta.url)),
      agent: values.agent, formatVersion: values["format-version"], name: values.name,
      inputs: values.input, format: values.format,
    });
    console.log(`Created ${result.manifest.files.length} sanitized artifact(s) in ${result.destination}\nReview required: shape-only redaction changes content, identifiers, timestamps and scalar values. No raw source paths or reverse mapping were saved.`);
  }
} catch {
  // Even option-parser / filesystem errors can contain user paths or raw secrets.
  console.error("Fixture collection failed. Check required options, UTF-8 JSON/JSONL input, the 10 MiB limit, and a new capture name. No source text is logged. Use --help.");
  process.exitCode = 1;
}
