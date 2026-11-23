import { parseWireJson } from "@coverse/core";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AdapterRegistry,
  AdapterUnavailableError,
  convertSession,
  emptyLedger,
  SessionError,
  validateFileSet,
  verifyInjectionBundle,
  type CSR,
  type FileSet,
  type LossLedger,
  type ProtocolUsage,
  type SessionAdapter,
  type SessionDiagnostic,
  type Turn,
} from "@coverse/core";
import { createDriverRegistry, unchangedSession, type AgentDriver, type DriverRegistry, type Executable } from "@coverse/drivers";
import type {
  AppSettings,
  BundleDetailResponse,
  BundleFileEntry,
  BundleStatistics,
  CapabilitiesResponse,
  ChatMessage,
  ConvertRequest,
  FilePreview,
  HandoffMetadata,
  InspectCandidate,
  InspectPreview,
  InspectResponse,
  LocalSessionRef,
  LossCounts,
  ModelOption,
  StreamEventPayload,
  ToolActivity,
  UiSession,
  UploadedFilePayload,
} from "../shared/types.js";
import { UiStore } from "./store.js";

const SESSION_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function sameLocalPath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function nowIso(): string {
  return new Date().toISOString();
}

function localResumeId(adapter: SessionAdapter, session: CSR, sourcePath: string) {
  const id = adapter.localResumeId ? adapter.localResumeId(session, sourcePath) : session.meta.id;
  return id && SESSION_UUID.test(id) ? id : undefined;
}

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function summarizeTitle(text: string, fallback: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return fallback;
  return firstLine.length > 56 ? firstLine.slice(0, 56).trimEnd() + "…" : firstLine;
}

function countLedger(ledger: LossLedger): LossCounts {
  return {
    dropped: ledger.dropped.length,
    downgraded: ledger.downgraded.length,
    approximated: ledger.approximated.length,
  };
}

function normalizePathValue(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let value = raw.trim();
  if (!value) return undefined;
  if (value.startsWith("file:")) {
    try {
      const url = new URL(value);
      const windows = Boolean(url.hostname && url.hostname !== "localhost") || /^\/[a-z](?::|%3a)\//i.test(url.pathname);
      value = fileURLToPath(url, { windows });
    } catch {
      return undefined;
    }
  }
  if (/^\\\\\?\\UNC\\/i.test(value)) return "\\\\" + value.slice(8);
  if (/^\\\\\?\\[a-z]:\\/i.test(value)) return value.slice(4);
  // Catalogs written by older builds decoded an escaped drive colon as a POSIX path.
  if (process.platform === "win32" && /^\/[a-z]:\//i.test(value)) return value.slice(1);
  return value;
}

function projectDirectory(raw: string | undefined, localOnly = false): string | undefined {
  const value = normalizePathValue(raw);
  if (!value) return undefined;
  const windows = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(value);
  if (localOnly && windows !== (process.platform === "win32")) return undefined;
  if (windows) return path.win32.resolve(value);
  return path.posix.isAbsolute(value) ? path.posix.resolve(value) : undefined;
}

async function resolveExistingDirectory(candidate: string | undefined): Promise<string | undefined> {
  const normalized = normalizePathValue(candidate);
  if (!normalized) return undefined;
  if (projectDirectory(normalized) && !projectDirectory(normalized, true)) return undefined;
  try {
    const info = await fs.stat(normalized);
    if (info.isDirectory()) return await fs.realpath(normalized);
  } catch {
    return undefined;
  }
  return undefined;
}

function statUnchanged(
  a: Awaited<ReturnType<typeof fs.lstat>>,
  b: Awaited<ReturnType<typeof fs.lstat>>,
): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function existsLstat(filename: string) {
  try {
    return await fs.lstat(filename);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Convert CSR turns into clean historical user/assistant ChatMessages so converted
 * sessions immediately display readable conversation history in the main thread.
 */
export function csrTurnsToChatMessages(
  turns: readonly Turn[],
  sourceAgent: string,
  timestampFallback: string,
  transcript?: CSR["transcript"],
): ChatMessage[] {
  if (transcript) return transcript.map(m => ({
    id: m.id, role: m.role, content: m.text, createdAt: m.createdAt ?? timestampFallback, historical: true,
    ...(m.role === "assistant" ? {agent: sourceAgent} : {}), ...(m.activity ? {reasoning: m.activity} : {}),
    ...(m.changedFiles ? {changedFiles: m.changedFiles} : {}),
    ...(m.durationMs !== undefined ? {durationMs: m.durationMs} : {}),
  }));
  const messages: ChatMessage[] = [];
  const toolCallIndex = new Map<string, { message: ChatMessage; toolIdx: number }>();

  const appendAssistant = (
    textParts: string[],
    reasoningParts: string[],
    tools: ToolActivity[],
    callIds: string[],
  ) => {
    const text = textParts.join("\n\n").trim();
    const reasoning = reasoningParts.join("\n\n").trim();
    if (!text && !reasoning && tools.length === 0) return;

    // Merge consecutive tool-only or text-after-tool assistant records cleanly
    const prev = messages.at(-1);
    if (prev && prev.role === "assistant" && prev.historical && !prev.content && prev.tools && text && tools.length === 0) {
      prev.content = text;
      if (reasoning) prev.reasoning = prev.reasoning ? `${prev.reasoning}\n\n${reasoning}` : reasoning;
      return;
    }

    const msg: ChatMessage = {
      id: makeId("hist"),
      role: "assistant",
      content: text,
      createdAt: timestampFallback,
      agent: sourceAgent,
      historical: true,
      ...(reasoning ? { reasoning } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    };
    messages.push(msg);
    if (msg.tools) {
      callIds.forEach((callId, idx) => {
        if (callId) toolCallIndex.set(callId, { message: msg, toolIdx: idx });
      });
    }
  };

  for (const turn of turns) {
    if (turn.role === "system" || turn.role === "developer") continue;

    if (turn.role === "user") {
      const parts: string[] = [];
      for (const block of turn.content) {
        if (block.type === "text" && block.text.trim()) parts.push(block.text.trim());
        else if (block.type === "attachment") parts.push(`[${block.path}]`);
        else if (block.type === "image") parts.push(`[image: ${block.url}]`);
      }
      const text = parts.join("\n\n").trim();
      if (text) {
        messages.push({
          id: makeId("hist"),
          role: "user",
          content: text,
          createdAt: timestampFallback,
          historical: true,
        });
      }
      continue;
    }

    if (turn.role === "assistant") {
      const textParts: string[] = [];
      const reasoningParts: string[] = [];
      const tools: ToolActivity[] = [];
      const callIds: string[] = [];

      for (const block of turn.content) {
        if (block.type === "text" && block.text.trim()) {
          textParts.push(block.text.trim());
        } else if (block.type === "reasoning" && block.text.trim()) {
          reasoningParts.push(block.text.trim());
        } else if (block.type === "tool_call") {
          tools.push({ name: block.name, state: "called", timestamp: timestampFallback });
          callIds.push(block.id);
        } else if (block.type === "tool_result") {
          const linked = toolCallIndex.get(block.callId);
          if (linked && linked.message.tools?.[linked.toolIdx]) {
            linked.message.tools[linked.toolIdx]!.state = block.isError ? "failed" : "completed";
          } else {
            tools.push({
              name: block.callId,
              state: block.isError ? "failed" : "completed",
              timestamp: timestampFallback,
            });
            callIds.push("");
          }
        } else if (block.type === "attachment") {
          textParts.push(`[${block.path}]`);
        }
      }
      appendAssistant(textParts, reasoningParts, tools, callIds);
      continue;
    }

    if (turn.role === "tool") {
      for (const block of turn.content) {
        if (block.type === "tool_result") {
          const linked = toolCallIndex.get(block.callId);
          if (linked && linked.message.tools?.[linked.toolIdx]) {
            linked.message.tools[linked.toolIdx]!.state = block.isError ? "failed" : "completed";
          }
        }
      }
    }
  }

  return messages;
}

export async function loadPathsAsFileSet(inputPaths: readonly string[]): Promise<FileSet> {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new SessionError("INVALID_INPUT", "/paths", "At least one file path is required");
  }

  async function inventory() {
    const found: { absolute: string; relative: string }[] = [];
    const seen = new Set<string>();

    async function add(absolute: string, relative: string): Promise<void> {
      const info = await fs.lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new SessionError("INVALID_INPUT", relative, "Symlink inputs are not stable snapshots");
      }
      if (info.isDirectory()) {
        for (const entry of (await fs.readdir(absolute)).sort()) {
          await add(path.join(absolute, entry), relative ? `${relative}/${entry}` : entry);
        }
      } else if (info.isFile()) {
        const real = await fs.realpath(absolute);
        const key = process.platform === "win32" ? real.toLowerCase() : real;
        if (seen.has(key)) throw new SessionError("INVALID_INPUT", relative, "An input file was supplied more than once");
        seen.add(key);
        found.push({ absolute, relative });
      } else {
        throw new SessionError("INVALID_INPUT", relative, "Input must contain only regular files");
      }
    }

    for (const rawInput of inputPaths) {
      const absolute = path.resolve(rawInput);
      const info = await existsLstat(absolute);
      if (!info) {
        throw new SessionError("INVALID_INPUT", rawInput, `Input does not exist: ${rawInput}`);
      }
      await add(absolute, info.isDirectory() ? "" : path.basename(absolute));
      if (info.isFile() && absolute.endsWith(".db")) {
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          const companion = absolute + suffix;
          if (await existsLstat(companion)) {
            const real = await fs.realpath(companion);
            const key = process.platform === "win32" ? real.toLowerCase() : real;
            if (!seen.has(key)) await add(companion, path.basename(companion));
          }
        }
      }
    }
    return found;
  }

  const inventoryBefore = await inventory();
  if (inventoryBefore.length === 0) {
    throw new SessionError("INVALID_INPUT", "/input", "No input files found");
  }
  const before = await Promise.all(inventoryBefore.map((f) => fs.lstat(f.absolute)));
  const files: { path: string; bytes: Uint8Array }[] = [];
  for (const [i, file] of inventoryBefore.entries()) {
    const handle = await fs.open(file.absolute, "r");
    try {
      const openedBefore = await handle.stat();
      if (openedBefore.size !== before[i]!.size || openedBefore.mtimeMs !== before[i]!.mtimeMs) {
        throw new SessionError("UNSTABLE_INPUT", file.relative, "Input changed before reading");
      }
      files.push({ path: file.relative, bytes: new Uint8Array(await handle.readFile()) });
      if (!statUnchanged(openedBefore, await handle.stat())) {
        throw new SessionError("UNSTABLE_INPUT", file.relative, "Input changed while reading");
      }
    } finally {
      await handle.close();
    }
  }
  const inventoryAfter = await inventory();
  if (JSON.stringify(inventoryBefore) !== JSON.stringify(inventoryAfter)) {
    throw new SessionError("UNSTABLE_INPUT", "/input", "Input file set changed while reading");
  }
  for (const [i, file] of inventoryBefore.entries()) {
    if (!statUnchanged(before[i]!, await fs.lstat(file.absolute))) {
      throw new SessionError("UNSTABLE_INPUT", file.relative, "Input changed while capturing file set");
    }
  }
  try {
    validateFileSet(files);
  } catch {
    throw new SessionError(
      "INVALID_INPUT",
      "/input",
      "Input paths collide or are not portable; select a directory to preserve relative paths",
    );
  }
  return files;
}

export function decodeUploadedFiles(uploads: readonly UploadedFilePayload[]): FileSet {
  if (!Array.isArray(uploads) || uploads.length === 0) {
    throw new SessionError("INVALID_INPUT", "/files", "At least one file is required");
  }
  const files = uploads.map((entry, index) => {
    if (!entry || typeof entry.path !== "string" || typeof entry.contentBase64 !== "string") {
      throw new SessionError("INVALID_INPUT", `/files/${index}`, "Expected path and base64 content");
    }
    const normalizedPath = entry.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const bytes = new Uint8Array(Buffer.from(entry.contentBase64, "base64"));
    return { path: normalizedPath, bytes };
  });
  try {
    validateFileSet(files);
  } catch (error) {
    throw new SessionError(
      "INVALID_INPUT",
      "/files",
      error instanceof Error ? error.message : "Invalid file set paths",
    );
  }
  return files;
}

export function toDiagnostic(error: unknown, fallbackPath = "/ipc"): SessionDiagnostic {
  if (error instanceof SessionError) return error.diagnostic;
  if (error instanceof AdapterUnavailableError) {
    return { code: error.code, path: fallbackPath, message: error.message, severity: "error" };
  }
  return {
    code: "INTERNAL_ERROR",
    path: fallbackPath,
    message: error instanceof Error ? error.message : "Unexpected error",
    severity: "error",
  };
}

export class UiService {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly modelCache = new Map<string, ModelOption[]>();
  private readonly catalogScans = new Map<string, Promise<LocalSessionRef[]>>();
  private readonly registrations = new Map<string, Promise<UiSession>>();
  private readonly customDriversInjected: boolean;
  private drivers: DriverRegistry;

  constructor(
    readonly adapters: AdapterRegistry,
    drivers: DriverRegistry | null,
    readonly store: UiStore,
    readonly defaultCwd: string,
  ) {
    this.customDriversInjected = drivers !== null;
    this.drivers = drivers ?? createDriverRegistry();
  }

  private async ensureDriversConfigured(): Promise<DriverRegistry> {
    if (this.customDriversInjected) return this.drivers;
    const settings = await this.store.getSettings();
    const overrides: Record<string, Executable> = {};
    for (const [id, execPath] of Object.entries(settings.driverExecutables)) {
      if (execPath.trim()) {
        overrides[id] = { command: execPath.trim() };
      }
    }
    this.drivers = createDriverRegistry(overrides);
    return this.drivers;
  }

  getSettings(): Promise<AppSettings> {
    return this.store.getSettings();
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.store.getSettings();
    const next: AppSettings = {
      theme: patch.theme === "light" || patch.theme === "dark" ? patch.theme : current.theme,
      language: patch.language === "zh-CN" || patch.language === "en" ? patch.language : current.language,
      disabledAdapters: Array.isArray(patch.disabledAdapters)
        ? [...new Set(patch.disabledAdapters.filter((v): v is string => typeof v === "string"))]
        : current.disabledAdapters,
      driverExecutables:
        patch.driverExecutables && typeof patch.driverExecutables === "object"
          ? Object.fromEntries(
              Object.entries(patch.driverExecutables)
                .map(([k, v]): [string, string] => [k, typeof v === "string" ? v.trim() : ""])
                .filter(([, v]) => v.length > 0),
            )
          : current.driverExecutables,
    };
    await this.store.saveSettings(next);
    this.modelCache.clear();
    if (!this.customDriversInjected) {
      await this.ensureDriversConfigured();
    }
    return next;
  }

  async getCapabilities(refresh = false): Promise<CapabilitiesResponse> {
    if (refresh) this.modelCache.clear();
    const settings = await this.store.getSettings();
    const disabled = new Set(settings.disabledAdapters);
    const registry = await this.ensureDriversConfigured();

    const adapters = this.adapters.list().map((adapter) => ({
      id: adapter.id,
      displayName: adapter.displayName,
      status: adapter.status,
      enabled: !disabled.has(adapter.id),
      supportedVersions: adapter.supportedVersions,
      capabilities: adapter.capabilities,
    }));

    const drivers = await Promise.all(
      registry.list().map(async (driver) => {
        const probed = await driver.probe();
        let models = this.modelCache.get(driver.id);
        if (!models) {
          models = await driver.listModels();
          this.modelCache.set(driver.id, models);
        }
        const customExec = settings.driverExecutables[driver.id];
        return {
          ...probed,
          ...(customExec ? { customExecutablePath: customExec } : {}),
          models,
        };
      }),
    );

    return { adapters, drivers, defaultCwd: this.defaultCwd };
  }

  async listLocalSessions(agent?: string, cachedOnly = false): Promise<LocalSessionRef[]> {
    const { disabledAdapters } = await this.store.getSettings();
    const enabled = this.adapters.list().filter(adapter =>
      adapter.capabilities.import && !disabledAdapters.includes(adapter.id) && (!agent || adapter.id === agent),
    ).map(adapter => adapter.id);
    const targets = this.drivers.list().filter(driver => enabled.includes(driver.id));
    const batches = await Promise.all(targets.map(driver => cachedOnly
      ? this.store.readLocalCatalog(driver.id, driver.plugin.localSessionsRoot?.())
      : this.refreshCatalog(driver)));
    return batches.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private refreshCatalog(driver: AgentDriver): Promise<LocalSessionRef[]> {
    const running = this.catalogScans.get(driver.id);
    if (running) return running;
    const scan = this.scanCatalog(driver).finally(() => this.catalogScans.delete(driver.id));
    this.catalogScans.set(driver.id, scan);
    return scan;
  }

  private async scanCatalog(driver: AgentDriver): Promise<LocalSessionRef[]> {
    const adapter = this.adapters.get(driver.id);
    const root = driver.plugin.localSessionsRoot?.();
    const previous = await this.store.readLocalCatalog(driver.id, root);
    const cache = new Map(previous.map(item => [item.path, item]));
    const sessions = await driver.listLocalSessions(Infinity, cache);
    let changed = previous.length !== sessions.length;
    for (const session of sessions) {
      const cached = unchangedSession(cache, session.path, session.size, session.updatedAt);
      let cwd = session.cwd;
      if (cached && cached.active === session.active) {
        cwd ??= cached.cwd;
      } else if (!cwd && adapter.readProjectDirectory) {
        try {
          cwd = await adapter.readProjectDirectory(await loadPathsAsFileSet([session.path]));
        } catch {
          // Keep unstable or unrecognized records selectable for individual inspection.
        }
      }
      if (cwd) session.cwd = projectDirectory(cwd) ?? cwd;
      if (!cached || cached.id !== session.id || cached.title !== session.title ||
          cached.cwd !== session.cwd || cached.active !== session.active || cached.parentSessionId !== session.parentSessionId) changed = true;
    }
    if (changed) await this.store.saveLocalCatalog(driver.id, sessions, root);
    return sessions;
  }

  listSessions(): Promise<UiSession[]> {
    return this.store.listSessions();
  }

  async previewFile(id: unknown, reference: unknown, scope: unknown): Promise<FilePreview> {
    if (typeof id !== "string" || typeof reference !== "string" || !reference ||
        (scope !== "project" && scope !== "bundle")) throw new Error("Invalid file reference");
    const session = await this.getSession(id);
    const bundle = session.handoff;
    if (scope === "bundle" && !bundle?.files.some(file => file.path === reference)) {
      throw new Error("File is not part of this conversation archive");
    }
    const root = await fs.realpath(scope === "project" ? session.cwd : this.store.bundlePath(bundle!.bundleId));
    const value = normalizePathValue(reference);
    if (!value) throw new Error("Invalid file path");
    const candidate = path.resolve(root, value);
    const inside = (p: string) => {
      const relative = path.relative(root, p);
      return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
    };
    if (!inside(candidate)) throw new Error("File is outside this conversation's project");
    const target = await fs.realpath(candidate);
    if (!inside(target)) throw new Error("File is outside this conversation's project");
    const stat = await fs.stat(target);
    const display = path.relative(root, target) || ".";
    if (stat.isDirectory()) {
      const entries = await fs.readdir(target, {withFileTypes: true});
      return {kind: "directory", path: display, entries: entries.map(entry => entry.name + (entry.isDirectory() ? "/" : "")).sort()};
    }
    if (!stat.isFile()) throw new Error("Cannot preview this file type");
    if (stat.size > 8 * 1024 * 1024) throw new Error("File exceeds the 8 MiB preview limit");
    const bytes = await fs.readFile(target);
    if (bytes.includes(0)) throw new Error("Binary file has no text preview");
    return {kind: "text", path: display, content: new TextDecoder("utf-8", {fatal: true}).decode(bytes)};
  }

  async getSession(id: string, refreshLegacyDisplay = false): Promise<UiSession> {
    const session = await this.store.getSession(id);
    if (!session) throw new SessionError("NOT_FOUND", `/sessions/${id}`, `Session not found: ${id}`);
    const ref = session.reference;
    if (refreshLegacyDisplay && ref && !ref.displayVersion && session.messages.every(m => m.historical)) {
      const adapter = this.adapters.get(ref.agent);
      const paths = [ref.sourcePath];
      const imported = await adapter.import(await this.prepareImport(adapter, await loadPathsAsFileSet(paths), paths));
      if (imported.session.meta.id !== (ref.sourceSessionId ?? session.targetSessionId)) throw new SessionError("INVALID_INPUT", "/reference", "The file now belongs to a different conversation.");
      const messages = imported.session.transcript
        ? csrTurnsToChatMessages(imported.session.turns, ref.agent, session.createdAt, imported.session.transcript)
        : session.messages;
      return this.store.mutateSession(id, current => {
        if (current.reference?.sourcePath !== ref.sourcePath || current.reference.displayVersion || current.targetSessionId !== session.targetSessionId ||
            !current.messages.every(m => m.historical)) return current;
        return {...current, messages, reference: {...current.reference, displayVersion: 1}};
      });
    }
    return session;
  }

  async createSession(input: {
    agent: string;
    model?: string;
    cwd?: string;
    title?: string;
  }): Promise<UiSession> {
    const registry = await this.ensureDriversConfigured();
    registry.get(input.agent);
    const resolvedCwd = input.cwd
      ? (await resolveExistingDirectory(input.cwd)) ??
        (() => {
          throw new SessionError("INVALID_INPUT", "/cwd", `Directory does not exist: ${input.cwd}`);
        })()
      : this.defaultCwd;
    const timestamp = nowIso();
    const trimmedModel = input.model?.trim();
    const session: UiSession = {
      id: makeId("ses"),
      title: input.title?.trim() || "New session",
      agent: input.agent,
      ...(trimmedModel ? { model: trimmedModel } : {}),
      cwd: resolvedCwd,
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.store.upsertSession(session);
  }

  async updateSession(
    id: string,
    patch: { title?: string; model?: string | null; cwd?: string; agent?: string },
  ): Promise<UiSession> {
    const existing = await this.getSession(id);
    let nextCwd = existing.cwd;
    if (patch.cwd !== undefined) {
      const resolved = await resolveExistingDirectory(patch.cwd);
      if (!resolved) {
        throw new SessionError("INVALID_INPUT", "/cwd", `Directory does not exist: ${patch.cwd}`);
      }
      nextCwd = resolved;
    }
    let nextAgent = existing.agent;
    if (patch.agent !== undefined && patch.agent !== existing.agent) {
      if (existing.targetSessionId || existing.handoff) {
        throw new SessionError(
          "INVALID_INPUT",
          "/agent",
          "Active sessions switch agents via handoff to preserve context and ledger honesty",
        );
      }
      const registry = await this.ensureDriversConfigured();
      registry.get(patch.agent);
      nextAgent = patch.agent;
    }
    return this.store.mutateSession(id, (session) => {
      const updated: UiSession = {
        ...session,
        title: patch.title !== undefined ? patch.title.trim() || session.title : session.title,
        agent: nextAgent,
        cwd: nextCwd,
        updatedAt: nowIso(),
      };
      if (patch.model === null || patch.model === "") {
        delete updated.model;
      } else if (patch.model !== undefined) {
        updated.model = patch.model.trim();
      }
      return updated;
    });
  }

  async deleteSession(id: string): Promise<void> {
    this.abortRun(id);
    const removed = await this.store.deleteSession(id);
    if (!removed) throw new SessionError("NOT_FOUND", `/sessions/${id}`, `Session not found: ${id}`);
  }

  private async resolveInputFileSet(input: {
    paths?: readonly string[];
    files?: readonly UploadedFilePayload[];
  }): Promise<FileSet> {
    if (input.paths && input.paths.length > 0) {
      return loadPathsAsFileSet(input.paths);
    }
    if (input.files && input.files.length > 0) {
      return decodeUploadedFiles(input.files);
    }
    throw new SessionError("INVALID_INPUT", "/input", "At least one file or path is required");
  }

  private async prepareImport(adapter: SessionAdapter, files: FileSet, paths?: readonly string[]) {
    if (!adapter.prepareLocalImport || paths?.length !== 1) return files;
    return adapter.prepareLocalImport(files, async id => {
      const catalog = await this.listLocalSessions(adapter.id);
      if (!catalog.some(row => sameLocalPath(row.path, paths[0]!))) {
        throw new SessionError("MISSING_RELATED_RECORD", "/input", "Select the fork in its native session catalog to resolve its parent.");
      }
      const matches = catalog.filter(row => row.id === id);
      if (matches.length !== 1) throw new SessionError("MISSING_RELATED_RECORD", "/input", "Cannot uniquely locate parent session " + id);
      return loadPathsAsFileSet([matches[0]!.path]);
    });
  }

  async inspectSource(input: {
    paths?: readonly string[];
    files?: readonly UploadedFilePayload[];
  }): Promise<InspectResponse> {
    const files = await this.resolveInputFileSet(input);
    const settings = await this.store.getSettings();
    const disabled = new Set(settings.disabledAdapters);
    const importable = this.adapters
      .list()
      .filter((adapter) => adapter.capabilities.import && !disabled.has(adapter.id));

    const evaluated = await Promise.all(
      importable.map(async (adapter) => {
        const result = await adapter.detect(files);
        if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
          throw new SessionError("INVALID_BUNDLE", "/detection", `Adapter ${adapter.id} returned invalid confidence`);
        }
        return { adapter, result };
      }),
    );
    evaluated.sort((a, b) => b.result.confidence - a.result.confidence);
    const candidates: InspectCandidate[] = evaluated.map(({ adapter, result }) => ({
      id: adapter.id,
      displayName: adapter.displayName,
      confidence: result.confidence,
      ...(result.formatVersion !== undefined ? { formatVersion: result.formatVersion } : {}),
      ...(result.diagnostics !== undefined ? { diagnostics: result.diagnostics } : {}),
    }));
    const first = evaluated[0];
    const second = evaluated[1];
    const ambiguous = Boolean(
      first && second && first.result.confidence >= 0.9 && second.result.confidence === first.result.confidence,
    );
    const detected = first && first.result.confidence >= 0.9 && !ambiguous ? first.adapter : null;

    let preview: InspectPreview | undefined;
    let previewError: SessionDiagnostic | undefined;
    if (detected) {
      try {
        const imported = await detected.import(await this.prepareImport(detected, files, input.paths));
        const resolvedLocalCwd = await resolveExistingDirectory(imported.session.meta.cwd);
        const opaqueCounts = new Map<string, number>();
        for (const turn of imported.session.turns) {
          for (const block of turn.content) {
            if (block.type === "opaque") {
              opaqueCounts.set(block.source, (opaqueCounts.get(block.source) ?? 0) + 1);
            } else if (block.type === "unknown") {
              opaqueCounts.set("unknown", (opaqueCounts.get("unknown") ?? 0) + 1);
            }
          }
        }
        const opaqueBlocks = [...opaqueCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([source, count]) => ({ source, count }));
        const canReference = Boolean(
          input.paths &&
            input.paths.length === 1 &&
            localResumeId(detected, imported.session, input.paths[0]!) &&
            (resolvedLocalCwd !== undefined || !imported.session.meta.cwd),
        );
        preview = {
          id: imported.session.meta.id,
          agent: imported.session.meta.agent,
          agentFormatVersion: imported.session.meta.agentFormatVersion,
          turns: imported.session.transcript?.filter(m => m.role === "user").length ?? imported.session.turns.length,
          ...(resolvedLocalCwd ? { cwd: resolvedLocalCwd } : {}),
          ...(imported.session.meta.cwd ? { sourceCwd: imported.session.meta.cwd } : {}),
          ...(imported.session.meta.model ? { model: imported.session.meta.model } : {}),
          ...(imported.session.meta.createdAt ? { createdAt: imported.session.meta.createdAt } : {}),
          canReference,
          ...(opaqueBlocks.length > 0 ? { opaqueBlocks } : {}),
          losses: countLedger(imported.ledger),
        };
      } catch (error) {
        previewError = toDiagnostic(error, "/inspect");
      }
    }

    return {
      candidates,
      detected: detected ? detected.id : null,
      ambiguous,
      ...(preview ? { preview } : {}),
      ...(previewError ? { previewError } : {}),
    };
  }

  private async detectSourceAdapter(files: FileSet, disabled: Set<string>): Promise<SessionAdapter> {
    const candidates = await Promise.all(
      this.adapters
        .list()
        .filter((adapter) => adapter.capabilities.import && !disabled.has(adapter.id))
        .map(async (adapter) => ({ adapter, result: await adapter.detect(files) })),
    );
    candidates.sort((a, b) => b.result.confidence - a.result.confidence);
    const first = candidates[0];
    if (!first || first.result.confidence < 0.9) {
      throw new SessionError(
        "UNSUPPORTED_FORMAT",
        "/input",
        "No verified source format detected; select source adapter explicitly for format diagnostics",
      );
    }
    if (candidates[1]?.result.confidence === first.result.confidence) {
      throw new SessionError("AMBIGUOUS_INPUT", "/input", "Multiple adapters match; select source adapter explicitly");
    }
    return first.adapter;
  }

  private async persistBundleAsSession(input: {
    artifacts: FileSet;
    target: SessionAdapter;
    from: string;
    fromFormat: string;
    sourceCwd?: string;
    requestedCwd?: string;
    model?: string;
    title: string;
    sourceSessionId?: string;
    initialMessages?: ChatMessage[];
    nativeTranscript?: boolean;
  }): Promise<UiSession> {
    verifyInjectionBundle(input.artifacts, input.target.id);

    const reportBytes = input.artifacts.find((item) => item.path === "report.json")?.bytes;
    const manifestBytes = input.artifacts.find((item) => item.path === "manifest.json")?.bytes;
    if (!reportBytes || !manifestBytes) {
      throw new SessionError("INVALID_BUNDLE", "/bundle", "Verified bundle missing report or manifest");
    }
    const report = JSON.parse(new TextDecoder().decode(reportBytes)) as {
      ledger: LossLedger;
      diagnostics: SessionDiagnostic[];
      statistics: BundleStatistics;
    };
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
      files: BundleFileEntry[];
    };

    let resolvedCwd: string;
    if (input.requestedCwd?.trim()) {
      const explicit = await resolveExistingDirectory(input.requestedCwd);
      if (!explicit) {
        throw new SessionError("INVALID_INPUT", "/cwd", `Directory does not exist: ${input.requestedCwd}`);
      }
      resolvedCwd = explicit;
    } else {
      resolvedCwd = (await resolveExistingDirectory(input.sourceCwd)) ?? this.defaultCwd;
    }

    const bundleId = makeId("bnd");
    const bundlePath = await this.store.saveBundle(bundleId, input.artifacts);
    const handoff: HandoffMetadata = {
      bundleId,
      bundlePath,
      from: input.from,
      fromFormat: input.fromFormat,
      to: input.target.id,
      nativeResume: false,
      statistics: report.statistics,
      losses: countLedger(report.ledger),
      ledger: report.ledger,
      diagnostics: report.diagnostics ?? [],
      files: manifest.files,
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(process.platform === "win32" && input.target.publishDesktopSession && input.nativeTranscript ? {desktopFirst: true} : {}),
    };

    const timestamp = nowIso();
    const trimmedModel = input.model?.trim();
    const session: UiSession = {
      id: makeId("ses"),
      title: input.title,
      agent: input.target.id,
      ...(trimmedModel ? { model: trimmedModel } : {}),
      cwd: resolvedCwd,
      bundlePending: true,
      handoff,
      messages: input.initialMessages ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.store.upsertSession(session);
  }

  async convertSource(request: ConvertRequest): Promise<UiSession> {
    const files = await this.resolveInputFileSet({
      ...(request.paths ? { paths: request.paths } : {}),
      ...(request.files ? { files: request.files } : {}),
    });
    const settings = await this.store.getSettings();
    const disabled = new Set(settings.disabledAdapters);
    if (disabled.has(request.to)) {
      throw new SessionError("ADAPTER_DISABLED", `/adapters/${request.to}`, `Target adapter is disabled in settings: ${request.to}`);
    }
    const target = this.adapters.get(request.to);
    const registry = await this.ensureDriversConfigured();
    registry.get(target.id);

    const source =
      request.from === "auto"
        ? await this.detectSourceAdapter(files, disabled)
        : (() => {
            if (disabled.has(request.from)) {
              throw new SessionError(
                "ADAPTER_DISABLED",
                `/adapters/${request.from}`,
                `Source adapter is disabled in settings: ${request.from}`,
              );
            }
            return this.adapters.get(request.from);
          })();

    const destination = (recordedCwd?: string) => {
      if (!request.useSourceProject) return request.cwd;
      const cwd = projectDirectory(recordedCwd ?? request.cwd, true);
      if (!cwd) throw new SessionError("PROJECT_REQUIRED", "/cwd", "Open the session individually to select its local project folder.");
      return cwd;
    };
    // Reference-only import (zero copy, zero bundle) when format AND project path are unchanged
    if (source.id === target.id && request.paths && request.paths.length === 1) {
      const imported = await source.import(await this.prepareImport(source, files, request.paths));
      const sourceLocalCwd = await resolveExistingDirectory(imported.session.meta.cwd);
      const requestedCwd = destination(imported.session.meta.cwd);
      const requestedLocalCwd = requestedCwd?.trim()
        ? await resolveExistingDirectory(requestedCwd)
        : undefined;
      if (requestedCwd?.trim() && !requestedLocalCwd) {
        throw new SessionError("INVALID_INPUT", "/cwd", `Directory does not exist: ${requestedCwd}`);
      }
      const effectiveCwd = requestedLocalCwd ?? sourceLocalCwd ?? this.defaultCwd;
      const pathUnchanged = sourceLocalCwd
        ? sameLocalPath(effectiveCwd, sourceLocalCwd)
        : !imported.session.meta.cwd;

      const resumeId = localResumeId(source, imported.session, request.paths[0]!);
      if (pathUnchanged && resumeId) {
        const firstUserText = imported.session.turns
          .find((turn) => turn.role === "user")
          ?.content.find((block) => block.type === "text");
        const defaultTitle =
          firstUserText && firstUserText.type === "text"
            ? summarizeTitle(firstUserText.text, imported.session.meta.id.slice(0, 12))
            : imported.session.meta.id.slice(0, 12);
        const messages = csrTurnsToChatMessages(
          imported.session.turns,
          source.id,
          imported.session.meta.createdAt ?? nowIso(),
          imported.session.transcript,
        );
        const sourcePath = path.resolve(request.paths[0]!);
        const existingList = await this.store.listSessions();
        const existingRef = existingList.find(
          (item) =>
            item.reference &&
            item.agent === source.id &&
            sameLocalPath(item.cwd, effectiveCwd) &&
            (item.targetSessionId === resumeId || (sameLocalPath(item.reference.sourcePath, request.paths![0]!) &&
              item.targetSessionId === imported.session.meta.id)),
        );
        const trimmedModel = request.model?.trim() || imported.session.meta.model;
        const timestamp = nowIso();
        const refSession: UiSession = {
          id: existingRef?.id ?? makeId("ses"),
          title: request.title?.trim() || existingRef?.title || defaultTitle,
          agent: source.id,
          ...(trimmedModel ? { model: trimmedModel } : {}),
          cwd: effectiveCwd,
          targetSessionId: resumeId,
          bundlePending: false,
          reference: {
            sourceSessionId: imported.session.meta.id,
            displayVersion: 1,
            sourcePath,
            agent: source.id,
            formatVersion: imported.session.meta.agentFormatVersion,
            originalCwd: effectiveCwd,
          },
          messages,
          createdAt: existingRef?.createdAt ?? imported.session.meta.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        return this.store.upsertSession(refSession);
      }
    }

    const result = await convertSession({
      source,
      target,
      artifacts: await this.prepareImport(source, files, request.paths),
      ...(request.omitOpaque ? { lossPolicy: { omitOpaque: true } } : {}),
    });
    const firstUserText = result.session.turns
      .find((turn) => turn.role === "user")
      ?.content.find((block) => block.type === "text");
    const defaultTitle =
      firstUserText && firstUserText.type === "text"
        ? summarizeTitle(firstUserText.text, `${source.id} → ${target.id}`)
        : `${source.id} → ${target.id}`;
    const initialMessages = csrTurnsToChatMessages(
      result.session.turns,
      source.id,
      result.session.meta.createdAt ?? nowIso(),
      result.session.transcript,
    );

    const requestedCwd = destination(result.session.meta.cwd);
    const created = await this.persistBundleAsSession({
      artifacts: result.artifacts,
      target,
      from: source.id,
      fromFormat: result.session.meta.agentFormatVersion,
      ...(result.session.meta.cwd ? { sourceCwd: result.session.meta.cwd } : {}),
      ...(requestedCwd ? { requestedCwd } : {}),
      ...(request.model ? { model: request.model } : {}),
      title: request.title?.trim() || defaultTitle,
      initialMessages,
      nativeTranscript: !!result.session.transcript,
    });

    if (request.materialize !== false) {
      return this.tryMaterializeSession(created);
    }
    return created;
  }

  /**
   * Register a converted bundle inside the target agent's own native session storage
   * via the official target CLI so the conversation immediately appears in that agent
   * and can be continued there as well as inside CoVerse.
   */
  async materializeSession(sessionId: string): Promise<UiSession> {
    const inProgress = this.registrations.get(sessionId);
    if (inProgress) return inProgress;
    const registration = this.registerSession(sessionId).finally(() => this.registrations.delete(sessionId));
    this.registrations.set(sessionId, registration);
    return registration;
  }

  private async registerSession(sessionId: string): Promise<UiSession> {
    const session = await this.getSession(sessionId);
    if (!session.handoff) return session;
    if (session.handoff.desktopFirst || !session.bundlePending) return this.publishDesktopCopy(session);
    const registry = await this.ensureDriversConfigured();
    const driver = registry.get(session.agent);
    const bundleFiles = await this.store.loadBundleFiles(session.handoff.bundleId);
    const verified = verifyInjectionBundle(bundleFiles, driver.id);
    const root = this.store.bundlePath(session.handoff.bundleId);
    let location = "";
    let attachmentDirectory: string | undefined;
    if (verified.attachments.length > 0) {
      attachmentDirectory = path.join(root, "source");
      location = `\nAttachment paths are relative to the bundle directory ${JSON.stringify(root)}.\n`;
    }
    const seedPrompt =
      `The historical conversation context above was transferred from ${session.handoff.from} via CoVerse. ` +
      `Reply briefly confirming the context is loaded without running any tools or modifying any files; wait for the user's next instruction.`;
    const fullPrompt = `${verified.context}${location}\n## Current user request\n\n${seedPrompt}`;

    const resolvedCwd = await resolveExistingDirectory(session.cwd);
    if (!resolvedCwd) {
      throw new SessionError("INVALID_INPUT", "/cwd", `Workspace directory does not exist: ${session.cwd}`);
    }

    let acquiredSessionId: string | undefined;
    for await (const event of driver.run({
      prompt: fullPrompt,
      cwd: resolvedCwd,
      ...(session.model ? { model: session.model } : {}),
      ...(attachmentDirectory ? { attachmentDirectory } : {}),
    })) {
      if (event.type === "session") acquiredSessionId = event.id;
    }

    if (!acquiredSessionId) {
      throw new SessionError("DRIVER_FAILED", "/materialize", "Target agent did not return a session ID");
    }

    const registered = await this.store.mutateSession(sessionId, (current) => {
      const nextHandoff = current.handoff
        ? (() => {
            const copy: HandoffMetadata = { ...current.handoff, materialized: true };
            delete copy.materializationError;
            return copy;
          })()
        : undefined;
      return {
        ...current,
        targetSessionId: acquiredSessionId,
        bundlePending: false,
        ...(nextHandoff ? { handoff: nextHandoff } : {}),
        updatedAt: nowIso(),
      };
    });
    return this.publishDesktopCopy(registered);
  }

  private async publishDesktopCopy(session: UiSession): Promise<UiSession> {
    const publish = this.adapters.get(session.agent).publishDesktopSession;
    if (!publish || !session.handoff || (!session.targetSessionId && !session.handoff.desktopFirst) || session.handoff.desktopSessionId) return session;
    const bundleId = session.handoff.bundleId;
    let desktopSessionId: string | undefined;
    let error: SessionDiagnostic | undefined;
    try {
      desktopSessionId = await publish({ ...(session.targetSessionId ? {cliSessionId: session.targetSessionId} : {}), transferId: session.id,
        title: session.title, cwd: session.cwd, bundleDirectory: this.store.bundlePath(bundleId),
        loadArtifacts: () => this.store.loadBundleFiles(bundleId) });
    } catch (cause) {
      error = toDiagnostic(cause, "/desktop");
      if (error.code === session.handoff.desktopError?.code && error.message === session.handoff.desktopError.message) return session;
    }
    return this.store.mutateSession(session.id, current => {
      const handoff = { ...current.handoff! };
      if (desktopSessionId) handoff.desktopSessionId = desktopSessionId;
      if (error) handoff.desktopError = error;
      else delete handoff.desktopError;
      return { ...current, handoff };
    });
  }

  private async tryMaterializeSession(session: UiSession): Promise<UiSession> {
    if (!session.handoff || !session.bundlePending) return session;
    if (session.handoff.desktopFirst) return this.materializeSession(session.id);
    const registry = await this.ensureDriversConfigured();
    const driver = registry.get(session.agent);
    const probed = await driver.probe();
    if (!probed.available) return session;
    try {
      return await this.materializeSession(session.id);
    } catch (error) {
      const diagnostic = toDiagnostic(error, "/materialize");
      return this.store.mutateSession(session.id, (current) => ({
        ...current,
        ...(current.handoff
          ? {
              handoff: {
                ...current.handoff,
                materialized: false,
                materializationError: diagnostic,
              },
            }
          : {}),
        updatedAt: nowIso(),
      }));
    }
  }

  async handoffSession(
    sessionId: string,
    options: { to: string; model?: string; cwd?: string; title?: string; materialize?: boolean; omitOpaque?: boolean },
  ): Promise<UiSession> {
    const sourceSession = await this.getSession(sessionId);
    const settings = await this.store.getSettings();
    if (settings.disabledAdapters.includes(options.to)) {
      throw new SessionError("ADAPTER_DISABLED", `/adapters/${options.to}`, `Target adapter is disabled in settings: ${options.to}`);
    }
    const target = this.adapters.get(options.to);
    const registry = await this.ensureDriversConfigured();
    registry.get(target.id);

    const turns: Turn[] = [];
    let inheritedLedger = emptyLedger();
    const inheritedDiagnostics: SessionDiagnostic[] = [];
    let sourceArtifacts: FileSet = [];
    let loadedPriorTurns = false;
    let continuation: CSR["continuation"];
    let referenced: CSR | undefined;
    let priorTranscript: CSR["transcript"];

    if (sourceSession.reference && sourceSession.messages.every(m => m.historical)) {
      const files = await this.resolveInputFileSet({ paths: [sourceSession.reference.sourcePath] });
      const adapter = this.adapters.get(sourceSession.agent);
      const imported = await adapter.import(await this.prepareImport(adapter, files, [sourceSession.reference.sourcePath]));
      if (imported.session.meta.id !== (sourceSession.reference.sourceSessionId ?? sourceSession.targetSessionId)) {
        throw new SessionError("INVALID_INPUT", "/handoff", "The source file now belongs to a different conversation.");
      }
      referenced = imported.session;
      turns.push(...referenced.turns);
      sourceArtifacts = referenced.sourceArtifacts ?? files;
      continuation = referenced.continuation;
      inheritedLedger = imported.ledger;
      inheritedDiagnostics.push(...(imported.diagnostics ?? []));
      loadedPriorTurns = true;
    } else if (sourceSession.handoff) {
      try {
        const prevFiles = await this.store.loadBundleFiles(sourceSession.handoff.bundleId);
        const sessionBytes = prevFiles.find((f) => f.path === "session.json")?.bytes;
        if (sessionBytes) {
          const prevCsr = parseWireJson(new TextDecoder().decode(sessionBytes)) as unknown as CSR;
          if (Array.isArray(prevCsr.turns)) {
            for (const turn of prevCsr.turns) turns.push(turn);
            continuation = prevCsr.continuation;
            priorTranscript = prevCsr.transcript;
            loadedPriorTurns = true;
          }
        }
        sourceArtifacts = prevFiles
          .filter((f) => f.path.startsWith("source/"))
          .map((f) => ({ path: f.path.slice("source/".length), bytes: f.bytes }));
      } catch {
        inheritedDiagnostics.push({
          code: "PRIOR_BUNDLE_UNREADABLE",
          path: "/handoff",
          message: "Prior bundle could not be reloaded; continuing with recorded conversation messages",
          severity: "warning",
        });
      }
    }

    const messagesToAppend = loadedPriorTurns
      ? sourceSession.messages.filter((m) => !m.historical)
      : sourceSession.messages;

    for (const [index, message] of messagesToAppend.entries()) {
      const content: Turn["content"] = [];
      if (message.tools && message.tools.length > 0) {
        for (const [ti, tool] of message.tools.entries()) {
          const callId = `ui-tool-${index}-${ti}`;
          content.push({ type: "tool_call", id: callId, name: tool.name, arguments: {} });
          content.push({
            type: "tool_result",
            callId,
            content: tool.state,
            ...(tool.state.toLowerCase().includes("fail") || tool.state.toLowerCase().includes("error")
              ? { isError: true }
              : {}),
          });
        }
      }
      if (message.content) content.push({ type: "text", text: message.content });
      if (content.length > 0) {
        turns.push({
          id: `ui-${message.id}`,
          role: message.role,
          content,
          origin: { artifact: "coverse-desktop/sessions.json", record: index + 1, kind: "message" },
        });
      }
    }

    if (turns.length === 0) {
      throw new SessionError("INVALID_INPUT", `/sessions/${sessionId}`, "Cannot hand off an empty session");
    }

    const csr: CSR = referenced ?? {
      schemaVersion: "1.0",
      meta: {
        id: sourceSession.targetSessionId ?? sourceSession.id,
        agent: sourceSession.agent,
        agentFormatVersion: "coverse-desktop-1.0",
        cwd: sourceSession.cwd,
        ...(sourceSession.model ? { model: sourceSession.model } : {}),
        createdAt: sourceSession.createdAt,
      },
      turns,
      ...(priorTranscript ? {transcript: [...priorTranscript, ...messagesToAppend.map(m => ({
        id: m.id, role: m.role, text: m.content, createdAt: m.createdAt,
        ...(m.reasoning ? {activity: m.reasoning} : {}), ...(m.changedFiles ? {changedFiles: m.changedFiles} : {}),
      }))]} : {}),
      ...(continuation ? { continuation } : {}),
      xExtensions: {
        "x-coverse-desktop": {
          sourceUiSessionId: sourceSession.id,
          ...(sourceSession.targetSessionId ? { targetSessionId: sourceSession.targetSessionId } : {}),
        },
      },
      sourceArtifacts,
    };

    const exported = await target.export(csr, {
      ledger: inheritedLedger,
      diagnostics: inheritedDiagnostics,
      ...(options.omitOpaque !== false ? { lossPolicy: { omitOpaque: true } } : {}),
    });

    const sourceMessages = referenced?.transcript
      ? csrTurnsToChatMessages(referenced.turns, sourceSession.agent, sourceSession.createdAt, referenced.transcript)
      : sourceSession.messages;
    const carriedMessages: ChatMessage[] = sourceMessages.map((m) => ({
      ...m,
      id: makeId("hist"),
      historical: true,
    }));

    const created = await this.persistBundleAsSession({
      artifacts: exported.artifacts,
      target,
      from: sourceSession.agent,
      fromFormat: csr.meta.agentFormatVersion,
      sourceCwd: sourceSession.cwd,
      ...(options.cwd ? { requestedCwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      title: options.title?.trim() || sourceSession.title,
      sourceSessionId: sourceSession.id,
      initialMessages: carriedMessages,
      nativeTranscript: !!csr.transcript,
    });

    if (options.materialize !== false) {
      return this.tryMaterializeSession(created);
    }
    return created;
  }

  async getBundleDetail(bundleId: string): Promise<BundleDetailResponse> {
    const files = await this.store.loadBundleFiles(bundleId);
    const map = new Map(files.map((item) => [item.path, item.bytes]));
    const decodeText = (name: string) => {
      const bytes = map.get(name);
      if (!bytes) throw new SessionError("INVALID_BUNDLE", name, `Bundle missing ${name}`);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    };
    const manifest = JSON.parse(decodeText("manifest.json")) as Record<string, unknown>;
    const report = JSON.parse(decodeText("report.json")) as BundleDetailResponse["report"];
    const context = decodeText("context.md");
    const manifestFiles = Array.isArray(manifest.files) ? (manifest.files as BundleFileEntry[]) : [];
    return {
      bundleId,
      bundlePath: this.store.bundlePath(bundleId),
      manifest,
      report,
      context,
      files: manifestFiles,
    };
  }

  abortRun(sessionId: string): boolean {
    const controller = this.activeRuns.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  abortAll(): void {
    for (const controller of this.activeRuns.values()) {
      controller.abort();
    }
    this.activeRuns.clear();
  }

  async runTurn(
    sessionId: string,
    input: { prompt: string; model?: string; cwd?: string },
    emit: (event: StreamEventPayload) => void,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    const promptText = input.prompt.trim();
    if (!promptText) {
      throw new SessionError("INVALID_INPUT", "/prompt", "Prompt must not be empty");
    }
    if (this.activeRuns.has(sessionId)) {
      throw new SessionError("RUN_IN_PROGRESS", `/sessions/${sessionId}`, "A turn is already running in this session");
    }

    const session = await this.getSession(sessionId);
    const registry = await this.ensureDriversConfigured();
    const driver = registry.get(session.agent);

    const effectiveCwd = input.cwd?.trim() ? input.cwd.trim() : session.cwd;
    const resolvedCwd = await resolveExistingDirectory(effectiveCwd);
    if (!resolvedCwd) {
      throw new SessionError("INVALID_INPUT", "/cwd", `Workspace directory does not exist: ${effectiveCwd}`);
    }
    const effectiveModel = input.model !== undefined ? input.model.trim() || undefined : session.model;

    let promptToSend = promptText;
    let attachmentDirectory: string | undefined;
    let bundleNotice: { report: string; losses: LossCounts } | undefined;

    if (session.bundlePending && session.handoff) {
      const bundleFiles = await this.store.loadBundleFiles(session.handoff.bundleId);
      const verified = verifyInjectionBundle(bundleFiles, driver.id);
      const root = this.store.bundlePath(session.handoff.bundleId);
      let location = "";
      if (verified.attachments.length > 0) {
        attachmentDirectory = path.join(root, "source");
        location = `\nAttachment paths are relative to the bundle directory ${JSON.stringify(root)}.\n`;
      }
      promptToSend = `${verified.context}${location}\n## Current user request\n\n${promptText}`;
      bundleNotice = { report: path.join(root, "report.json"), losses: verified.losses };
    }

    const userMessage: ChatMessage = {
      id: makeId("msg"),
      role: "user",
      content: promptText,
      createdAt: nowIso(),
    };

    const liveMessagesCount = session.messages.filter((m) => !m.historical).length;
    const nextTitle =
      liveMessagesCount === 0 && (session.title === "New session" || !session.title)
        ? summarizeTitle(promptText, session.title)
        : session.title;

    await this.store.mutateSession(sessionId, (current) => {
      const updated: UiSession = {
        ...current,
        title: nextTitle,
        cwd: resolvedCwd,
        messages: [...current.messages, userMessage],
        updatedAt: nowIso(),
      };
      if (effectiveModel) updated.model = effectiveModel;
      else if (input.model !== undefined) delete updated.model;
      return updated;
    });

    const controller = new AbortController();
    this.activeRuns.set(sessionId, controller);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    let acquiredSessionId = session.targetSessionId;
    let textBuffer = "";
    const tools: ToolActivity[] = [];
    let latestUsage: ProtocolUsage | undefined;

    try {
      if (bundleNotice) {
        emit({ type: "bundle", report: bundleNotice.report, losses: bundleNotice.losses });
      }
      for await (const event of driver.run({
        prompt: promptToSend,
        cwd: resolvedCwd,
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(session.targetSessionId ? { session: session.targetSessionId } : {}),
        ...(attachmentDirectory ? { attachmentDirectory } : {}),
        signal: controller.signal,
      })) {
        if (event.type === "session") {
          acquiredSessionId = event.id;
          emit({ type: "session", id: event.id });
        } else if (event.type === "text") {
          textBuffer += event.text;
          emit({ type: "text", text: event.text });
        } else if (event.type === "tool") {
          tools.push({ name: event.name, state: event.state, timestamp: nowIso() });
          emit({ type: "tool", name: event.name, state: event.state });
        } else if (event.type === "usage") {
          latestUsage = event.usage;
          emit({ type: "usage", usage: event.usage });
        }
      }

      const assistantMessage: ChatMessage = {
        id: makeId("msg"),
        role: "assistant",
        content: textBuffer,
        createdAt: nowIso(),
        agent: session.agent,
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        ...(latestUsage ? { usage: latestUsage } : {}),
      };

      const saved = await this.store.mutateSession(sessionId, (current) => ({
        ...current,
        ...(acquiredSessionId ? { targetSessionId: acquiredSessionId } : {}),
        bundlePending: false,
        messages: [...current.messages, assistantMessage],
        updatedAt: nowIso(),
      }));
      emit({ type: "done", session: saved });
    } catch (error) {
      const diagnostic = toDiagnostic(error, "/run");
      const aborted = diagnostic.code === "CANCELLED";
      const assistantMessage: ChatMessage = {
        id: makeId("msg"),
        role: "assistant",
        content: textBuffer,
        createdAt: nowIso(),
        agent: session.agent,
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        ...(latestUsage ? { usage: latestUsage } : {}),
        error: diagnostic,
        ...(aborted ? { aborted: true } : {}),
      };
      const saved = await this.store.mutateSession(sessionId, (current) => ({
        ...current,
        ...(acquiredSessionId ? { targetSessionId: acquiredSessionId } : {}),
        messages: [...current.messages, assistantMessage],
        updatedAt: nowIso(),
      }));
      emit({
        type: "error",
        diagnostic,
        ...(acquiredSessionId ? { sessionId: acquiredSessionId } : {}),
        session: saved,
      });
    } finally {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      this.activeRuns.delete(sessionId);
    }
  }
}
