import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkFixtures } from "./check.js";
import { sha256 } from "./collect.js";
import { createSandbox, removeSandbox, repositoryRoot } from "../test-helpers.js";

let sandbox: string;
beforeEach(async () => {
  sandbox = await createSandbox();
  await cp(path.join(repositoryRoot, "fixtures"), path.join(sandbox, "fixtures"), { recursive: true });
});
afterEach(async () => { await removeSandbox(sandbox); });

function root() { return path.join(sandbox, "fixtures"); }
function fixturePath(filename: string) { return path.join(root(), "codex", "synthetic-v1", filename); }
async function editManifest(edit: (manifest: {
  reviewRequired: boolean;
  nativeFormatVerified: boolean;
  files: { path: string; sha256: string }[];
}) => void) {
  const manifest = JSON.parse(await readFile(fixturePath("manifest.json"), "utf8"));
  edit(manifest);
  await writeFile(fixturePath("manifest.json"), JSON.stringify(manifest));
}

describe("fixture baseline validation", () => {
  it("verifies agent scaffolds and all three protocol baselines", async () => {
    expect(await checkFixtures(root())).toEqual({ manifests: 6, files: 12 });
  });
  it("detects content drift", async () => {
    await writeFile(fixturePath("sample.jsonl"), '{"changed":true}\n');
    await expect(checkFixtures(root())).rejects.toThrow("checksum");
  });
  it("rejects unreviewed captures", async () => {
    await editManifest((manifest) => { manifest.reviewRequired = true; });
    await expect(checkFixtures(root())).rejects.toThrow("unreviewed");
  });
  it("rejects unlisted artifacts", async () => {
    await writeFile(fixturePath("unreviewed.json"), "{}");
    await expect(checkFixtures(root())).rejects.toThrow("unlisted");
  });
  it("rejects paths outside the version directory", async () => {
    await editManifest((manifest) => { manifest.files[0]!.path = "../outside.jsonl"; });
    await expect(checkFixtures(root())).rejects.toThrow("file entry");
  });
  it("rejects native compatibility claims on scaffold fixtures", async () => {
    await editManifest((manifest) => { manifest.nativeFormatVerified = true; });
    await expect(checkFixtures(root())).rejects.toThrow("must not claim");
  });
  it("checks syntax even when a checksum matches", async () => {
    const invalid = "{invalid}\n";
    await writeFile(fixturePath("sample.jsonl"), invalid);
    await editManifest((manifest) => { manifest.files[0]!.sha256 = sha256(invalid); });
    await expect(checkFixtures(root())).rejects.toThrow();
  });
  it("detects protocol sample drift and incomplete stream lifecycles", async () => {
    const directory = path.join(root(), "protocols", "chat-completions", "m1-2026-11-17");
    const filename = path.join(directory, "stream.sse");
    const content = (await readFile(filename, "utf8")).replace("data: [DONE]\n\n", "");
    await writeFile(filename, content);
    await expect(checkFixtures(root())).rejects.toThrow("checksum");
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files.find((f: { path: string }) => f.path === "stream.sse").sha256 = sha256(content);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(checkFixtures(root())).rejects.toThrow("terminal event");
  });
  it("rejects unreviewed protocol manifests", async () => {
    const filename = path.join(root(), "protocols", "responses", "m1-2026-11-17", "manifest.json");
    const manifest = JSON.parse(await readFile(filename, "utf8")); manifest.reviewRequired = true;
    await writeFile(filename, JSON.stringify(manifest));
    await expect(checkFixtures(root())).rejects.toThrow("unreviewed");
  });
});
