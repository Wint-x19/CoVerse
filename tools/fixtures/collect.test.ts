import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFixtures, maxFixtureBytes, sha256 } from "./collect.js";
import { createSandbox, removeSandbox } from "../test-helpers.js";

let sandbox: string;
beforeEach(async () => {
  sandbox = await createSandbox();
});
afterEach(async () => { await removeSandbox(sandbox); });

const options = () => ({ repositoryRoot: sandbox, agent: "codex", formatVersion: "unverified", name: "capture", format: "jsonl" as const });

describe("fixture collection", () => {
  it("captures only explicit files, preserves originals and stages reviewed-later output", async () => {
    const original = '{"id":"private-session","text":"private text"}\n';
    const first = path.join(sandbox, "sensitive-name.jsonl");
    const second = path.join(sandbox, "other.jsonl");
    await writeFile(first, original);
    await writeFile(second, '{"parentId":"private-session"}\n');
    const result = await collectFixtures({ ...options(), inputs: [first, second] });
    expect(await readFile(first, "utf8")).toBe(original);
    expect(result.destination).toContain(path.join(".local", "fixtures", "codex", "unverified", "capture"));
    expect(result.manifest).toMatchObject({ reviewRequired: true, nativeFormatVerified: false, provenance: "sanitized-local" });
    const output = await readFile(path.join(result.destination, "sample-1.jsonl"), "utf8");
    const next = await readFile(path.join(result.destination, "sample-2.jsonl"), "utf8");
    expect(JSON.parse(output).id).toBe(JSON.parse(next).parentId);
    expect(result.manifest.files[0]!.sha256).toBe(sha256(output));
    expect(JSON.stringify(result.manifest)).not.toContain("sensitive-name");
    expect(output).not.toContain("private");
    await expect(collectFixtures({ ...options(), inputs: [first] })).rejects.toThrow("already exists");
    expect(await readFile(path.join(result.destination, "sample-1.jsonl"), "utf8")).toBe(output);
  });

  it("validates all inputs before creating a capture", async () => {
    const valid = path.join(sandbox, "valid.jsonl");
    const invalid = path.join(sandbox, "invalid.jsonl");
    await writeFile(valid, '{"text":"valid"}\n');
    await writeFile(invalid, "malformed-private-data");
    await expect(collectFixtures({ ...options(), inputs: [valid, invalid] })).rejects.toThrow("source text omitted");
    expect(await readdir(sandbox)).not.toContain(".local");
  });

  it("rejects invalid encoding and oversized inputs", async () => {
    const source = path.join(sandbox, "input");
    await writeFile(source, new Uint8Array([0xff, 0xfe, 0xfd]));
    await expect(collectFixtures({ ...options(), inputs: [source] })).rejects.toThrow("not UTF-8");
    await writeFile(source, Buffer.alloc(maxFixtureBytes + 1));
    await expect(collectFixtures({ ...options(), inputs: [source] })).rejects.toThrow("10 MiB");
  });

  it("rejects out-of-scope agents and path traversal labels", async () => {
    await expect(collectFixtures({ ...options(), agent: "other", inputs: [] })).rejects.toThrow("Agent must");
    await expect(collectFixtures({ ...options(), name: "../outside", inputs: [] })).rejects.toThrow("safe labels");
    await expect(collectFixtures({ ...options(), formatVersion: "../../outside", inputs: [] })).rejects.toThrow("safe labels");
    await expect(collectFixtures({ ...options(), inputs: [] })).rejects.toThrow("explicit input");
  });
});
