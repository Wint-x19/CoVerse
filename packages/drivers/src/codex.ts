import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { driverError, object, string, targetFailure, usage, type DriverPlugin, type LocalSessionRef, type ModelOption } from "./driver.js";

function codexHome(): string {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

async function readDefaultCodexModel(home: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(path.join(home, "config.toml"), "utf8");
    const match = /^\s*model\s*=\s*"([^"]+)"/m.exec(content);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function listCodexModels(): Promise<ModelOption[]> {
  const home = codexHome();
  const defaultModel = await readDefaultCodexModel(home);
  const candidates = ["models_cache.json", "models_cache.codex_work_desktop.json"];
  const seen = new Map<string, ModelOption>();

  for (const filename of candidates) {
    try {
      const raw = await fs.readFile(path.join(home, filename), "utf8");
      const parsed = JSON.parse(raw) as { models?: Array<{ slug?: string; id?: string; display_name?: string; visibility?: string }> };
      const list = Array.isArray(parsed.models) ? parsed.models : [];
      for (const item of list) {
        const id = item.slug ?? item.id;
        if (!id || typeof id !== "string") continue;
        if (item.visibility && item.visibility !== "list") continue;
        if (!seen.has(id)) {
          seen.set(id, {
            id,
            label: typeof item.display_name === "string" && item.display_name ? item.display_name : id,
            ...(defaultModel === id ? { isDefault: true } : {}),
          });
        }
      }
      if (seen.size > 0) break;
    } catch {
      continue;
    }
  }

  if (defaultModel && !seen.has(defaultModel)) {
    seen.set(defaultModel, { id: defaultModel, label: defaultModel, isDefault: true });
  }
  return [...seen.values()];
}

async function readFirstLine(filePath: string): Promise<string | null> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead <= 0) return null;
      const chunk = buffer.subarray(0, bytesRead).toString("utf8");
      const newline = chunk.indexOf("\n");
      return (newline >= 0 ? chunk.slice(0, newline) : chunk).trim();
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function listCodexLocalSessions(limit = 60): Promise<LocalSessionRef[]> {
  const home = codexHome();
  const sessionsRoot = path.join(home, "sessions");

  // Load optional title index from session_index.jsonl
  const indexTitles = new Map<string, string>();
  try {
    const raw = await fs.readFile(path.join(home, "session_index.jsonl"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { id?: string; thread_name?: string; title?: string };
        const title = row.thread_name ?? row.title;
        if (typeof row.id === "string" && typeof title === "string" && title.trim()) {
          indexTitles.set(row.id, title.trim());
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* index optional */ }

  const files: { fullPath: string; name: string; mtimeMs: number; size: number }[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && /^rollout-.*\.jsonl(?:\.zst)?$/.test(entry.name)) {
        try {
          const info = await fs.stat(fullPath);
          files.push({ fullPath, name: entry.name, mtimeMs: info.mtimeMs, size: info.size });
        } catch { /* ignore disappearing file */ }
      }
    }
  }
  await walk(sessionsRoot, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const refs: LocalSessionRef[] = [];
  for (const file of files.slice(0, limit)) {
    const uuidMatch = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(file.name);
    let id = uuidMatch?.[1] ?? file.name;
    let cwd: string | undefined;
    if (file.name.endsWith(".jsonl")) {
      const firstLine = await readFirstLine(file.fullPath);
      if (firstLine) {
        try {
          const head = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; cwd?: string } };
          if (head.type === "session_meta" && head.payload) {
            if (typeof head.payload.id === "string") id = head.payload.id;
            if (typeof head.payload.cwd === "string") cwd = head.payload.cwd;
          }
        } catch { /* header truncated or non-JSON */ }
      }
    }
    const title = indexTitles.get(id) ?? (cwd ? path.basename(cwd) : file.name.replace(/\.jsonl(?:\.zst)?$/, ""));
    refs.push({
      id,
      agent: "codex",
      title,
      path: file.fullPath,
      ...(cwd ? { cwd } : {}),
      updatedAt: new Date(file.mtimeMs).toISOString(),
      size: file.size,
    });
  }
  return refs;
}

export const codex: DriverPlugin = {
  id: "codex",
  resumeArgs: id => ["resume", id],
  command: "codex",
  verifiedVersions: ["codex-cli 0.169.0-alpha.11.1"],
  invocation({ model, session, prompt, attachmentDirectory }) {
    const args = ["exec", "--json", "--skip-git-repo-check"];
    if (model) args.push("--model", model);
    if (attachmentDirectory) args.push("--add-dir", attachmentDirectory);
    if (session) args.push("resume", session);
    args.push("-");
    return { args, input: prompt };
  },
  decoder: () => record => {
    switch (record.type) {
      case "thread.started": return [{ type: "session", id: string(record.thread_id) }];
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = object(record.item);
        if (item.type === "agent_message" && record.type === "item.completed") return [{ type: "text", text: string(item.text) }];
        if (["command_execution", "mcp_tool_call", "file_change", "web_search", "collab_tool_call", "dynamic_tool_call"].includes(String(item.type))) {
          return [{ type: "tool", name: String(item.tool ?? item.type), state: String(item.status ?? record.type) }];
        }
        return [];
      }
      case "turn.completed": return [...usage(record.usage), { type: "done" }];
      case "turn.failed": throw targetFailure(string(object(record.error).message));
      case "error": {
        const message = string(record.message);
        if (/^Reconnecting\.\.\./i.test(message)) return [];
        throw targetFailure(message);
      }
      case "turn.started":
      case "thread.updated":
      case "turn.updated":
        return [];
      default: throw driverError("Unsupported Codex event: " + record.type);
    }
  },
  listModels: listCodexModels,
  listLocalSessions: listCodexLocalSessions,
};
