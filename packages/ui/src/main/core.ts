import { AdapterRegistry } from "@coverse/core";
import codex from "@coverse/adapter-codex";
import claudeCode from "@coverse/adapter-claude-code";
import antigravity from "@coverse/adapter-antigravity";

export * from "../shared/types.js";
export { UiStore, DEFAULT_SETTINGS } from "./store.js";
export {
  UiService,
  csrTurnsToChatMessages,
  decodeUploadedFiles,
  loadPathsAsFileSet,
  toDiagnostic,
} from "./service.js";
export {
  IPC_CHANNELS,
  registerIpcHandlers,
  runEventChannel,
  type DesktopDialogs,
  type IpcInvokeEventLike,
  type IpcMainLike,
  type IpcSenderLike,
} from "./ipc.js";

/** Composition root for desktop main process; core remains vendor-free. */
export function createAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(codex).register(claudeCode).register(antigravity);
}
