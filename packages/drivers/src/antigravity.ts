import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {isRecord} from "@coverse/core";
import {
  driverError,
  finalText,
  ignoreMissingEntry,
  object,
  string,
  targetFailure,
  usage,
  wireText,
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

const sessionRoot = () => path.join(os.homedir(), ".gemini");

async function listStore(root: string) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) { ignoreMissingEntry(error); return []; }

  const refs: LocalSessionRef[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".db")) continue;
    const fullPath = path.join(root, entry.name);
    try {
      const info = await fs.stat(fullPath);
      let size = info.size;
      let modified = info.mtimeMs;
      for (const suffix of ["-wal", "-journal"]) {
        try {
          const companion = await fs.stat(fullPath + suffix);
          if (companion.size) {
            size += companion.size;
            modified = Math.max(modified, companion.mtimeMs);
          }
        } catch (error) { ignoreMissingEntry(error); }
      }
      const id = entry.name.slice(0, -3);
      refs.push({
        id, agent: "antigravity", title: id, path: fullPath, size,
        updatedAt: new Date(modified).toISOString(),
        ...(size > info.size ? { active: true } : {}),
      });
    } catch (error) { ignoreMissingEntry(error); }
  }

  return refs;
}

async function listAntigravityLocalSessions(limit = 60): Promise<LocalSessionRef[]> {
  const stores = await Promise.all(["antigravity", "antigravity-cli"].map(
    name => listStore(path.join(sessionRoot(), name, "conversations")),
  ));
  return stores.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

export const antigravity: DriverPlugin = {
  id: "antigravity", command: "agy", verifiedVersions: ["1.5.11", "1.5.14"],
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
      if (record.event === "init") return [{ type: "session", id: string(record.conversation_id) },
        ...(isRecord(record.init) && typeof record.init.model === "string" ? [{type:"model" as const,model:record.init.model}] : [])];
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
          const info = isRecord(step.tool_info) ? step.tool_info : {};
          const failed = state === "ERROR" || info.error != null;
          if (failed) failedTool = name;
          else if (state === "DONE") failedTool = undefined;
          const results = [
            ...(info.output !== undefined ? [{text:wireText(info.output), ...(failed ? {failed:true} : {})}] : []),
            ...(info.error != null ? [{text:wireText(info.error),failed:true}] : []),
          ];
          const details = Object.fromEntries(Object.entries(step).filter(([key]) => ![
            "conversation_id","step_type","step_index","tool_name","state","tool_info",
          ].includes(key)));
          const extra = Object.fromEntries(Object.entries(info).filter(([key]) => !["name","parameters","output","error"].includes(key)));
          if (Object.keys(extra).length) details.tool_info = extra;
          events.push({type:"tool",name,state:failed ? "ERROR" : state,...(typeof step.step_index === "number" ? {id:"step-" + step.step_index} : {}),
            ...(info.parameters !== undefined ? {argumentsText:wireText(info.parameters)} : {}),
            ...(results.length ? {results} : {}),
            ...(Object.keys(details).length ? {details:wireText(details)} : {})});
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
        return [...events, ...usage(result.usage).map(e => e.type === "usage" ? {...e,scope:"session" as const} : e), { type: "done" }];
      }
      throw driverError("Unsupported Antigravity event: " + record.event);
    };
  },
  listModels: listAntigravityModels,
  localSessionsRoot: sessionRoot,
  listLocalSessions: listAntigravityLocalSessions,
};
