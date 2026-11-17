import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { initialAgents, sha256 } from "./collect.js";
import { checkProtocolFixtures } from "./check-protocols.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function checkFixtures(root: string): Promise<{ manifests: number; files: number }> {
  const summary = { manifests: 0, files: 0 };
  const agents = await readdir(root, { withFileTypes: true });
  for (const entry of agents) {
    if (entry.name === "README.md" && entry.isFile()) continue;
    if (entry.name === "protocols" && entry.isDirectory()) continue;
    if (!entry.isDirectory() || !initialAgents.some((agent) => agent === entry.name)) throw new Error("Unexpected entry in fixture root");
  }
  for (const agent of initialAgents) {
    const versions = await readdir(path.join(root, agent), { withFileTypes: true });
    if (versions.length === 0) throw new Error(`No fixtures for ${agent}`);
    for (const version of versions) {
      if (!version.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(version.name)) throw new Error("Invalid fixture version directory");
      const directory = path.join(root, agent, version.name);
      const manifestPath = path.join(directory, "manifest.json");
      if (!(await lstat(manifestPath)).isFile()) throw new Error("Manifest must be a regular file");
      const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!record(manifest) || manifest.schemaVersion !== 1 || manifest.agent !== agent ||
          manifest.formatVersion !== version.name || manifest.reviewRequired !== false ||
          typeof manifest.nativeFormatVerified !== "boolean" ||
          !["synthetic", "sanitized-local"].includes(String(manifest.provenance)) ||
          !Array.isArray(manifest.files) || manifest.files.length === 0) {
        throw new Error("Invalid or unreviewed fixture manifest");
      }
      if (manifest.provenance === "synthetic" && manifest.nativeFormatVerified !== false) {
        throw new Error("Scaffold synthetic fixtures must not claim native format verification");
      }
      const expected = new Set(["manifest.json"]);
      for (const file of manifest.files as unknown[]) {
        if (!record(file) || typeof file.path !== "string" ||
            !/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.(json|jsonl)$/.test(file.path) ||
            (file.format !== "json" && file.format !== "jsonl") ||
            !file.path.endsWith(`.${file.format}`) || typeof file.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(file.sha256) || expected.has(file.path)) {
          throw new Error("Invalid or duplicate fixture file entry");
        }
        expected.add(file.path);
        const filename = path.join(directory, file.path);
        if (!(await lstat(filename)).isFile()) throw new Error("Fixture must be a regular file");
        const bytes = await readFile(filename);
        if (sha256(bytes) !== file.sha256) throw new Error("Fixture checksum mismatch");
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (file.format === "json") JSON.parse(content);
        else {
          const lines = content.split(/\r?\n/).filter((line) => line.trim());
          if (!lines.length) throw new Error("Empty JSONL fixture");
          for (const line of lines) JSON.parse(line);
        }
        summary.files++;
      }
      const actual = await readdir(directory, { withFileTypes: true });
      if (actual.some((entry) => !entry.isFile() || !expected.has(entry.name)) || actual.length !== expected.size) {
        throw new Error("Fixture directory contains unlisted artifacts");
      }
      summary.manifests++;
    }
  }
  if (agents.some(entry => entry.name === "protocols")) {
    const protocols = await checkProtocolFixtures(path.join(root, "protocols"));
    summary.manifests += protocols.manifests; summary.files += protocols.files;
  }
  return summary;
}
