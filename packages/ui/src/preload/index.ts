import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { SessionDiagnostic } from "@coverse/core";
import type {
  BundleDetailResponse,
  CapabilitiesResponse,
  ConvertRequest,
  CoverseDesktopBridge,
  IpcEnvelope,
  PickedFile,
  StreamEventPayload,
  UiSession,
  UploadedFilePayload,
} from "../shared/types.js";
import { IPC_CHANNELS, runEventChannel } from "../main/ipc.js";

class DesktopIpcError extends Error {
  constructor(readonly diagnostic: SessionDiagnostic) {
    super(diagnostic.message);
    this.name = "DesktopIpcError";
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const envelope = (await ipcRenderer.invoke(channel, ...args)) as IpcEnvelope<T>;
  if (!envelope || typeof envelope !== "object" || !("ok" in envelope)) {
    throw new DesktopIpcError({
      code: "IPC_ERROR",
      path: channel,
      message: "Invalid IPC response from desktop main process",
      severity: "error",
    });
  }
  if (!envelope.ok) {
    throw new DesktopIpcError(envelope.error);
  }
  return envelope.data;
}

let runCounter = 0;

const bridge: CoverseDesktopBridge = {
  platform: process.platform,

  capabilities: () => invoke<CapabilitiesResponse>(IPC_CHANNELS.capabilities),

  listSessions: () => invoke<UiSession[]>(IPC_CHANNELS.listSessions),

  getSession: (id) => invoke<UiSession>(IPC_CHANNELS.getSession, id),

  createSession: (input) => invoke<UiSession>(IPC_CHANNELS.createSession, input),

  updateSession: (id, patch) => invoke<UiSession>(IPC_CHANNELS.updateSession, id, patch),

  deleteSession: async (id) => {
    await invoke<{ deleted: boolean }>(IPC_CHANNELS.deleteSession, id);
  },

  inspectSource: (input: { paths?: string[]; files?: UploadedFilePayload[] }) =>
    invoke(IPC_CHANNELS.inspectSource, input),

  convertSource: (input: ConvertRequest) => invoke<UiSession>(IPC_CHANNELS.convertSource, input),

  handoffSession: (id, input) => invoke<UiSession>(IPC_CHANNELS.handoffSession, id, input),

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
      await invoke<{ finished: boolean }>(IPC_CHANNELS.runStart, runId, {
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

  getPathForFile: (file: File) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld("coverse", bridge);
