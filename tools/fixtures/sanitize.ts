export type FixtureFormat = "json" | "jsonl";
export interface RedactionReport {
  policy: "shape-only-v1";
  records: number;
  strings: number;
  keys: number;
  numbers: number;
  booleans: number;
  blankLinesRemoved: number;
}

// Structural keys only. Unknown/dynamic keys can themselves contain secrets.
const structuralKeys = new Set([
  "id", "type", "role", "content", "text", "payload", "timestamp", "ordinal", "message",
  "messages", "session_id", "sessionId", "parentId", "parentUuid", "uuid", "cwd", "version",
  "model", "name", "arguments", "input", "output", "metadata", "data", "tool_calls", "tool_call_id",
  "call_id", "tool_use_id", "is_error", "usage", "input_tokens", "output_tokens", "thinking",
]);
const roles = new Set(["system", "developer", "user", "assistant", "tool"]);
const types = new Set(["text", "input_text", "output_text", "tool_call", "tool_result", "tool_use", "thinking"]);

/** Format-neutral structural redaction, not a native session parser or lossless conversion. */
export function createSanitizer() {
  // The map is never serialized. Stable aliases preserve references across a capture's files.
  const aliases = new Map<string, string>();
  const keyAliases = new Map<string, string>();
  const alias = (value: string, map: Map<string, string>, prefix: string): string => {
    if (!map.has(value)) map.set(value, `${prefix}${map.size + 1}`);
    return map.get(value)!;
  };

  return (input: string, format: FixtureFormat) => {
    const report: RedactionReport = {
      policy: "shape-only-v1", records: 0, strings: 0, keys: 0, numbers: 0, booleans: 0, blankLinesRemoved: 0,
    };
    const redact = (value: unknown, key = "", depth = 0): unknown => {
      if (depth > 100) throw new Error("Fixture exceeds maximum nesting depth (100)");
      if (typeof value === "string") {
        if ((key === "role" && roles.has(value)) || (key === "type" && types.has(value))) return value;
        report.strings++;
        return alias(value, aliases, "REDACTED_");
      }
      if (typeof value === "number") { report.numbers++; return 0; }
      if (typeof value === "boolean") { report.booleans++; return false; }
      if (value === null) return null;
      if (Array.isArray(value)) return value.map((item) => redact(item, "", depth + 1));
      if (typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([childKey, child]) => {
          const safeKey = structuralKeys.has(childKey) ? childKey : alias(childKey, keyAliases, "redacted_key_");
          if (safeKey !== childKey) report.keys++;
          return [safeKey, redact(child, childKey, depth + 1)];
        }));
      }
      throw new Error("Unsupported JSON value");
    };

    const parse = (text: string, record: number): unknown => {
      try { return JSON.parse(text) as unknown; }
      catch { throw new Error(`Invalid ${format.toUpperCase()} at record ${record}; source text omitted`); }
    };
    const normalized = input.replace(/^\uFEFF/, "");
    let content: string;
    if (format === "json") {
      report.records = 1;
      content = JSON.stringify(redact(parse(normalized, 1)), null, 2) + "\n";
    } else {
      const lines = normalized.split(/\r?\n/);
      // A terminal newline is a delimiter, not an additional blank record.
      if (lines.at(-1) === "") lines.pop();
      const records = lines.flatMap((line, index) => {
        if (!line.trim()) { report.blankLinesRemoved++; return []; }
        report.records++;
        return [JSON.stringify(redact(parse(line, index + 1)))];
      });
      if (records.length === 0) throw new Error("Fixture contains no JSONL records");
      content = records.join("\n") + "\n";
    }
    return { content, report };
  };
}
