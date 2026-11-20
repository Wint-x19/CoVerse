import type {
  AppSettings,
  ConvertRequest,
  IpcEnvelope,
  PickedFile,
  RunMessageInput,
  StreamEventPayload,
  ThemeMode,
  UploadedFilePayload,
} from "../shared/types.js";
import { toDiagnostic, UiService } from "./service.js";

export interface IpcSenderLike {
  send(channel: string, payload: unknown): void;
  isDestroyed?(): boolean;
}

export interface IpcInvokeEventLike {
  sender: IpcSenderLike;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcInvokeEventLike, ...args: unknown[]) => Promise<unknown>): void;
}

export interface DesktopDialogs {
  pickDirectory(defaultPath?: string): Promise<string | null>;
  pickSessionFiles(): Promise<PickedFile[]>;
  pickExecutable?(defaultPath?: string): Promise<string | null>;
  setWindowTheme?(theme: ThemeMode): Promise<void>;
}

export const IPC_CHANNELS = {
  capabilities: "coverse:capabilities",
  getSettings: "coverse:settings:get",
  updateSettings: "coverse:settings:update",
  listLocalSessions: "coverse:sessions:local",
  listSessions: "coverse:sessions:list",
  getSession: "coverse:sessions:get",
  createSession: "coverse:sessions:create",
  updateSession: "coverse:sessions:update",
  deleteSession: "coverse:sessions:delete",
  inspectSource: "coverse:sessions:inspect",
  convertSource: "coverse:sessions:convert",
  handoffSession: "coverse:sessions:handoff",
  getBundle: "coverse:bundles:get",
  runStart: "coverse:run:start",
  runAbort: "coverse:run:abort",
  pickDirectory: "coverse:dialog:pick-directory",
  pickSessionFiles: "coverse:dialog:pick-session-files",
  pickExecutable: "coverse:dialog:pick-executable",
  setWindowTheme: "coverse:window:set-theme",
} as const;

export function runEventChannel(runId: string): string {
  return `coverse:run:event:${runId}`;
}

async function wrap<T>(path: string, fn: () => Promise<T>): Promise<IpcEnvelope<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: toDiagnostic(error, path) };
  }
}

export function registerIpcHandlers(
  ipc: IpcMainLike,
  service: UiService,
  dialogs: DesktopDialogs,
): void {
  ipc.handle(IPC_CHANNELS.capabilities, (_event, refresh) =>
    wrap("/capabilities", () => service.getCapabilities(Boolean(refresh))),
  );

  ipc.handle(IPC_CHANNELS.getSettings, () => wrap("/settings", () => service.getSettings()));

  ipc.handle(IPC_CHANNELS.updateSettings, (_event, patch) =>
    wrap("/settings", async () => {
      const updated = await service.updateSettings(patch as Partial<AppSettings>);
      if (patch && typeof patch === "object" && "theme" in patch && dialogs.setWindowTheme) {
        await dialogs.setWindowTheme(updated.theme);
      }
      return updated;
    }),
  );

  ipc.handle(IPC_CHANNELS.listLocalSessions, (_event, agent) =>
    wrap("/sessions/local", () =>
      service.listLocalSessions(typeof agent === "string" && agent ? agent : undefined),
    ),
  );

  ipc.handle(IPC_CHANNELS.listSessions, () => wrap("/sessions", () => service.listSessions()));

  ipc.handle(IPC_CHANNELS.getSession, (_event, id) =>
    wrap("/sessions/get", () => service.getSession(String(id))),
  );

  ipc.handle(IPC_CHANNELS.createSession, (_event, input) =>
    wrap("/sessions/create", () =>
      service.createSession(input as { agent: string; model?: string; cwd?: string; title?: string }),
    ),
  );

  ipc.handle(IPC_CHANNELS.updateSession, (_event, id, patch) =>
    wrap("/sessions/update", () =>
      service.updateSession(
        String(id),
        patch as { title?: string; model?: string | null; cwd?: string; agent?: string },
      ),
    ),
  );

  ipc.handle(IPC_CHANNELS.deleteSession, (_event, id) =>
    wrap("/sessions/delete", async () => {
      await service.deleteSession(String(id));
      return { deleted: true };
    }),
  );

  ipc.handle(IPC_CHANNELS.inspectSource, (_event, input) =>
    wrap("/sessions/inspect", () =>
      service.inspectSource(input as { paths?: string[]; files?: UploadedFilePayload[] }),
    ),
  );

  ipc.handle(IPC_CHANNELS.convertSource, (_event, input) =>
    wrap("/sessions/convert", () => service.convertSource(input as ConvertRequest)),
  );

  ipc.handle(IPC_CHANNELS.handoffSession, (_event, id, input) =>
    wrap("/sessions/handoff", () =>
      service.handoffSession(
        String(id),
        input as { to: string; model?: string; cwd?: string; title?: string },
      ),
    ),
  );

  ipc.handle(IPC_CHANNELS.getBundle, (_event, bundleId) =>
    wrap("/bundles/get", () => service.getBundleDetail(String(bundleId))),
  );

  ipc.handle(IPC_CHANNELS.runAbort, (_event, sessionId) =>
    wrap("/run/abort", async () => ({ aborted: service.abortRun(String(sessionId)) })),
  );

  ipc.handle(IPC_CHANNELS.runStart, async (event, runIdRaw, inputRaw) => {
    const runId = String(runIdRaw);
    const input = inputRaw as RunMessageInput;
    const channel = runEventChannel(runId);
    const emit = (payload: StreamEventPayload) => {
      if (!event.sender.isDestroyed?.()) {
        event.sender.send(channel, payload);
      }
    };
    return wrap("/run", async () => {
      await service.runTurn(
        input.sessionId,
        {
          prompt: input.prompt,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        },
        emit,
      );
      return { finished: true };
    });
  });

  ipc.handle(IPC_CHANNELS.pickDirectory, (_event, defaultPath) =>
    wrap("/dialog/directory", () =>
      dialogs.pickDirectory(typeof defaultPath === "string" && defaultPath ? defaultPath : undefined),
    ),
  );

  ipc.handle(IPC_CHANNELS.pickSessionFiles, () =>
    wrap("/dialog/files", () => dialogs.pickSessionFiles()),
  );

  ipc.handle(IPC_CHANNELS.pickExecutable, (_event, defaultPath) =>
    wrap("/dialog/executable", async () =>
      dialogs.pickExecutable
        ? dialogs.pickExecutable(typeof defaultPath === "string" && defaultPath ? defaultPath : undefined)
        : null,
    ),
  );

  ipc.handle(IPC_CHANNELS.setWindowTheme, (_event, theme) =>
    wrap("/window/theme", async () => {
      if (dialogs.setWindowTheme && (theme === "light" || theme === "dark")) {
        await dialogs.setWindowTheme(theme);
      }
      return { applied: true };
    }),
  );
}
