import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  driverError,
  finalText,
  ignoreMissingEntry,
  object,
  string,
  targetFailure,
  usage,
  type DriverEvent,
  type DriverPlugin,
  type Executable,
  type LocalSessionRef,
  type ModelOption,
} from "./driver.js";

async function listAntigravityModels(executable: Executable | null): Promise<ModelOption[]> {
  if (!executable) return [];
  try {
    const result = await promisify(execFile)(
      executable.command,
      [...(executable.prefix ?? []), "models"],
      { timeout: 10000, windowsHide: true, maxBuffer: 256 * 1024 },
    );
    const models: ModelOption[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tab = trimmed.indexOf("\t");
      if (tab > 0) {
        const id = trimmed.slice(0, tab).trim();
        const label = trimmed.slice(tab + 1).trim() || id;
        if (id && !/\s/.test(id)) models.push({ id, label });
      }
    }
    return models;
  } catch {
    return [];
  }
}

async function listAntigravityLocalSessions(limit = 60): Promise<LocalSessionRef[]> {
  const root = path.join(os.homedir(), ".gemini", "antigravity", "conversations");
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) { ignoreMissingEntry(error); return []; }

  const dbs: { fullPath: string; name: string; mtimeMs: number; size: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".db")) continue;
    const fullPath = path.join(root, entry.name);
    try {
      const info = await fs.stat(fullPath);
      dbs.push({ fullPath, name: entry.name, mtimeMs: info.mtimeMs, size: info.size });
    } catch (error) { ignoreMissingEntry(error); }
  }

  dbs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const refs: LocalSessionRef[] = [];
  for (const db of dbs.slice(0, limit)) {
    const id = db.name.replace(/\.db$/, "");
    let active = false;
    try {
      const wal = await fs.stat(db.fullPath + "-wal");
      if (wal.size > 0) active = true;
    } catch (error) { ignoreMissingEntry(error); }
    refs.push({
      id,
      agent: "antigravity",
      title: id,
      path: db.fullPath,
      updatedAt: new Date(db.mtimeMs).toISOString(),
      size: db.size,
      ...(active ? { active: true } : {}),
    });
  }
  return refs;
}

export const antigravity: DriverPlugin = {
  id: "antigravity", command: "agy", verifiedVersions: ["1.5.11"],
  resumeArgs: id => ["--conversation", id],
  invocation({ model, session, prompt, attachmentDirectory }) {
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands"];
    if (model) args.push("--model", model);
    if (session) args.push("--conversation", session);
    if (attachmentDirectory) args.push("--add-dir", attachmentDirectory);
    return { args, input: JSON.stringify({ event: "user", message: { content: prompt } }) + "\n" };
  },
  decoder() {
    let stepText = "", stepIndex: unknown, failedTool: string | undefined;
    return record => {
      if (record.event === "init") return [{ type: "session", id: string(record.conversation_id) }];
      if (record.event === "step_update") {
        const step = object(record.step_update);
        const events: DriverEvent[] = [{ type: "session", id: string(step.conversation_id) }];
        if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
          if (stepIndex !== step.step_index) { stepText = ""; stepIndex = step.step_index; }
          stepText += step.text_delta;
          failedTool = undefined;
          events.push({ type: "text", text: step.text_delta });
        }
        if (step.step_type === "tool") {
          const name = string(step.tool_name), state = string(step.state);
          if (state === "ERROR") failedTool = name;
          if (state === "DONE") failedTool = undefined;
          events.push({ type: "tool", name, state });
        }
        return events;
      }
      if (record.event === "result") {
        const result = object(record.result);
        if (result.status !== "SUCCESS") {
          const detail = typeof result.error === "string" ? result.error : JSON.stringify(result.error);
          throw targetFailure("Antigravity terminal status " + String(result.status) + (detail ? ": " + detail : ""));
        }
        if (failedTool && !result.response) throw driverError("Antigravity ended after a failed tool without a response: " + failedTool);
        const events: DriverEvent[] = [{ type: "session", id: string(result.conversation_id) }];
        events.push(...finalText(stepText, result.response));
        return [...events, ...usage(result.usage), { type: "done" }];
      }
      throw driverError("Unsupported Antigravity event: " + record.event);
    };
  },
  listModels: listAntigravityModels,
  listLocalSessions: listAntigravityLocalSessions,
};
