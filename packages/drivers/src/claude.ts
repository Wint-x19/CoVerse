import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@coverse/core";
import { finalText, object, string, targetFailure, usage, type DriverEvent, type DriverPlugin, type LocalSessionRef, type ModelOption } from "./driver.js";

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude");
}

async function listClaudeModels(): Promise<ModelOption[]> {
  const home = claudeHome();
  const seen = new Map<string, ModelOption>();
  let configuredDefault: string | undefined;

  try {
    const raw = await fs.readFile(path.join(home, "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as { model?: string; env?: Record<string, unknown> };
    if (typeof parsed.model === "string" && parsed.model.trim()) {
      configuredDefault = parsed.model.trim();
      seen.set(configuredDefault, { id: configuredDefault, label: configuredDefault, isDefault: true });
    }
    const env = parsed.env;
    if (env && typeof env === "object") {
      // Read ONLY non-secret model configuration keys
      const modelKeys = [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      ];
      for (const key of modelKeys) {
        const value = env[key];
        if (typeof value === "string" && value.trim()) {
          const id = value.trim();
          if (!seen.has(id)) {
            seen.set(id, { id, label: id, ...(configuredDefault === id ? { isDefault: true } : {}) });
          }
        }
      }
    }
  } catch { /* settings optional */ }

  for (const alias of [
    { id: "sonnet", label: "Claude Sonnet (alias)" },
    { id: "opus", label: "Claude Opus (alias)" },
    { id: "haiku", label: "Claude Haiku (alias)" },
  ]) {
    if (!seen.has(alias.id)) seen.set(alias.id, alias);
  }

  return [...seen.values()];
}

async function inspectClaudeSessionHead(filePath: string): Promise<{ cwd?: string; title?: string }> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      let cwd: string | undefined;
      let title: string | undefined;
      for await (const line of handle.readLines()) {
        if (!line.trim()) continue;
        let row: unknown;
        try { row = JSON.parse(line); } catch { continue; }
        if (!isRecord(row)) continue;
        if (!cwd && typeof row.cwd === "string" && row.cwd) cwd = row.cwd;
        if (row.type === "summary" && typeof row.summary === "string" && row.summary.trim()) {
          title = row.summary.trim();
        }
        if (!title && row.type === "user" && isRecord(row.message)) {
          const content = row.message.content;
          if (typeof content === "string" && content.trim()) {
            title = content.trim().split(/\r?\n/)[0]?.slice(0, 64);
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
                title = block.text.trim().split(/\r?\n/)[0]?.slice(0, 64);
                break;
              }
            }
          }
        }
        if (cwd && title) break;
      }
      return { ...(cwd ? { cwd } : {}), ...(title ? { title } : {}) };
    } finally {
      await handle.close();
    }
  } catch {
    return {};
  }
}

async function listClaudeLocalSessions(limit = 60): Promise<LocalSessionRef[]> {
  const projectsRoot = path.join(claudeHome(), "projects");
  const files: { fullPath: string; name: string; projectDir: string; mtimeMs: number; size: number }[] = [];

  let projects;
  try { projects = await fs.readdir(projectsRoot, { withFileTypes: true }); } catch { return []; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(projectsRoot, project.name);
    let entries;
    try { entries = await fs.readdir(projectPath, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const fullPath = path.join(projectPath, entry.name);
      try {
        const info = await fs.stat(fullPath);
        if (info.size === 0) continue;
        files.push({ fullPath, name: entry.name, projectDir: project.name, mtimeMs: info.mtimeMs, size: info.size });
      } catch { /* ignore */ }
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const refs: LocalSessionRef[] = [];
  for (const file of files.slice(0, limit)) {
    const id = file.name.replace(/\.jsonl$/, "");
    const meta = await inspectClaudeSessionHead(file.fullPath);
    refs.push({
      id,
      agent: "claude-code",
      title: meta.title || (meta.cwd ? path.basename(meta.cwd) : id.slice(0, 12)),
      path: file.fullPath,
      ...(meta.cwd ? { cwd: meta.cwd } : {}),
      updatedAt: new Date(file.mtimeMs).toISOString(),
      size: file.size,
    });
  }
  return refs;
}

export const claude: DriverPlugin = {
  id: "claude-code", command: "claude", verifiedVersions: ["2.1.121 (Claude Code)"],
  resumeArgs: id => ["--resume", id],
  invocation({ model, session, prompt, attachmentDirectory }) {
    const args = ["--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages", "--disable-slash-commands"];
    if (model) args.push("--model", model);
    if (session) args.push("--resume", session);
    if (attachmentDirectory) args.push("--add-dir", attachmentDirectory);
    return { args, input: prompt };
  },
  decoder() {
    let textStreamed = false, messageText = "";
    return record => {
      if (record.parent_tool_use_id) return [];
      if (record.type === "system" && record.subtype === "init") return [{ type: "session", id: string(record.session_id) }];
      if (record.type === "stream_event") {
        const event = object(record.event);
        if (event.type === "message_start") { textStreamed = false; messageText = ""; }
        if (event.type === "content_block_delta" && isRecord(event.delta) && event.delta.type === "text_delta") {
          const text = string(event.delta.text);
          textStreamed = true;
          messageText += text;
          return [{ type: "text", text }];
        }
        return [];
      }
      if (record.type === "assistant" || record.type === "user") {
        const events: DriverEvent[] = [];
        const message = object(record.message);
        if (Array.isArray(message.content)) for (const block of message.content) {
          if (!isRecord(block)) continue;
          if (record.type === "assistant" && block.type === "text" && !textStreamed) {
            const text = string(block.text);
            messageText += text;
            events.push({ type: "text", text });
          }
          if (block.type === "tool_use") events.push({ type: "tool", name: string(block.name), state: "started" });
          if (block.type === "tool_result") events.push({ type: "tool", name: string(block.tool_use_id), state: block.is_error ? "failed" : "completed" });
        }
        if (record.error) throw targetFailure(String(record.error) + ": " + events.filter(e => e.type === "text").map(e => e.text).join(""));
        return events;
      }
      if (record.type === "result") {
        if (record.is_error !== false || record.subtype !== "success") {
          throw targetFailure(String(record.result ?? JSON.stringify(record.errors ?? record.subtype)));
        }
        const events: DriverEvent[] = [{ type: "session", id: string(record.session_id) }];
        events.push(...finalText(messageText, record.result));
        return [...events, ...usage(record.usage), { type: "done" }];
      }
      return [];
    };
  },
  listModels: listClaudeModels,
  listLocalSessions: listClaudeLocalSessions,
};
