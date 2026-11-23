import type { SessionDiagnostic } from "@coverse/core";
import type {
  AppSettings,
  BundleDetailResponse,
  CapabilitiesResponse,
  ConvertRequest,
  CoverseDesktopBridge,
  InspectResponse,
  IpcEnvelope,
  LocalSessionRef,
  PickedFile,
  StreamEventPayload,
  ThemeMode,
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

async function unwrap<T>(
  fallbackPath: string,
  fn: (bridge: CoverseDesktopBridge) => Promise<IpcEnvelope<T>>,
): Promise<T> {
  let envelope: IpcEnvelope<T>;
  try {
    envelope = await fn(desktopBridge());
  } catch (error) {
    throw new ApiClientError({
      code: "IPC_ERROR",
      path: fallbackPath,
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
    });
  }
  if (!envelope.ok) {
    throw new ApiClientError(envelope.error);
  }
  return envelope.data;
}

export const api = {
  locateFile: (id:string) => unwrap("/file/locate",b => b.locateFile(id)),
  revealFile: (id:string,path:string,scope:import("../../shared/types.js").FileScope) => unwrap("/file/reveal",b => b.revealFile(id,path,scope)),
  previewFile: (id: string, path: string, scope: import("../../shared/types.js").FileScope) =>
    unwrap("/file/preview", (b) => b.previewFile(id, path, scope)),
  get platform(): string {
    return window.coverse?.platform ?? "win32";
  },

  capabilities: (refresh = false): Promise<CapabilitiesResponse> =>
    unwrap("/capabilities", (b) => b.capabilities(refresh)),

  getSettings: (): Promise<AppSettings> => unwrap("/settings", (b) => b.getSettings()),

  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    unwrap("/settings", (b) => b.updateSettings(patch)),

  listLocalSessions: (agent?: string, cachedOnly = false): Promise<LocalSessionRef[]> =>
    unwrap("/sessions/local", (b) => b.listLocalSessions(agent, cachedOnly)),

  listSessions: (): Promise<UiSession[]> => unwrap("/sessions", (b) => b.listSessions()),

  getSession: (id: string): Promise<UiSession> => unwrap(`/sessions/${id}`, (b) => b.getSession(id)),

  createSession: (input: { agent: string; model?: string; cwd?: string; title?: string }): Promise<UiSession> =>
    unwrap("/sessions/create", (b) => b.createSession(input)),

  updateSession: (
    id: string,
    patch: { title?: string; model?: string | null; cwd?: string; agent?: string },
  ): Promise<UiSession> => unwrap(`/sessions/${id}`, (b) => b.updateSession(id, patch)),

  deleteSession: async (id: string): Promise<void> => {
    await unwrap(`/sessions/${id}`, (b) => b.deleteSession(id));
  },

  inspectSource: (input: { paths?: string[]; files?: UploadedFilePayload[] }): Promise<InspectResponse> =>
    unwrap("/sessions/inspect", (b) => b.inspectSource(input)),

  convertSource: (input: ConvertRequest): Promise<UiSession> =>
    unwrap("/sessions/convert", (b) => b.convertSource(input)),

  handoffSession: (
    id: string,
    input: { to: string; model?: string; cwd?: string; title?: string; materialize?: boolean; omitOpaque?: boolean },
  ): Promise<UiSession> => unwrap(`/sessions/${id}/handoff`, (b) => b.handoffSession(id, input)),

  materializeSession: (id: string): Promise<UiSession> =>
    unwrap(`/sessions/${id}/materialize`, (b) => b.materializeSession(id)),

  getBundle: (bundleId: string): Promise<BundleDetailResponse> =>
    unwrap(`/bundles/${bundleId}`, (b) => b.getBundle(bundleId)),

  abortSession: (id: string): Promise<{ aborted: boolean }> =>
    unwrap(`/sessions/${id}/abort`, (b) => b.abortSession(id)),

  streamMessage: async (
    id: string,
    input: { prompt: string; model?: string; cwd?: string },
    onEvent: (event: StreamEventPayload) => void,
  ): Promise<void> => {
    await unwrap(`/sessions/${id}/messages`, (b) => b.streamMessage(id, input, onEvent));
  },

  pickDirectory: (defaultPath?: string): Promise<string | null> =>
    unwrap("/dialog/directory", (b) => b.pickDirectory(defaultPath)),

  pickSessionFiles: (): Promise<PickedFile[]> => unwrap("/dialog/files", (b) => b.pickSessionFiles()),

  pickExecutable: (defaultPath?: string): Promise<string | null> =>
    unwrap("/dialog/executable", (b) => b.pickExecutable(defaultPath)),

  setWindowTheme: async (theme: ThemeMode): Promise<void> => {
    await unwrap("/window/theme", (b) => b.setWindowTheme(theme));
  },

  getPathForFile: (file: File): string => {
    try {
      return desktopBridge().getPathForFile(file);
    } catch {
      return "";
    }
  },
};
