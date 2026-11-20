import type { SessionDiagnostic } from "@coverse/core";
import type {
  BundleDetailResponse,
  CapabilitiesResponse,
  ConvertRequest,
  CoverseDesktopBridge,
  InspectResponse,
  PickedFile,
  StreamEventPayload,
  UiSession,
  UploadedFilePayload,
} from "../../shared/types.js";

export class ApiClientError extends Error {
  constructor(readonly diagnostic: SessionDiagnostic) {
    super(diagnostic.message);
    this.name = "ApiClientError";
  }
}

function desktopBridge(): CoverseDesktopBridge {
  if (!window.coverse) {
    throw new ApiClientError({
      code: "DESKTOP_BRIDGE_UNAVAILABLE",
      path: "/bridge",
      message: "CoVerse must run inside the desktop application",
      severity: "error",
    });
  }
  return window.coverse;
}

function normalizeError(error: unknown, fallbackPath: string): ApiClientError {
  if (error instanceof ApiClientError) return error;
  if (error && typeof error === "object" && "diagnostic" in error) {
    const diagnostic = (error as { diagnostic: SessionDiagnostic }).diagnostic;
    if (diagnostic && typeof diagnostic.code === "string" && typeof diagnostic.message === "string") {
      return new ApiClientError(diagnostic);
    }
  }
  return new ApiClientError({
    code: "IPC_ERROR",
    path: fallbackPath,
    message: error instanceof Error ? error.message : String(error),
    severity: "error",
  });
}

async function call<T>(path: string, fn: (bridge: CoverseDesktopBridge) => Promise<T>): Promise<T> {
  try {
    return await fn(desktopBridge());
  } catch (error) {
    throw normalizeError(error, path);
  }
}

export const api = {
  get platform(): string {
    return window.coverse?.platform ?? "win32";
  },

  capabilities: (): Promise<CapabilitiesResponse> =>
    call("/capabilities", (b) => b.capabilities()),

  listSessions: (): Promise<UiSession[]> =>
    call("/sessions", (b) => b.listSessions()),

  getSession: (id: string): Promise<UiSession> =>
    call(`/sessions/${id}`, (b) => b.getSession(id)),

  createSession: (input: { agent: string; model?: string; cwd?: string; title?: string }): Promise<UiSession> =>
    call("/sessions/create", (b) => b.createSession(input)),

  updateSession: (
    id: string,
    patch: { title?: string; model?: string | null; cwd?: string; agent?: string },
  ): Promise<UiSession> =>
    call(`/sessions/${id}`, (b) => b.updateSession(id, patch)),

  deleteSession: (id: string): Promise<void> =>
    call(`/sessions/${id}`, (b) => b.deleteSession(id)),

  inspectSource: (input: { paths?: string[]; files?: UploadedFilePayload[] }): Promise<InspectResponse> =>
    call("/sessions/inspect", (b) => b.inspectSource(input)),

  convertSource: (input: ConvertRequest): Promise<UiSession> =>
    call("/sessions/convert", (b) => b.convertSource(input)),

  handoffSession: (
    id: string,
    input: { to: string; model?: string; cwd?: string; title?: string },
  ): Promise<UiSession> =>
    call(`/sessions/${id}/handoff`, (b) => b.handoffSession(id, input)),

  getBundle: (bundleId: string): Promise<BundleDetailResponse> =>
    call(`/bundles/${bundleId}`, (b) => b.getBundle(bundleId)),

  abortSession: (id: string): Promise<{ aborted: boolean }> =>
    call(`/sessions/${id}/abort`, (b) => b.abortSession(id)),

  streamMessage: (
    id: string,
    input: { prompt: string; model?: string; cwd?: string },
    onEvent: (event: StreamEventPayload) => void,
  ): Promise<void> =>
    call(`/sessions/${id}/messages`, (b) => b.streamMessage(id, input, onEvent)),

  pickDirectory: (defaultPath?: string): Promise<string | null> =>
    call("/dialog/directory", (b) => b.pickDirectory(defaultPath)),

  pickSessionFiles: (): Promise<PickedFile[]> =>
    call("/dialog/files", (b) => b.pickSessionFiles()),

  getPathForFile: (file: File): string => {
    try {
      return desktopBridge().getPathForFile(file);
    } catch {
      return "";
    }
  },
};
