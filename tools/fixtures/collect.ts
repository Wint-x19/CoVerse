import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSanitizer, type FixtureFormat } from "./sanitize.js";

export const initialAgents = ["codex", "claude-code", "antigravity"] as const;
export const maxFixtureBytes = 10 * 1024 * 1024;

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function collectFixtures(options: {
  repositoryRoot: string;
  agent: string;
  formatVersion: string;
  name: string;
  inputs: readonly string[];
  format: FixtureFormat;
}) {
  if (!initialAgents.some((agent) => agent === options.agent)) throw new Error("Agent must be codex, claude-code or antigravity");
  for (const label of [options.formatVersion, options.name]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(label)) throw new Error("Version and name must be safe labels (1-64 letters, digits, _ or -)");
  }
  if (options.inputs.length === 0) throw new Error("At least one explicit input file is required");
  if (options.format !== "json" && options.format !== "jsonl") throw new Error("Unsupported fixture format");
  const sanitize = createSanitizer();
  let totalBytes = 0;
  const artifacts = [];
  for (const [index, input] of options.inputs.entries()) {
    // Explicit files only: never discover or recursively scan user session directories.
    let bytes: Buffer;
    const handle = await open(input, "r").catch(() => {
      throw new Error(`Cannot read input ${index + 1}; source path omitted`);
    });
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Input must be a regular file");
      if (info.size + totalBytes > maxFixtureBytes) throw new Error("Capture exceeds the 10 MiB total limit");
      // Bound the read even if an active agent appends to its log after stat().
      const chunks: Buffer[] = [];
      let length = 0;
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, maxFixtureBytes - totalBytes - length + 1));
        const { bytesRead } = await handle.read(chunk);
        if (!bytesRead) break;
        length += bytesRead;
        if (totalBytes + length > maxFixtureBytes) throw new Error("Capture exceeds the 10 MiB total limit");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      bytes = Buffer.concat(chunks);
    } finally { await handle.close(); }
    totalBytes += bytes.byteLength;
    if (totalBytes > maxFixtureBytes) throw new Error("Capture exceeds the 10 MiB total limit");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error(`Input ${index + 1} is not UTF-8; binary/compressed files require a format-specific collector`); }
    const result = sanitize(text, options.format);
    artifacts.push({ path: `sample-${index + 1}.${options.format}`, ...result });
  }
  const manifest = {
    schemaVersion: 1,
    agent: options.agent,
    formatVersion: options.formatVersion,
    provenance: "sanitized-local",
    reviewRequired: true,
    nativeFormatVerified: false,
    policy: "shape-only-v1",
    files: artifacts.map((artifact) => ({
      path: artifact.path, format: options.format,
      sha256: sha256(artifact.content), redactions: artifact.report,
    })),
  };
  const parent = path.join(options.repositoryRoot, ".local", "fixtures", options.agent, options.formatVersion);
  const destination = path.join(parent, options.name);
  // Parse every input before writing. mkdir without recursive refuses an existing capture.
  await mkdir(parent, { recursive: true });
  try { await mkdir(destination); }
  catch { throw new Error("Capture destination already exists or cannot be created; choose a new name"); }
  for (const artifact of artifacts) {
    await writeFile(path.join(destination, artifact.path), artifact.content, { flag: "wx", mode: 0o600 });
  }
  await writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { destination, manifest };
}
