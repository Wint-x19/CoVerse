import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppSettings,
  BundleDetailResponse,
  CapabilitiesResponse,
  ConvertRequest,
  CoverseDesktopBridge,
  IpcEnvelope,
  LocalSessionRef,
  PickedFile,
  StreamEventPayload,
  ThemeMode,
  UiSession,
  UploadedFilePayload,
} from "../shared/types.js";
import { IPC_CHANNELS, runEventChannel } from "../main/ipc.js";

/**
 * Return structured IpcEnvelope directly across contextBridge so Electron never
 * strips SessionDiagnostic fields when cloning Error instances between worlds.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcEnvelope<T>> {
  try {
    const envelope = (await ipcRenderer.invoke(channel, ...args)) as IpcEnvelope<T>;
    if (!envelope || typeof envelope !== "object" || !("ok" in envelope)) {
      return {
        ok: false,
        error: {
          code: "IPC_ERROR",
          path: channel,
          message: "Invalid IPC response from desktop main process",
          severity: "error",
        },
      };
    }
    return envelope;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "IPC_ERROR",
        path: channel,
        message: error instanceof Error ? error.message : String(error),
        severity: "error",
      },
    };
  }
}

let runCounter = 0;

const bridge: CoverseDesktopBridge = {
  platform: process.platform,

  capabilities: (refresh) => invoke<CapabilitiesResponse>(IPC_CHANNELS.capabilities, Boolean(refresh)),

  getSettings: () => invoke<AppSettings>(IPC_CHANNELS.getSettings),

  updateSettings: (patch) => invoke<AppSettings>(IPC_CHANNELS.updateSettings, patch),

  listLocalSessions: (agent, cachedOnly) => invoke<LocalSessionRef[]>(IPC_CHANNELS.listLocalSessions, agent, cachedOnly),

  listSessions: () => invoke<UiSession[]>(IPC_CHANNELS.listSessions),

  getSession: (id) => invoke<UiSession>(IPC_CHANNELS.getSession, id),

  createSession: (input) => invoke<UiSession>(IPC_CHANNELS.createSession, input),

  updateSession: (id, patch) => invoke<UiSession>(IPC_CHANNELS.updateSession, id, patch),

  deleteSession: (id) => invoke<{ deleted: boolean }>(IPC_CHANNELS.deleteSession, id),

  inspectSource: (input: { paths?: string[]; files?: UploadedFilePayload[] }) =>
    invoke(IPC_CHANNELS.inspectSource, input),

  convertSource: (input: ConvertRequest) => invoke<UiSession>(IPC_CHANNELS.convertSource, input),

  handoffSession: (id, input) => invoke<UiSession>(IPC_CHANNELS.handoffSession, id, input),

  materializeSession: (id) => invoke<UiSession>(IPC_CHANNELS.materializeSession, id),

  getBundle: (bundleId) => invoke<BundleDetailResponse>(IPC_CHANNELS.getBundle, bundleId),

  abortSession: (id) => invoke<{ aborted: boolean }>(IPC_CHANNELS.runAbort, id),

  async streamMessage(id, input, onEvent) {
    const runId = `run_${Date.now()}_${++runCounter}`;
    const channel = runEventChannel(runId);
    const listener = (_event: Electron.IpcRendererEvent, payload: StreamEventPayload) => {
      onEvent(payload);
    };
    ipcRenderer.on(channel, listener);
    try {
      return await invoke<{ finished: boolean }>(IPC_CHANNELS.runStart, runId, {
        sessionId: id,
        prompt: input.prompt,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      });
    } finally {
      ipcRenderer.removeListener(channel, listener);
    }
  },

  pickDirectory: (defaultPath) => invoke<string | null>(IPC_CHANNELS.pickDirectory, defaultPath),

  pickSessionFiles: () => invoke<PickedFile[]>(IPC_CHANNELS.pickSessionFiles),

  pickExecutable: (defaultPath) => invoke<string | null>(IPC_CHANNELS.pickExecutable, defaultPath),

  setWindowTheme: (theme: ThemeMode) => invoke<{ applied: boolean }>(IPC_CHANNELS.setWindowTheme, theme),

  getPathForFile: (file: File) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld("coverse", bridge);
