import { describe, expect, it } from "vitest";
import { createSanitizer } from "./sanitize.js";

describe("shape-only sanitizer", () => {
  it("redacts free text, secrets, dynamic keys, paths, numbers and booleans", () => {
    const source = {
      role: "user", type: "text", text: "private@example.invalid C:\\Private\\session synthetic-token-123",
      metadata: { "secret-as-key": "private body", amount: 987654321, enabled: true },
      payload: null,
    };
    const result = createSanitizer()(JSON.stringify(source), "json");
    for (const value of ["private@example.invalid", "Private", "synthetic-token-123", "secret-as-key", "private body", "987654321", "true"]) {
      expect(result.content).not.toContain(value);
    }
    const redacted = JSON.parse(result.content);
    expect(redacted.role).toBe("user");
    expect(redacted.type).toBe("text");
    expect(redacted.payload).toBeNull();
    expect(result.report).toMatchObject({ records: 1, strings: 2, keys: 3, numbers: 1, booleans: 1 });
  });

  it("keeps string references stable across files without saving reverse mappings", () => {
    const sanitize = createSanitizer();
    const first = sanitize('{"id":"shared-secret-id","text":"body"}', "json");
    const second = sanitize('{"parentId":"shared-secret-id","text":"other"}', "json");
    expect(JSON.parse(first.content).id).toBe(JSON.parse(second.content).parentId);
    expect(JSON.parse(first.content).text).not.toBe(JSON.parse(second.content).text);
    expect(JSON.stringify([first, second])).not.toContain("shared-secret-id");
  });

  it("handles BOM, CRLF and blank lines while counting structural changes", () => {
    const result = createSanitizer()('\uFEFF{"text":"秘密"}\r\n\r\n{"text":"秘密"}\r\n', "jsonl");
    expect(result.report).toMatchObject({ records: 2, strings: 2, blankLinesRemoved: 1 });
    const lines = result.content.trim().split("\n");
    expect(lines[0]).toBe(lines[1]);
    expect(result.content).not.toContain("秘密");
  });

  it("never includes malformed source text in errors", () => {
    expect(() => createSanitizer()('{"text":"DO-NOT-LOG"', "jsonl")).toThrow("Invalid JSONL at record 1; source text omitted");
    expect(() => createSanitizer()("\n ", "jsonl")).toThrow("no JSONL records");
  });

  it("handles dangerous and colliding keys without prototype mutation", () => {
    const input = '{"__proto__":{"polluted":"secret"},"redacted_key_1":"another","constructor":"third"}';
    const result = JSON.parse(createSanitizer()(input, "json").content);
    expect(Object.keys(result)).toHaveLength(3);
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
    expect(Object.hasOwn({}, "polluted")).toBe(false);
  });

  it("bounds recursive processing", () => {
    expect(() => createSanitizer()("[".repeat(102) + "null" + "]".repeat(102), "json")).toThrow("nesting depth");
  });
});
