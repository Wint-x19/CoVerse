import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AdapterRegistry,
  AdapterUnavailableError,
  convertSession,
  emptyLedger,
  isRecord,
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
import type { DriverRegistry } from "@coverse/drivers";
import type {
  BundleDetailResponse,
  BundleFileEntry,
  BundleStatistics,
  CapabilitiesResponse,
  ChatMessage,
  ConvertRequest,
  HandoffMetadata,
  InspectCandidate,
  InspectPreview,
  InspectResponse,
  LossCounts,
  StreamEventPayload,
  ToolActivity,
  UiSession,
  UploadedFilePayload,
} from "../shared/types.js";
import { UiStore } from "./store.js";

function nowIso(): string {
  return new Date().toISOString();
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
      if (process.platform !== "win32" && /^\/[a-z]:\//i.test(url.pathname)) return undefined;
      value = fileURLToPath(url);
    } catch {
      return undefined;
    }
  }
  return value;
}

async function resolveExistingDirectory(candidate: string | undefined): Promise<string | undefined> {
  const normalized = normalizePathValue(candidate);
  if (!normalized) return undefined;
  try {
    const info = await fs.stat(normalized);
    if (info.isDirectory()) return await fs.realpath(normalized);
  } catch {
    return undefined;
  }
  return undefined;
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

export function toDiagnostic(error: unknown, fallbackPath = "/api"): SessionDiagnostic {
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

  constructor(
    readonly adapters: AdapterRegistry,
    readonly drivers: DriverRegistry,
    readonly store: UiStore,
    readonly defaultCwd: string,
  ) {}

  async getCapabilities(): Promise<CapabilitiesResponse> {
    const adapters = this.adapters.list().map((adapter) => ({
      id: adapter.id,
      displayName: adapter.displayName,
      status: adapter.status,
      supportedVersions: adapter.supportedVersions,
      capabilities: adapter.capabilities,
    }));
    const drivers = await Promise.all(this.drivers.list().map((driver) => driver.probe()));
    return { adapters, drivers, defaultCwd: this.defaultCwd };
  }

  listSessions(): Promise<UiSession[]> {
    return this.store.listSessions();
  }

  async getSession(id: string): Promise<UiSession> {
    const session = await this.store.getSession(id);
    if (!session) throw new SessionError("NOT_FOUND", `/sessions/${id}`, `Session not found: ${id}`);
    return session;
  }

  async createSession(input: {
    agent: string;
    model?: string;
    cwd?: string;
    title?: string;
  }): Promise<UiSession> {
    this.drivers.get(input.agent);
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
      this.drivers.get(patch.agent);
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

  async inspectFiles(uploads: readonly UploadedFilePayload[]): Promise<InspectResponse> {
    const files = decodeUploadedFiles(uploads);
    const importable = this.adapters.list().filter((adapter) => adapter.capabilities.import);
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
        const imported = await detected.import(files);
        const resolvedLocalCwd = await resolveExistingDirectory(imported.session.meta.cwd);
        preview = {
          agent: imported.session.meta.agent,
          agentFormatVersion: imported.session.meta.agentFormatVersion,
          turns: imported.session.turns.length,
          ...(resolvedLocalCwd ? { cwd: resolvedLocalCwd } : {}),
          ...(imported.session.meta.cwd ? { sourceCwd: imported.session.meta.cwd } : {}),
          ...(imported.session.meta.model ? { model: imported.session.meta.model } : {}),
          ...(imported.session.meta.createdAt ? { createdAt: imported.session.meta.createdAt } : {}),
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

  private async detectSourceAdapter(files: FileSet): Promise<SessionAdapter> {
    const candidates = await Promise.all(
      this.adapters
        .list()
        .filter((adapter) => adapter.capabilities.import)
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
  }): Promise<UiSession> {
    verifyInjectionBundle(input.artifacts, input.target.id);
    const bundleId = makeId("bnd");
    const bundlePath = await this.store.saveBundle(bundleId, input.artifacts);

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
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.store.upsertSession(session);
  }

  async convertFiles(request: ConvertRequest): Promise<UiSession> {
    const files = decodeUploadedFiles(request.files);
    const target = this.adapters.get(request.to);
    this.drivers.get(target.id);
    const source = request.from === "auto" ? await this.detectSourceAdapter(files) : this.adapters.get(request.from);
    const result = await convertSession({ source, target, artifacts: files });
    const firstUserText = result.session.turns
      .find((turn) => turn.role === "user")
      ?.content.find((block) => block.type === "text");
    const defaultTitle =
      firstUserText && firstUserText.type === "text"
        ? summarizeTitle(firstUserText.text, `${source.id} → ${target.id}`)
        : `${source.id} → ${target.id}`;
    return this.persistBundleAsSession({
      artifacts: result.artifacts,
      target,
      from: source.id,
      fromFormat: result.session.meta.agentFormatVersion,
      ...(result.session.meta.cwd ? { sourceCwd: result.session.meta.cwd } : {}),
      ...(request.cwd ? { requestedCwd: request.cwd } : {}),
      ...(request.model ? { model: request.model } : {}),
      title: request.title?.trim() || defaultTitle,
    });
  }

  async handoffSession(
    sessionId: string,
    options: { to: string; model?: string; cwd?: string; title?: string },
  ): Promise<UiSession> {
    const sourceSession = await this.getSession(sessionId);
    const target = this.adapters.get(options.to);
    this.drivers.get(target.id);

    const turns: Turn[] = [];
    const inheritedLedger = emptyLedger();
    const inheritedDiagnostics: SessionDiagnostic[] = [];
    let sourceArtifacts: FileSet = [];

    if (sourceSession.handoff) {
      try {
        const prevFiles = await this.store.loadBundleFiles(sourceSession.handoff.bundleId);
        const sessionBytes = prevFiles.find((f) => f.path === "session.json")?.bytes;
        if (sessionBytes) {
          const prevCsr = JSON.parse(new TextDecoder().decode(sessionBytes)) as CSR;
          if (Array.isArray(prevCsr.turns)) {
            for (const turn of prevCsr.turns) {
              turns.push(turn);
            }
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

    for (const [index, message] of sourceSession.messages.entries()) {
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
      if (message.content) {
        content.push({ type: "text", text: message.content });
      }
      if (content.length > 0) {
        turns.push({
          id: `ui-${message.id}`,
          role: message.role,
          content,
          origin: { artifact: "coverse-ui/sessions.json", record: index + 1, kind: "message" },
        });
      }
    }

    if (turns.length === 0) {
      throw new SessionError("INVALID_INPUT", `/sessions/${sessionId}`, "Cannot hand off an empty session");
    }

    const csr: CSR = {
      schemaVersion: "1.0",
      meta: {
        id: sourceSession.targetSessionId ?? sourceSession.id,
        agent: sourceSession.agent,
        agentFormatVersion: "coverse-ui-1.0",
        cwd: sourceSession.cwd,
        ...(sourceSession.model ? { model: sourceSession.model } : {}),
        createdAt: sourceSession.createdAt,
      },
      turns,
      xExtensions: {
        "x-coverse-ui": {
          sourceUiSessionId: sourceSession.id,
          ...(sourceSession.targetSessionId ? { targetSessionId: sourceSession.targetSessionId } : {}),
        },
      },
      sourceArtifacts,
    };

    const exported = await target.export(csr, {
      ledger: inheritedLedger,
      diagnostics: inheritedDiagnostics,
    });

    return this.persistBundleAsSession({
      artifacts: exported.artifacts,
      target,
      from: sourceSession.agent,
      fromFormat: "coverse-ui-1.0",
      sourceCwd: sourceSession.cwd,
      ...(options.cwd ? { requestedCwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      title: options.title?.trim() || sourceSession.title,
      sourceSessionId: sourceSession.id,
    });
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
    const driver = this.drivers.get(session.agent);

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

    const nextTitle =
      session.messages.length === 0 && (session.title === "New session" || !session.title)
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

      const saved = await this.store.mutateSession(sessionId, (current) => {
        const updated: UiSession = {
          ...current,
          ...(acquiredSessionId ? { targetSessionId: acquiredSessionId } : {}),
          bundlePending: false,
          messages: [...current.messages, assistantMessage],
          updatedAt: nowIso(),
        };
        return updated;
      });
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

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value as never);
}
