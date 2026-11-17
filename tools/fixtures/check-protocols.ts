import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createProtocolRegistry, convertRequest, convertResponse, convertStream } from "@coverse/protocols";
import { sha256 } from "./collect.js";

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export async function checkProtocolFixtures(root: string): Promise<{ manifests: number; files: number }> {
  const summary = { manifests: 0, files: 0 }; const registry = createProtocolRegistry();
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length !== registry.list().length || entries.some(e => !e.isDirectory() || !registry.list().some(c => c.id === e.name))) throw new Error("Invalid protocol fixture directories");
  for (const entry of entries) {
    const versions = await readdir(path.join(root, entry.name), { withFileTypes: true });
    if (!versions.length) throw new Error("Missing protocol fixture baseline");
    for (const version of versions) {
      if (!version.isDirectory() || version.name !== registry.get(entry.name).baseline) throw new Error("Unverified protocol fixture baseline");
      const directory = path.join(root, entry.name, version.name); const manifestPath = path.join(directory, "manifest.json");
      if (!(await lstat(manifestPath)).isFile()) throw new Error("Protocol manifest must be a regular file");
      const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!record(manifest) || manifest.schemaVersion !== 1 || manifest.protocol !== entry.name || manifest.baseline !== version.name || manifest.provenance !== "synthetic" || manifest.reviewRequired !== false || !Array.isArray(manifest.sources) || !manifest.sources.length || manifest.sources.some(v => typeof v !== "string" || !v.startsWith("https://")) || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Invalid or unreviewed protocol fixture manifest");
      const expected = new Set(["manifest.json"]); const kinds = new Set<string>();
      for (const file of manifest.files) {
        if (!record(file) || typeof file.path !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.(json|sse)$/.test(file.path) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !["request", "response", "stream"].includes(String(file.kind)) || file.format !== (file.kind === "stream" ? "sse" : "json") || !file.path.endsWith(`.${file.format}`) || expected.has(file.path)) throw new Error("Invalid protocol fixture file entry");
        const filename = path.join(directory, file.path); expected.add(file.path); kinds.add(String(file.kind));
        if (!(await lstat(filename)).isFile()) throw new Error("Protocol fixture must be a regular file");
        const bytes = await readFile(filename); if (sha256(bytes) !== file.sha256) throw new Error("Protocol fixture checksum mismatch");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (file.kind === "stream") {
          const conversion = convertStream({ from: entry.name, to: entry.name, input: (async function* () { yield bytes; })() });
          for await (const _ of conversion.data) { /* Validate the complete stream lifecycle. */ }
        } else (file.kind === "request" ? convertRequest : convertResponse)({ from: entry.name, to: entry.name, input: JSON.parse(text) });
        summary.files++;
      }
      if (kinds.size !== 3) throw new Error("Protocol baseline must cover request, response and stream");
      const actual = await readdir(directory, { withFileTypes: true });
      if (actual.length !== expected.size || actual.some(e => !e.isFile() || !expected.has(e.name))) throw new Error("Protocol fixture directory contains unlisted artifacts");
      summary.manifests++;
    }
  }
  return summary;
}
